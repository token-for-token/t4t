# Architecture

A two-page tour. The protocol spec lives in [`spec.md`](spec.md); this doc orients you in the code.

## Layers

```
┌────────────────────────────────────────────────────────────────┐
│  Apps (Open WebUI, LibreChat, Continue.dev, …)                 │
│    └── OpenAI HTTP  ──►  T4T client container :8080            │
└────────────────────────────────────────────────────────────────┘
                                │
                  ┌─────────────┴──────────────┐
                  ▼                            ▼
        modes/client/server.ts        modes/provider/index.ts
        (express OpenAI shim)         (PSS listener + worker pool)
                  │                            │
                  ├──► lib/chain.ts  ◄──┐      │
                  ├──► lib/swarm.ts  ◄──┼──────┤
                  ├──► lib/envelope ◄───┘      │
                  └──► lib/crypto    (ECIES — passthrough in v1)
                                              │
                                              ▼
                                       lib/ollama.ts → Ollama
```

## Where things live

| Concern | File |
|---|---|
| OpenAI HTTP shim | `container/src/modes/client/server.ts` |
| Provider selection | `container/src/modes/client/selector.ts` |
| Job round-trip orchestration | `container/src/modes/client/index.ts` |
| PSS listener + concurrency cap | `container/src/modes/provider/listener.ts` |
| Job execution (fetch → infer → upload → claim) | `container/src/modes/provider/worker.ts` |
| Envelope sign/verify, topics, dedup | `container/src/lib/envelope.ts` |
| bee-js wrapper (chunks + PSS) | `container/src/lib/swarm.ts` |
| viem chain bindings | `container/src/lib/chain.ts` |
| ABIs | `container/src/lib/abi.ts` |
| Payload cipher (ECIES) | `container/src/lib/crypto.ts` |
| Ollama HTTP passthrough | `container/src/lib/ollama.ts` |
| Config + env validation | `container/src/lib/config.ts` |
| Contracts | `contracts/src/*.sol` |

## Invariants

- **One image, two modes.** Mode is selected by `T4T_MODE` and never mixed at runtime.
- **Envelope = canonical JSON + EIP-191.** Mirrors SwarmChat exactly so the same wallets work across both apps.
- **PSS carries metadata only.** Payloads live on Swarm. Hashes traverse PSS and the chain.
- **The chain is the source of truth for money.** PSS is best-effort coordination; if PSS drops, deadlines + slashing still settle the job.
- **Provider stake covers worst-case slashing across open jobs.** Enforced on `postJob` (see `JobEscrow.postJob`).

## Open work (M1 → M2)

- ECIES payload encryption in `lib/crypto.ts`.
- Event-indexed `JobPosted` → routing-id map in `modes/provider/index.ts` (the `resolveOnChainJobId` stub).
- Separate PSS keypair from wallet (currently the wallet address is the placeholder PSS pub key).
- Heartbeat-failure detection in client selector (`isLive` is checked on-chain, but stale rows still surface in `listProviders`).
