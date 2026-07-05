// Server-side inference client: a full marketplace user (like Basecamp's
// inference-core) running inside the Next.js process, because browsers can't
// reach the TCP-only waku fleet. It keeps a verified provider roster from the
// discovery topic and runs the sealed prompt→response lifecycle. The browser
// talks to it over the /api routes.
import { createLightNode, createEncoder, createDecoder, type LightNode } from "@waku/sdk";
import { createRoutingInfo } from "@waku/utils";
import { tcp } from "@libp2p/tcp";
import {
  seal, openWith, genEphemeral, verify, fingerprintOf, computePow, b64, unb64,
} from "./crypto";

const NETWORK = { clusterId: 2, numShardsInCluster: 8 } as const;
const DISCOVERY = "/inference/1/discovery/json";
const BOOTSTRAP = [
  "/ip4/140.238.98.4/tcp/60010/p2p/16Uiu2HAmNTTQeMLjTQwPg2cYc8xPaUnu5hjSfNy8CKFtDLyNe9uq",
  "/dns4/delivery-01.do-ams3.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAmTUbnxLGT9JvV6mu9oPyDjqHK4Phs1VDJNUgESgNSkuby",
  "/dns4/delivery-01.ac-cn-hongkong-c.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAm8YokiNun9BkeA1ZRmhLbtNUvcwRr64F69tYj9fkGyuEP",
];
const LIVE_MS = 90_000;
const TIMEOUT_MS = 90_000;
const POW_MAX_BITS = 22;   // above this, don't grind
const enc = new TextEncoder(), dec = new TextDecoder();

interface Provider {
  id: string; signPk: Uint8Array; boxPk: Uint8Array;
  models: string[]; load: number; cap: number;
  priceAmount: number; priceUnit: string; access: string; powBits: number;
  lastSeenMs: number;
}
interface Pending {
  id: string; providerId: string; replySk: Uint8Array; signPk: Uint8Array;
  model?: string; sentMs: number;
  status: "pending" | "done" | "failed";
  text?: string; answeredModel?: string; rttMs?: number; error?: string;
}

interface State {
  node: LightNode | null;
  starting: Promise<void> | null;
  error: string | null;
  providers: Map<string, Provider>;
  pending: Map<string, Pending>;
  sessionSubs: Set<string>;
}
const g = globalThis as typeof globalThis & { __inf?: State };
const S: State = (g.__inf ??= {
  node: null, starting: null, error: null,
  providers: new Map(), pending: new Map(), sessionSubs: new Set(),
});

const riCache = new Map<string, ReturnType<typeof createRoutingInfo>>();
function routing(topic: string) {
  let ri = riCache.get(topic);
  if (!ri) { ri = createRoutingInfo(NETWORK, { contentTopic: topic }); riCache.set(topic, ri); }
  return ri;
}

function verifyAnnounce(o: Record<string, unknown>): Provider | null {
  if (o.type !== "announce" || Number(o.v ?? 0) < 3) return null;
  const signPk = unb64(String(o.signPk ?? ""));
  const boxPk = unb64(String(o.boxPk ?? ""));
  if (signPk.length !== 32 || boxPk.length !== 32) return null;
  if (fingerprintOf(signPk) !== o.id) return null;
  const price = (o.price ?? {}) as Record<string, unknown>;
  const models = Array.isArray(o.models) ? (o.models as string[]) : [];
  const canon = ["inference/v1/announce3", o.id, o.signPk, o.boxPk, models.join(","),
    String(o.load ?? 0), String(o.cap ?? 0), JSON.stringify(price), String(o.ts ?? 0)].join("|");
  if (!verify(enc.encode(canon), unb64(String(o.sig ?? "")), signPk)) return null;
  const ts = Number(o.ts ?? 0);
  if (Math.abs(Date.now() - ts) > 60_000) return null;   // freshness (same ±60s as C++)
  return {
    id: String(o.id), signPk, boxPk, models,
    load: Number(o.load ?? 0), cap: Number(o.cap ?? 0),
    priceAmount: Number(price.amount ?? 0), priceUnit: String(price.unit ?? "request"),
    access: String(price.access ?? "open"), powBits: Number(price.powbits ?? 0),
    lastSeenMs: Date.now(),
  };
}

function onDiscovery(payload: Uint8Array) {
  let o: Record<string, unknown>;
  try { o = JSON.parse(dec.decode(payload)); } catch { return; }
  const p = verifyAnnounce(o);
  if (p) S.providers.set(p.id, p);
}

function onSession(payload: Uint8Array) {
  let o: Record<string, unknown>;
  try { o = JSON.parse(dec.decode(payload)); } catch { return; }
  if (o.type !== "response") return;
  const pend = S.pending.get(String(o.id));
  if (!pend || pend.status !== "pending") return;
  const opened = openWith(pend.replySk, unb64(String(o.box ?? "")));
  if (!opened) return;
  // The box already proves origin (they needed our reply key); the signature
  // is the explicit second check against the provider we asked.
  const canon = enc.encode(`inference/v1/response|${o.id}|${o.box}`);
  if (!verify(canon, unb64(String(o.sig ?? "")), pend.signPk)) return;
  let inner: Record<string, unknown>;
  try { inner = JSON.parse(dec.decode(opened)); } catch { return; }
  pend.status = "done";
  pend.text = String(inner.text ?? "");
  pend.answeredModel = String(inner.model ?? "");
  pend.rttMs = Date.now() - pend.sentMs;
}

async function subscribeSession(topic: string) {
  if (!S.node || S.sessionSubs.has(topic)) return;
  await S.node.filter.subscribe([createDecoder(topic, routing(topic))], (m) => {
    if (m.payload) onSession(m.payload);
  });
  S.sessionSubs.add(topic);
}

async function start(): Promise<void> {
  const node = await createLightNode({
    networkConfig: NETWORK, defaultBootstrap: false, bootstrapPeers: BOOTSTRAP,
    libp2p: { transports: [tcp()] },
  });
  await node.start();
  S.node = node;
  for (const a of BOOTSTRAP) { try { await node.dial(a); } catch {} }
  await node.filter.subscribe([createDecoder(DISCOVERY, routing(DISCOVERY))], (m) => {
    if (m.payload) onDiscovery(m.payload);
  });
  try {
    await node.store.queryWithOrderedCallback([createDecoder(DISCOVERY, routing(DISCOVERY))],
      (m) => { if (m.payload) onDiscovery(m.payload); },
      { timeStart: new Date(Date.now() - 300_000) });
  } catch {}
}

export function ensureStarted() {
  if (!S.starting) S.starting = start().catch((e) => { S.error = String(e?.message ?? e); S.starting = null; });
}

// Heal a stranded static-bootstrap node (same reason as the metrics dashboard).
const gt = globalThis as typeof globalThis & { __infReconnect?: boolean };
if (!gt.__infReconnect) {
  gt.__infReconnect = true;
  setInterval(async () => {
    const node = S.node;
    if (!node || node.libp2p.getPeers().length > 0) return;
    for (const a of BOOTSTRAP) { try { await node.dial(a); } catch {} }
    if (node.libp2p.getPeers().length > 0) {
      try { node.filter.unsubscribeAll(); } catch {}
      S.sessionSubs.clear();
      try { await node.filter.subscribe([createDecoder(DISCOVERY, routing(DISCOVERY))], (m) => { if (m.payload) onDiscovery(m.payload); }); } catch {}
    }
  }, 30_000).unref();
}

function liveProviders(): Provider[] {
  const now = Date.now();
  return [...S.providers.values()].filter((p) => now - p.lastSeenMs < LIVE_MS);
}

// Auto-pick: live, serves the model, payable (free — no LEZ yet), pow within
// reach; cheapest then least-loaded then first. (No local reputation here —
// the web client is stateless per request; that lives in the Basecamp client.)
function pick(model: string | undefined, providerId: string | undefined): Provider | null {
  const live = liveProviders();
  if (providerId) return live.find((p) => p.id === providerId) ?? null;
  const ok = live.filter((p) =>
    (!model || p.models.includes(model)) &&
    p.priceAmount === 0 &&
    !(p.access === "pow" && p.powBits > POW_MAX_BITS));
  if (!ok.length) return null;
  ok.sort((a, b) => a.priceAmount - b.priceAmount || a.load - b.load);
  return ok[0];
}

export function getProviders() {
  const now = Date.now();
  return [...S.providers.values()].map((p) => ({
    id: p.id, models: p.models, load: p.load, cap: p.cap,
    priceAmount: p.priceAmount, priceUnit: p.priceUnit,
    access: p.access, powBits: p.powBits,
    live: now - p.lastSeenMs < LIVE_MS, ageMs: now - p.lastSeenMs,
  })).sort((a, b) => a.ageMs - b.ageMs);
}

export async function submitPrompt(text: string, model?: string, providerId?: string): Promise<{ id?: string; error?: string }> {
  ensureStarted();
  if (!S.node) return { error: "waku node not ready — try again in a moment" };
  const prov = pick(model, providerId);
  if (!prov) return { error: model ? `no free live provider serves ${model}` : "no free live provider available" };

  const id = crypto.randomUUID();
  const reply = genEphemeral();
  const inner: Record<string, unknown> = { prompt: text, replyPk: b64(reply.pk) };
  if (model && prov.models.includes(model)) inner.model = model;
  if (prov.access === "pow") {
    const nonce = computePow(id, prov.id, prov.powBits || 18);
    if (!nonce) return { error: "could not compute proof-of-work" };
    inner.cred = { type: "pow", nonce };
  }
  const sealed = seal(prov.boxPk, enc.encode(JSON.stringify(inner)));
  const outer = { type: "prompt", id, v: 2, to: prov.id, box: b64(sealed) };

  const sessionTopic = `/inference/1/p-${prov.id}/json`;
  await subscribeSession(sessionTopic);

  S.pending.set(id, {
    id, providerId: prov.id, replySk: reply.sk, signPk: prov.signPk,
    model: inner.model as string | undefined, sentMs: Date.now(), status: "pending",
  });
  try {
    await S.node.lightPush.send(createEncoder({ contentTopic: sessionTopic, routingInfo: routing(sessionTopic) }),
      { payload: enc.encode(JSON.stringify(outer)) });
  } catch (e) {
    const p = S.pending.get(id); if (p) { p.status = "failed"; p.error = String(e); }
    return { error: "send failed: " + String(e) };
  }
  return { id };
}

export function getResult(id: string) {
  const p = S.pending.get(id);
  if (!p) return { status: "unknown" as const };
  if (p.status === "pending" && Date.now() - p.sentMs > TIMEOUT_MS) {
    p.status = "failed"; p.error = "no response within 90s";
  }
  return {
    status: p.status, text: p.text, model: p.answeredModel,
    provider: p.providerId, rttMs: p.rttMs, error: p.error,
  };
}
