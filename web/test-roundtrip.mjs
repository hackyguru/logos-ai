// Standalone crypto+wire validation: seal a prompt in JS, send it to the real
// C++ VPS provider (pow-gated), and open its sealed response. Proves the JS
// port of InferenceIdentity is byte-compatible before building the app.
import { createLightNode, createEncoder, createDecoder } from "@waku/sdk";
import { createRoutingInfo } from "@waku/utils";
import { tcp } from "@libp2p/tcp";
import {
  seal, openWith, genEphemeral, verify, fingerprintOf, computePow, b64, unb64,
} from "./lib/crypto.ts";

const NETWORK = { clusterId: 2, numShardsInCluster: 8 };
const DISCOVERY = "/inference/1/discovery/json";
const BOOT = [
  "/ip4/140.238.98.4/tcp/60010/p2p/16Uiu2HAmNTTQeMLjTQwPg2cYc8xPaUnu5hjSfNy8CKFtDLyNe9uq",
  "/dns4/delivery-01.do-ams3.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAmTUbnxLGT9JvV6mu9oPyDjqHK4Phs1VDJNUgESgNSkuby",
];
const enc = new TextEncoder(), dec = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const node = await createLightNode({
  networkConfig: NETWORK, defaultBootstrap: false, bootstrapPeers: BOOT,
  libp2p: { transports: [tcp()] },
});
await node.start();
for (const a of BOOT) { try { await node.dial(a); } catch {} }
await sleep(1500);
console.log("peers:", node.libp2p.getPeers().length);

// 1) discover the VPS provider from a signed announce
const discInfo = createRoutingInfo(NETWORK, { contentTopic: DISCOVERY });
let provider = null;
await node.filter.subscribe([createDecoder(DISCOVERY, discInfo)], (msg) => {
  if (!msg.payload) return;
  const o = JSON.parse(dec.decode(msg.payload));
  if (o.type !== "announce" || o.v < 3) return;
  const signPk = unb64(o.signPk);
  if (fingerprintOf(signPk) !== o.id) return;           // id binds to key
  const priceJson = JSON.stringify(o.price ?? {});
  const canon = ["inference/v1/announce3", o.id, o.signPk, o.boxPk,
    (o.models ?? []).join(","), String(o.load ?? 0), String(o.cap ?? 0),
    priceJson, String(o.ts ?? 0)].join("|");
  if (!verify(enc.encode(canon), unb64(o.sig), signPk)) { console.log("BAD SIG", o.id); return; }
  if ((o.price?.amount ?? 0) > 0) return;               // want the free VPS
  provider = { id: o.id, boxPk: unb64(o.boxPk), signPk, price: o.price ?? {} };
});
for (let i = 0; i < 30 && !provider; i++) await sleep(1000);
if (!provider) { console.log("no free provider heard"); process.exit(1); }
console.log("provider:", provider.id, "access:", provider.price.access, provider.price.powbits ?? "");

// 2) seal a prompt to it (with a pow stamp if it gates on pow)
const promptId = crypto.randomUUID();
const reply = genEphemeral();                            // reply channel keypair
const inner = { prompt: "In one word, the capital of France?", replyPk: b64(reply.pk) };
if (provider.price.access === "pow") {
  const nonce = computePow(promptId, provider.id, provider.price.powbits ?? 18);
  inner.cred = { type: "pow", nonce };
  console.log("pow nonce:", nonce);
}
const sealed = seal(provider.boxPk, enc.encode(JSON.stringify(inner)));
const outer = { type: "prompt", id: promptId, v: 2, to: provider.id, box: b64(sealed) };

// 3) listen on the provider's session topic, then send
const sessionTopic = `/inference/1/p-${provider.id}/json`;
const sessInfo = createRoutingInfo(NETWORK, { contentTopic: sessionTopic });
let answered = false;
await node.filter.subscribe([createDecoder(sessionTopic, sessInfo)], (msg) => {
  if (!msg.payload) return;
  const o = JSON.parse(dec.decode(msg.payload));
  if (o.type !== "response" || o.id !== promptId) return;
  const opened = openWith(reply.sk, unb64(o.box));
  if (!opened) { console.log("could not open response"); return; }
  const r = JSON.parse(dec.decode(opened));
  const canon = enc.encode(`inference/v1/response|${o.id}|${o.box}`);
  const sigOk = verify(canon, unb64(o.sig), provider.signPk);
  console.log("\nRESPONSE (sig", sigOk ? "OK" : "BAD", "| model", r.model, "):\n  " + r.text.trim());
  answered = true;
});
await sleep(500);
await node.lightPush.send(createEncoder({ contentTopic: sessionTopic, routingInfo: sessInfo }),
  { payload: enc.encode(JSON.stringify(outer)) });
console.log("prompt sent:", promptId);

for (let i = 0; i < 90 && !answered; i++) await sleep(1000);
console.log(answered ? "\n✓ ROUND-TRIP OK — JS crypto is byte-compatible" : "\n✗ no response");
process.exit(answered ? 0 : 1);
