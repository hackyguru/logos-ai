import { useEffect, useRef, useState } from "react";
import Head from "next/head";
import { Geist, Geist_Mono } from "next/font/google";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

interface Provider {
  id: string; models: string[]; load: number; cap: number;
  priceAmount: number; priceUnit: string; access: string; powBits: number;
  live: boolean; ageMs: number;
}
interface Exchange {
  id: string; prompt: string; status: "pending" | "done" | "failed" | "unknown";
  text?: string; model?: string; provider?: string; rttMs?: number; error?: string;
  sentAt: number;
}

export default function Home() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [model, setModel] = useState("");            // "" = any
  const [providerId, setProviderId] = useState(""); // "" = auto
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const exRef = useRef<Exchange[]>([]);
  exRef.current = exchanges;

  // Poll the roster.
  useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch("/api/providers");
        const j = await r.json();
        setProviders(j.providers ?? []);
      } catch {}
    };
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  // Poll any in-flight answers.
  useEffect(() => {
    const t = setInterval(async () => {
      const inflight = exRef.current.filter((e) => e.status === "pending");
      if (!inflight.length) return;
      const updates = await Promise.all(inflight.map(async (e) => {
        try { const r = await fetch(`/api/result?id=${e.id}`); return { id: e.id, r: await r.json() }; }
        catch { return null; }
      }));
      setExchanges((prev) => prev.map((e) => {
        const u = updates.find((x) => x && x.id === e.id);
        if (!u) return e;
        return { ...e, status: u.r.status, text: u.r.text, model: u.r.model,
                 provider: u.r.provider, rttMs: u.r.rttMs, error: u.r.error };
      }));
    }, 1500);
    return () => clearInterval(t);
  }, []);

  const live = providers.filter((p) => p.live);
  const models = Array.from(new Set(live.flatMap((p) => p.models))).sort();
  const eligible = live.filter((p) => (!model || p.models.includes(model)) && p.priceAmount === 0);

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/prompt", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: t, model: model || undefined, providerId: providerId || undefined }),
      });
      const j = await r.json();
      if (j.id) {
        setExchanges((prev) => [{ id: j.id, prompt: t, status: "pending", sentAt: Date.now() }, ...prev]);
        setText("");
      } else {
        setExchanges((prev) => [{ id: "err" + Date.now(), prompt: t, status: "failed", error: j.error, sentAt: Date.now() }, ...prev]);
      }
    } finally { setBusy(false); }
  };

  const priceLabel = (p: Provider) =>
    p.priceAmount > 0 ? `${p.priceAmount}/${p.priceUnit === "1ktokens" ? "1k tok" : "req"}` : "free";

  return (
    <div className={`${geistSans.className} ${geistMono.className} root min-h-screen`}>
      <Head><title>Logos AI — Inference</title></Head>
      <style jsx global>{`
        .root {
          --bg: #fafaf9; --card: #fff; --border: rgba(0,0,0,.08);
          --fg: #171614; --fg2: #57554f; --muted: #98958a;
          --accent: #2a78d6; --good: #008300; --bad: #e34948;
          background: var(--bg); color: var(--fg);
          -webkit-font-smoothing: antialiased;
        }
        @media (prefers-color-scheme: dark) {
          .root { --bg:#161615; --card:#1e1e1c; --border:rgba(255,255,255,.09);
                  --fg:#f2f1ec; --fg2:#b8b6ab; --muted:#7d7b71; --accent:#3987e5;
                  --good:#35b135; --bad:#e66767; }
        }
        * { box-sizing: border-box; }
        select, textarea, button { font: inherit; }
        select { background: var(--card); color: var(--fg); border: 1px solid var(--border);
                 border-radius: 8px; padding: 7px 10px; }
        .send { background: var(--accent); color: #fff; border: none; border-radius: 8px;
                padding: 9px 18px; font-weight: 550; cursor: pointer; }
        .send:disabled { opacity: .5; cursor: default; }
        textarea { background: var(--card); color: var(--fg); border: 1px solid var(--border);
                   border-radius: 10px; padding: 12px 14px; width: 100%; resize: vertical; }
        .bubble { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
        .mono { font-family: var(--font-geist-mono), monospace; }
      `}</style>

      <main style={{ maxWidth: 720, margin: "0 auto", padding: "44px 20px 80px" }}>
        <header style={{ marginBottom: 26 }}>
          <h1 style={{ fontSize: 22, fontWeight: 650, letterSpacing: "-.02em", margin: 0 }}>Logos AI</h1>
          <p style={{ color: "var(--muted)", fontSize: 13, margin: "2px 0 0" }}>
            private inference from the decentralized marketplace — end-to-end encrypted, in your browser
          </p>
        </header>

        {/* controls */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
          <span style={{ fontSize: 12, color: "var(--fg2)" }}>Model</span>
          <select value={model} onChange={(e) => { setModel(e.target.value); setProviderId(""); }}>
            <option value="">Any</option>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <span style={{ fontSize: 12, color: "var(--fg2)" }}>Provider</span>
          <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            <option value="">Auto (cheapest, least loaded)</option>
            {eligible.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id.slice(0, 10)}… · {priceLabel(p)}{p.access === "pow" ? " · ⛏" : ""}
              </option>
            ))}
          </select>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>
            {live.length} live provider{live.length === 1 ? "" : "s"}
          </span>
        </div>

        {/* composer */}
        <div style={{ marginBottom: 8 }}>
          <textarea rows={3} value={text} placeholder="Ask anything…  (⌘/Ctrl+Enter to send)"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send(); }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 26 }}>
          <span style={{ fontSize: 11, color: "var(--muted)" }}>
            {eligible.length === 0
              ? "⚠ no free provider available for this selection"
              : "prompt is sealed to the provider — the network sees only ciphertext"}
          </span>
          <button className="send" onClick={send} disabled={busy || !text.trim() || eligible.length === 0}>
            {busy ? "Sending…" : "Send"}
          </button>
        </div>

        {/* conversation */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {exchanges.map((e) => (
            <div key={e.id} className="bubble">
              <div style={{ fontSize: 14, fontWeight: 550, marginBottom: 8 }}>🧑 {e.prompt}</div>
              <div style={{ height: 1, background: "var(--border)", margin: "0 0 10px" }} />
              {e.status === "pending" && (
                <div style={{ color: "var(--fg2)", fontSize: 14 }}>
                  🤖 <span style={{ color: "var(--muted)" }}>thinking… {Math.floor((Date.now() - e.sentAt) / 1000)}s</span>
                </div>
              )}
              {e.status === "done" && (
                <>
                  <div style={{ fontSize: 14, whiteSpace: "pre-wrap" }}>🤖 {e.text || "(empty)"}</div>
                  <div style={{ fontSize: 11, color: "var(--good)", marginTop: 8 }}>
                    🔒 E2E · {e.model || "model"} · {e.provider?.slice(0, 10)}… · {e.rttMs} ms
                  </div>
                </>
              )}
              {e.status === "failed" && (
                <div style={{ fontSize: 14, color: "var(--bad)" }}>⚠ {e.error || "no answer"}</div>
              )}
            </div>
          ))}
          {exchanges.length === 0 && (
            <p style={{ color: "var(--muted)", fontSize: 13, textAlign: "center", padding: "30px 0" }}>
              No prompts yet. Pick a model (or leave it on Any) and send one.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
