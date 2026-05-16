# Proposal — alternative client/provider implementations

T4T is fundamentally an on-chain protocol: `ProviderRegistry` + `JobEscrow` on
Gnosis Chain define the contract, and the PSS envelope + Swarm payload schemas
in [`spec.md`](spec.md) §5–6 define the wire format. The Node/TypeScript
container in `container/` is *one* implementation of that protocol — the
reference, not the definition.

This proposal carves out room for additional implementations (CLI binary, Go,
Rust, …) without touching the on-chain or wire-level surface.

## Goals

- Make it explicit that the protocol is the source of truth and the container
  is a reference implementation.
- Lower the barrier for operators who don't want a Docker runtime: ship a
  standalone CLI binary that speaks the same protocol.
- Open the door for ecosystem implementations (Go for ops-heavy provider
  fleets, Rust for embedded / single-binary distribution, etc.) without
  requiring them to live in this repo.

## Non-goals

- Removing or deprecating the existing TypeScript container — it stays the
  reference and the easiest path for new contributors.
- Defining a new spec. Alternative implementations conform to the existing
  `spec.md`; any change in wire behavior is a spec change, not an
  implementation choice.

## Phase 1 — Native CLI from the existing TS code

The Node container is already 90% a CLI: `container/package.json` declares
`"bin": { "t4t": "dist/index.js" }`, and `make dev-gateway` / `make
dev-provider` already run it natively via `tsx watch`. Small gaps to close:

- `T4T_DATA_DIR` defaults to `/data` (`container/src/lib/config.ts:54`) —
  switch to `~/.t4t` when not running inside the official image.
- `OPENAI_BASE_URL` defaults to `http://host.docker.internal:11434`
  (`config.ts:94`) — switch to `http://localhost:11434` for native runs.
- Mark `dist/index.js` executable in `build.mjs` and add `make install-cli`
  (`npm link`) so `t4t` is on `$PATH`.
- Add a "Run without Docker" section to the README and
  `docs/getting-started-*.md`.
- Optional: ship a single-file binary via `pkg` or Node SEA so users don't
  need a Node toolchain.

External dependencies (Bee, Ollama, Gnosis RPC) remain external regardless —
the CLI just removes the t4t container itself from the Docker requirement.

## Phase 2 — Alternative-language implementations

Once the protocol and reference behavior are pinned down (post-M3), other
implementations can ship as sibling repos under the `t4t` org. Likely
candidates:

- **Go provider** — appealing for operators running fleets; static binary,
  good ergonomics for systemd/k8s deployments, mature `go-ethereum` + Swarm
  ecosystem.
- **Rust client/CLI** — appealing for distribution: single static binary,
  embeddable as a library (`t4t-sdk`), good fit for desktop apps that want
  T4T as a backend without spawning a Node runtime.
- **Browser SDK (TS, no Node)** — direct in-browser gateway, no local
  daemon; pairs well with a Swarm-hosted dApp.

Each implementation needs to cover the same surface:

1. **Chain bindings** — `ProviderRegistry` + `JobEscrow` calls (generated
   from the ABIs in `contracts/out/`).
2. **PSS envelope** — sign/verify per `spec.md` §5.2; must produce
   byte-identical envelopes to the reference for cross-implementation tests.
3. **Swarm payload** — request/response schemas per §6.1–6.2, including the
   ECIES wrap once it lands (currently passthrough; see
   `container/src/lib/crypto.ts`).
4. **Selection / heartbeat / claim** logic per §3 and §8.

## Conformance

To keep implementations honest, this repo should grow a
`tests/conformance/` directory with:

- A set of canonical PSS envelopes (hex blob + expected verifier output) any
  implementation can replay.
- A scripted end-to-end against the local Anvil fork that any implementation
  can drive: register provider, post job, deliver, claim, assert balances.

The reference container is the first thing required to pass this suite; new
implementations earn an entry in a `IMPLEMENTATIONS.md` once they pass too.

## Open questions

- Repo layout: monorepo (`container-go/`, `container-rust/`, …) or one repo
  per implementation? Per-repo keeps language toolchains isolated but
  fragments the spec ↔ implementation feedback loop.
- Versioning: tag the spec independently of the reference container so
  alternative implementations can pin to a spec version
  (`t4t-spec@1.0.0`) without coupling to the container's release cadence.
- Who maintains alternative implementations — core team, or community with
  a conformance bar? Probably the latter, once the conformance suite exists.

## Milestone fit

- **Phase 1 (CLI)** — could land anytime after M1; small, doesn't touch the
  protocol.
- **Phase 2 (alt languages)** — gated on spec stability, realistically
  post-M3 ("Real network") when the wire format has been exercised against
  multiple providers and is unlikely to churn.
