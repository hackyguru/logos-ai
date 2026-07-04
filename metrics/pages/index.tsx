import { useEffect, useRef, useState } from "react";
import Head from "next/head";
import { Geist, Geist_Mono } from "next/font/google";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

interface Provider {
  id: string; models: string[]; load: number; cap: number; price: string;
  version: number; verified: boolean; live: boolean; ageMs: number;
  cardsHeard: number; firstSeenMs: number;
}
interface Snapshot {
  connected: boolean; peerCount: number; error: string | null;
  contentTopic: string; cluster: number;
  stats: {
    activeProviders: number; knownProviders: number; modelsOffered: number;
    openSlots: number; cardsPerMin: number; verifiedPct: number | null;
    lastCardAgoMs: number | null;
  };
  modelCounts: Record<string, number>;
  providers: Provider[];
  history: { t: number; active: number }[];
}

function ago(ms: number): string {
  if (ms < 1_000) return "now";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}

const VERIFY_TIP =
  "a provider is live if a signed announcement arrived in the last 90s · " +
  "announcements are verified against the provider's Ed25519 identity " +
  "(fingerprint = SHA-256 of signing key)";

// Single-series sparkline (active providers over ~15 min). One series → no
// legend; the tile label names it. Recessive: no axes, a thin line over a
// faint area fill, one end dot.
function Sparkline({ points }: { points: { t: number; active: number }[] }) {
  if (points.length < 2) return null;
  const w = 200, h = 36, pad = 4;
  const max = Math.max(1, ...points.map((p) => p.active));
  const xs = (i: number) => pad + (i * (w - 2 * pad)) / (points.length - 1);
  const ys = (v: number) => h - pad - (v * (h - 2 * pad)) / max;
  const line = points.map((p, i) => `${xs(i)},${ys(p.active)}`).join(" ");
  const area = `${pad},${h - pad} ${line} ${xs(points.length - 1)},${h - pad}`;
  const last = points[points.length - 1];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="spark"
      aria-label="active providers over the last 15 minutes" role="img" preserveAspectRatio="none">
      <defs>
        <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--series-1)" stopOpacity="0.16" />
          <stop offset="100%" stopColor="var(--series-1)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill="url(#sparkFill)" />
      <polyline points={line} fill="none" stroke="var(--series-1)" strokeWidth="1.5"
        strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={xs(points.length - 1)} cy={ys(last.active)} r="2.5" fill="var(--series-1)" />
    </svg>
  );
}

function Tile({ label, value, sub, children }: {
  label: string; value: string | number; sub?: string; children?: React.ReactNode;
}) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {sub ? <div className="tile-sub">{sub}</div> : null}
      {children}
    </div>
  );
}

export default function Home() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [fetchErr, setFetchErr] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const poll = async () => {
      try {
        const r = await fetch("/api/metrics");
        setSnap(await r.json());
        setFetchErr(null);
      } catch (e) {
        setFetchErr(String(e));
      }
    };
    poll();
    timer.current = setInterval(poll, 5000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, []);

  const s = snap?.stats;
  const up = !!snap?.connected;

  return (
    <div className={`${geistSans.className} ${geistMono.className} viz-root min-h-screen font-sans`}>
      <Head><title>Inference Network — Metrics</title></Head>
      <style jsx global>{`
        .viz-root {
          --surface-1: #fafaf9;
          --surface-2: #ffffff;
          --border: rgba(0, 0, 0, 0.07);
          --border-strong: rgba(0, 0, 0, 0.12);
          --text-primary: #171614;
          --text-secondary: #57554f;
          --text-muted: #98958a;
          --series-1: #2a78d6;
          --status-good: #008300;
          --status-warning: #b97b00;
          --status-serious: #e34948;
          --shadow: 0 1px 2px rgba(24, 22, 18, 0.04), 0 4px 16px rgba(24, 22, 18, 0.03);
          background: var(--surface-1);
          color: var(--text-primary);
          -webkit-font-smoothing: antialiased;
        }
        @media (prefers-color-scheme: dark) {
          .viz-root {
            --surface-1: #161615;
            --surface-2: #1e1e1c;
            --border: rgba(255, 255, 255, 0.08);
            --border-strong: rgba(255, 255, 255, 0.14);
            --text-primary: #f2f1ec;
            --text-secondary: #b8b6ab;
            --text-muted: #7d7b71;
            --series-1: #3987e5;
            --status-good: #35b135;
            --status-warning: #c98500;
            --status-serious: #e66767;
            --shadow: none;
          }
        }

        .card {
          background: var(--surface-2);
          border: 1px solid var(--border);
          border-radius: 14px;
          box-shadow: var(--shadow);
        }
        .tile {
          background: var(--surface-2); border: 1px solid var(--border);
          border-radius: 14px; box-shadow: var(--shadow);
          padding: 18px 20px 16px; flex: 1; min-width: 160px;
          display: flex; flex-direction: column; gap: 2px;
        }
        .tile-label {
          font-size: 11px; letter-spacing: 0.07em; text-transform: uppercase;
          color: var(--text-muted); font-weight: 500;
        }
        .tile-value {
          font-size: 32px; font-weight: 600; line-height: 1.25;
          letter-spacing: -0.02em; font-variant-numeric: tabular-nums;
        }
        .tile-sub { font-size: 12px; color: var(--text-muted); }
        .spark { margin-top: 8px; width: 100%; height: 36px; display: block; }

        .section-label {
          font-size: 11px; letter-spacing: 0.07em; text-transform: uppercase;
          color: var(--text-muted); font-weight: 500; margin-bottom: 10px;
        }

        table { border-collapse: collapse; width: 100%; }
        th {
          text-align: left; font-size: 11px; font-weight: 500;
          letter-spacing: 0.05em; text-transform: uppercase;
          color: var(--text-muted); padding: 12px 16px;
          border-bottom: 1px solid var(--border);
        }
        td {
          font-size: 13px; padding: 13px 16px;
          border-bottom: 1px solid var(--border);
          font-variant-numeric: tabular-nums;
        }
        tr:last-child td { border-bottom: none; }
        tbody tr { transition: background 120ms ease; }
        tbody tr:hover { background: var(--surface-1); }
        th.num, td.num { text-align: right; }

        .mono { font-family: var(--font-geist-mono), monospace; font-size: 12px; }
        .chip {
          display: inline-flex; align-items: center; gap: 6px;
          background: var(--surface-2); border: 1px solid var(--border);
          border-radius: 999px; padding: 5px 12px; font-size: 12px;
          margin: 0 8px 8px 0; box-shadow: var(--shadow);
        }
        .chip-count { color: var(--text-muted); font-variant-numeric: tabular-nums; }
        .model-tag {
          display: inline-block; font-family: var(--font-geist-mono), monospace;
          font-size: 11px; padding: 2px 8px; border-radius: 6px;
          background: color-mix(in srgb, var(--series-1) 9%, transparent);
          color: var(--text-secondary); margin-right: 5px;
        }

        .dot { width: 7px; height: 7px; border-radius: 999px; display: inline-block; flex-shrink: 0; }
        .dot-live { background: var(--status-good); animation: pulse 2.4s ease-in-out infinite; }
        .dot-stale { background: var(--text-muted); opacity: 0.5; }
        @keyframes pulse {
          0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--status-good) 35%, transparent); }
          50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--status-good) 0%, transparent); }
        }
      `}</style>

      <main className="mx-auto max-w-4xl px-6 py-14">
        <header className="mb-10 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Inference Network</h1>
            <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
              decentralized AI marketplace — live view
            </p>
          </div>
          <span className={`dot ${up ? "dot-live" : "dot-stale"}`}
                title={up ? "connected to the waku network" : "connecting…"} />
        </header>

        {(snap?.error || fetchErr) && (
          <p style={{ color: "var(--status-serious)", fontSize: 13 }} className="mb-6">
            ⚠ {snap?.error ?? fetchErr}
          </p>
        )}

        {/* KPI row */}
        <section className="flex gap-4 flex-wrap mb-10" aria-label="headline metrics">
          <Tile label="Providers" value={s?.activeProviders ?? "—"}
                sub={s ? `${s.knownProviders} known` : " "}>
            <Sparkline points={snap?.history ?? []} />
          </Tile>
          <Tile label="Models" value={s?.modelsOffered ?? "—"} sub="live, distinct" />
          <Tile label="Open slots" value={s?.openSlots ?? "—"} sub="network-wide" />
          <Tile label="Announcements / min" value={s?.cardsPerMin ?? "—"}
                sub={s?.lastCardAgoMs != null ? `last ${ago(s.lastCardAgoMs)}` : "listening…"} />
        </section>

        {/* Models */}
        <section className="mb-10" aria-label="models offered">
          <div className="section-label">Models on the marketplace</div>
          {snap && Object.keys(snap.modelCounts).length > 0 ? (
            <div>
              {Object.entries(snap.modelCounts).sort((a, b) => b[1] - a[1]).map(([m, n]) => (
                <span className="chip" key={m}>
                  <span className="mono">{m}</span>
                  <span className="chip-count">{n}</span>
                </span>
              ))}
            </div>
          ) : (
            <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
              none heard yet — providers announce every ~30s
            </p>
          )}
        </section>

        {/* Providers */}
        <section aria-label="providers">
          <div className="section-label">Providers</div>
          <div className="card" style={{ overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>provider</th><th>models</th><th>signature</th>
                    <th className="num">slots</th><th className="num">last seen</th>
                    <th className="num">heard</th>
                  </tr>
                </thead>
                <tbody>
                  {(snap?.providers ?? []).map((p) => (
                    <tr key={p.id} style={{ opacity: p.live ? 1 : 0.45 }}>
                      <td>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
                          <span className={`dot ${p.live ? "dot-live" : "dot-stale"}`}
                                title={p.live ? "live" : "stale"} />
                          <span className="mono" title={p.id}>{p.id.slice(0, 12)}…</span>
                        </span>
                      </td>
                      <td>
                        {p.models.length > 0
                          ? p.models.map((m) => <span className="model-tag" key={m}>{m}</span>)
                          : <span style={{ color: "var(--text-muted)" }}>?</span>}
                      </td>
                      <td style={{ whiteSpace: "nowrap", cursor: "help" }} title={VERIFY_TIP}>
                        {p.verified
                          ? <span style={{ color: "var(--status-good)" }}>✓ signed</span>
                          : <span style={{ color: "var(--status-warning)" }}>⚠ unverified</span>}
                      </td>
                      <td className="num">{p.cap > 0 ? `${Math.max(0, p.cap - p.load)}/${p.cap}` : "—"}</td>
                      <td className="num" style={{ whiteSpace: "nowrap", color: "var(--text-secondary)" }}>
                        {ago(p.ageMs)}
                      </td>
                      <td className="num" style={{ color: "var(--text-secondary)" }}>{p.cardsHeard}</td>
                    </tr>
                  ))}
                  {(!snap || snap.providers.length === 0) && (
                    <tr><td colSpan={6} style={{ color: "var(--text-muted)", textAlign: "center", padding: 28 }}>
                      no providers heard yet
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
