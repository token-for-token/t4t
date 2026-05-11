# User Stories

Captured during scoping. Each story has acceptance criteria and notes on
implementation direction (storage, surface, tradeoffs). Code lands against
these stories — keep this doc in sync.

---

## US-1 — Provider stake lifecycle

> As a provider operator, I want to lock xBZZ on-chain when I join the
> network and reclaim it cleanly when I leave, so my collateral matches my
> participation.

**Acceptance criteria**
- Joining: container's first boot transfers `MIN_STAKE` (100 xBZZ) into the
  registry and registers the provider. Idempotent on restart.
- Leaving: operator can trigger `deactivate()` from the container (CLI
  subcommand). Container stops accepting new jobs.
- Reclaim: after `UNBONDING_PERIOD` (2 days) **and** all open jobs settled,
  operator can trigger `withdrawStake()` and receive their full stake back.
- Optional: SIGTERM handler can call `deactivate()` automatically when
  `T4T_DEACTIVATE_ON_SHUTDOWN=true`.

**Implementation notes**
- Contract side is done (`ProviderRegistry.register`/`deactivate`/`withdrawStake`).
- Container side needs: `deactivate` and `withdrawStake` bindings in
  `lib/chain.ts`, two CLI subcommands in `src/index.ts`, and a one-line
  signal handler.

---

## US-2 — Provider admin web UI

> As a provider operator, I want a local web UI showing incoming jobs,
> jobs in flight, completed jobs (with duration + earnings), and recent
> failures, so I can monitor my node without tailing logs.

**Acceptance criteria**
- Page lists jobs grouped by status (queued / running / delivered / claimed
  / failed). Default view = last 7 days.
- Each row shows: short jobId, client address, modelId, tokens
  (prompt/completion), duration (ack→deliver), earnings (xBZZ), status.
- Job detail view shows the full timeline (received, acked, started,
  completed, claimed) and any error message.
- Bound to `127.0.0.1` by default; configurable via `T4T_ADMIN_HOST` /
  `T4T_ADMIN_PORT`.
- Auto-refreshes every ~3s (HTMX polling), no manual reload needed.

**Implementation notes**
- Storage: **SQLite via `better-sqlite3`** in `/data/jobs.db`. Single file,
  no extra services, queryable. Redis adds an extra container for no win
  here.
- Schema:
  `jobs(jobId TEXT PK, client TEXT, modelId TEXT, status TEXT,`
  `receivedAt INT, ackedAt INT, completedAt INT, claimedAt INT,`
  `promptTokens INT, completionTokens INT, earnedXBZZ TEXT, errorMessage TEXT)`.
- UI: server-rendered HTML + HTMX, no SPA build step.

---

## US-3 — Client admin web UI

> As a client operator, I want a local web UI showing in-flight jobs, recent
> prompts + responses, and xBZZ spent, so I can audit usage and debug
> failures.

**Acceptance criteria**
- Page lists jobs with status, provider address, modelId, max payment,
  actual payment, posted/acked/delivered timestamps.
- Optional: payload view (prompt + response) — **opt-in only** via
  `T4T_PERSIST_PAYLOADS=true`; off by default.
- Aggregate counters: total spent (xBZZ), in-flight count, success rate.
- Same `127.0.0.1` default + `T4T_ADMIN_PORT` (separate from
  `T4T_HTTP_PORT` which serves OpenAI).

**Implementation notes**
- Same SQLite + HTMX pattern as US-2. Mirror schema on client side:
  `jobs(jobId TEXT PK, provider TEXT, modelId TEXT, status TEXT,`
  `maxPayment TEXT, actualPayment TEXT, postedAt INT, ackedAt INT,`
  `deliveredAt INT, claimedAt INT, prompt TEXT, response TEXT,`
  `promptTokens INT, completionTokens INT, errorMessage TEXT)`.
- Privacy: when `T4T_PERSIST_PAYLOADS=false`, `prompt`/`response` columns
  store the literal string `[redacted]`. Add `T4T_PAYLOAD_RETENTION_HOURS`
  (default 24h) for auto-deletion when persistence is on.

---

## US-4 — Connectivity config + status panel

> As an operator, I want to configure my Bee node and Gnosis RPC endpoints
> via env / compose, and see live connectivity status in the web UI, so I
> can diagnose problems before they cost me jobs.

**Acceptance criteria**
- `BEE_API_URL` and `GNOSIS_RPC_URL` are required env vars (✅ already
  enforced in `lib/config.ts`).
- Admin UI has a "Status" panel with three sections:
  - **Bee**: URL, `/health` reachable (Y/N), node overlay address,
    postage batch ID + utilization + remaining TTL.
  - **Gnosis**: RPC URL, chain id, latest block height, wallet xDAI (gas)
    balance, wallet xBZZ balance, allowance → escrow/registry, contracts-
    present check.
  - **Role-specific**:
    - Provider → stake, openJobs, lastHeartbeat (with "stale" flag if past
      `HEARTBEAT_TTL`).
    - Client → pending jobs count, most recent successful job timestamp.
- Refresh interval is `T4T_STATUS_REFRESH_SECONDS` (default 10s) to avoid
  hammering public RPCs.

---

## US-5 — Model selection from Open WebUI

> As a client user, I want my chat app's model dropdown to list the models
> actually available across T4T providers, so picking a model "just works".

**Acceptance criteria**
- `GET /v1/models` returns the union of `modelId`s from active providers
  in the registry (✅ wired in `modes/client/index.ts`).
- Results are **cached** for `T4T_MODELS_CACHE_TTL_SECONDS` (default 60)
  to avoid re-scanning the registry on every request.
- Admin UI has a "Models" panel showing each discovered model with:
  provider count, min/median price per 1k tokens, slowest declared SLA.
- Optional filtering env vars to narrow the surfaced set:
  - `T4T_ALLOWED_MODELS` — comma-list whitelist.
  - `T4T_MIN_PROVIDERS_PER_MODEL` — drop models with fewer providers.

---

## Cross-cutting decisions

- **Storage**: SQLite (file-backed, embedded) for both modes. Redis
  rejected — adds an extra container without a clear win for a
  single-process node.
- **UI stack**: Express + server-rendered HTML + HTMX. No SPA build step,
  no separate frontend container.
- **Network exposure**: admin UI binds to `127.0.0.1` by default. Operators
  who want remote access can override with `T4T_ADMIN_HOST=0.0.0.0` and
  put it behind a reverse proxy + auth themselves.
- **Privacy**: decrypted payloads (prompts, responses) **never** persist to
  disk by default. Opt-in via `T4T_PERSIST_PAYLOADS=true` with retention TTL.
