# Part 13 — Payments: anonymous LEZ-paid inference

Turn the free inference marketplace into a **paid** one, where a user pays a
provider for each session of inference over the **Logos Execution Zone (LEZ)** —
and the **user's money identity stays hidden**. No mocks: proven end to end
across two machines on the hosted testnet (`testnet.lez.logos.co`).

> One line: the user **deshields** a small amount from their *private* LEZ
> balance to the provider's *public* account, the provider **verifies the credit
> over a plain RPC read** before serving, and the payment buys a quota of prompts.

## Roles

```
   Alice — the user (Basecamp)                Bob — the provider (logoscore CLI)
   ─────────────────────────────             ──────────────────────────────────
   inference-ui + inference-core             inference_provider + ollama
   logos_wallet (LEZ)  ← pays from           reads payTo balance over RPC
   private, shielded balance                 (no wallet module needed)
```

- **Alice stays anonymous** — she pays with a *shielded* note; the sender is
  hidden by the zk circuit. Bob only ever sees "a public credit arrived."
- **Bob needs no wallet on his node** — he only *reads* his `payTo` account's
  balance via the sequencer RPC. Creating that account and spending its earnings
  need a Basecamp wallet elsewhere (see *Limitations*).

## Payment flow — per-session prepay

```
  Alice picks a paid provider ─────────────────────────────────────────────┐
                                                                            │
  ensureSession(): first prompt to that provider →                         │
     lezTransfer("deshielded", amount, payTo)  via logos_wallet            │  amount =
     (private → public; Alice shielded)                                     │  base + small
                          │                                                 │  random salt
                          ▼                                                 │  (= session id,
  ── deshield settles on testnet.lez.logos.co (~1 min zk proof) ──         │   binds pay→
                          │                                                 │   session; no
  prompt is PARKED until the credit lands ── pollPayments() watches         │   memo needed)
  the payTo balance via getAccountBalance RPC                               │
                          │                                                 │
                          ▼  credit seen                                    │
  prompt released, sealed with cred = {type:"lez-prepay", amount} ─────────┘
                          │
                          ▼
  Bob: sessionEligible(cred) — confirms the one-time payment landed on payTo,
       unlocks INFERENCE_QUOTA prompts for this session, runs ollama
                          │
                          ▼
  Alice gets a sealed answer.  Next prompts in the session are FREE until the
  quota is spent, then a new session (new payment) opens automatically.
```

Everything private (the prompt, the credential) rides inside the sealed
envelope (`box`), invisible to the network — the payment credential slots into
the same `cred` field as the pow/RLN credentials.

## Run it

**Provider** (env on top of the normal `inference-provider.sh` / deploy):

```bash
INFERENCE_ACCESS=lez                 # only answer prompts backed by a paid session
INFERENCE_PAY_BACKEND=lez            # real payments (not the "mock" dev backend)
INFERENCE_PAY_TO=<64-hex account id> # the provider's PUBLIC LEZ account (see below)
INFERENCE_QUOTA=10                   # prompts unlocked per paid session (default 10)
INFERENCE_PRICE=1                    # advertised price floor (per session)
INFERENCE_MODELS=tinyllama           # keep it fast — big models blow the client timeout
```

The provider only *reads* `payTo` over RPC, so it needs no wallet. But `payTo`
must be a **registered public LEZ account** — create one once in a Basecamp
`logos_wallet` ("+ Public" registers it on-chain) and paste its hex id here.

**User** (Basecamp): run the inference app with `INFERENCE_PAY_BACKEND=lez`, open
the **Logos Wallet** once (the wallet bar in the inference UI auto-opens it), and
make sure the LEZ wallet has a **private balance** (pinata → shield). Send a
prompt to a paid provider; the wallet bar + session line show the deshield
settling and the quota remaining.

## Why these choices

- **Per-session prepay, not per-request.** An on-chain LEZ transfer is a ~1-min
  zk proof — far too slow to gate every prompt. One payment buys a quota of
  prompts; only the first prompt of a session waits on settlement.
- **Not payment streams (LIP-155).** The intended primitive is
  [`lez-payment-streams`](https://github.com/logos-co/lez-payment-streams), but
  its program isn't deployed on the hosted testnet and can't be registered by a
  third party (`getProgramIds` lists only amm, authenticated_transfer, pinata,
  privacy_preserving_circuit, token; there is no register-program RPC). So we
  settle on the deployed `privacy_preserving_circuit` via a one-time deshield.
- **Amount as session id.** `transfer_deshielded`/`transfer_private` have no memo
  field, so the payment's (unique) amount doubles as the session identifier —
  the provider binds a payment to a session by matching the amount.
- **User-anonymous, provider public.** Keeping the provider's `payTo` transparent
  lets it verify with a bare RPC read (no LEZ module on the node). Shielding the
  provider too (bilateral anonymity) needs `logos_execution_zone` on its box.
- **Sessions persist.** The provider writes its session ledger to
  `~/.inference-provider-sessions.json`, so a restart/redeploy doesn't burn a
  user's prepaid quota.

## Limitations (honest)

- **Only the Basecamp-bundled LEZ module can *write* to the hosted testnet.** Its
  program image IDs match the deployed ones; a source build's don't, so its
  writes are silently dropped. This is why the *user* pays from Basecamp and the
  *provider* only reads over RPC — and why "give Bob a CLI wallet" doesn't work.
- **`payTo` is not yet a genuinely independent Bob.** In the current demo the
  provider's account is one the *user's* wallet controls, so the money doesn't
  truly leave Alice. A real transfer needs Bob running his own Basecamp wallet
  (own seed) and pointing `INFERENCE_PAY_TO` at *his* account.
- **Bilateral anonymity is not implemented** — the provider's account is public.
- **Amount-collision edge case.** Two *concurrent* payments of the *same* amount
  can't be told apart under the running-balance accounting. Negligible with wide
  amounts on a funded wallet; a robust fix is per-deposit attribution via the
  zonescan indexer API (adds a third-party dependency).

## Where it lives

- User: `inference-core/src/inference_plugin.cpp` — `ensureSession`,
  `pollPayments`, `paymentStatus`, the sealed `lez-prepay` cred.
- Provider: `cli-provider/provider-core/src/provider_plugin.cpp` —
  `sessionEligible`, `seqBalance`, session persistence, earnings in `stats()`.
- UI: `inference-ui/Main.qml` — the wallet balance bar + live session status.
- Wallet: the `logos_wallet` module (separate `logos-workshop` tree) provides
  `lezTransfer` / `lezReceiveAddress` / balances.
