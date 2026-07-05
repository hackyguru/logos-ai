# web — browser inference client

A Next.js app that lets anyone use the Logos AI inference marketplace from a
browser: pick a model/provider, send a prompt, get an answer — **end-to-end
encrypted**, no wallet, no account.

## Why the waku node runs server-side

The `logos.dev` waku fleet speaks raw TCP (no browser-reachable websockets), so
a browser can't join the network directly. As with the `metrics` dashboard, the
**js-waku light node runs inside the Next.js server process** (`@libp2p/tcp`),
and the browser talks to it over `/api`. The server is a full marketplace *user*
— it never runs a model, it just seals prompts to providers and opens their
sealed responses.

```
browser --POST /api/prompt--> Next.js server --sealed prompt--> provider (ollama)
        <-GET /api/result---- (waku light node) <--sealed response--
```

## Crypto parity

`lib/crypto.ts` is a byte-compatible port of the C++ InferenceIdentity
(inference-core): X25519 ECDH -> HMAC-SHA256 KDF (key+nonce bound to both
pubkeys) -> ChaCha20-Poly1305, wire ephPk(32)||ct||tag(16); Ed25519 verify;
SHA-256 fingerprint; hashcash PoW. Verified against the live C++ provider.

## Run

    npm install          # uses an @multiformats/multiaddr override (see package.json)
    npm run dev -- --port 3003

Open http://localhost:3003. Priced providers are skipped in Auto until LEZ
payments exist; PoW-gated providers are handled transparently (stamp computed
server-side).

## API

- GET  /api/providers — verified live roster
- POST /api/prompt  { text, model?, providerId? } -> { id }
- GET  /api/result?id=… -> { status, text, model, provider, rttMs }
