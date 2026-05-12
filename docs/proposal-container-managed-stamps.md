# Proposal — container-managed postage stamps

Today operators buy a Swarm postage batch out-of-band (Bee dashboard or
`POST /stamps`) and paste the 64-char hex into `POSTAGE_BATCH_ID`. Both
container modes need a stamp:

- **Provider** — uploads the encrypted response chunk before `claimJob`.
- **Client** — uploads the encrypted request chunk before `postJob`.

This proposal moves stamp lifecycle into the t4t container (both modes) so
operators only configure intent (size + lifetime), not the batch ID.

## Goals

- One fewer manual step in the provider *and* client getting-started flows.
- Container picks depth/amount appropriate for its workload.
- Operator can top up / dilute from the admin UI instead of the Bee dashboard.
- Shared implementation between provider and client modes — same module,
  same env vars, same UI panel.

## Non-goals

- Funding the Bee node's wallet with xBZZ/xDAI. That stays a Bee concern.

## UX

1. Operator runs the container with no `POSTAGE_BATCH_ID` set, but with new
   stamp-intent env vars (see below).
2. On boot, the container:
   - Lists existing batches via `GET /stamps`.
   - If a usable batch exists (matches label `t4t-managed`, `usable: true`,
     remaining TTL ≥ `T4T_STAMP_MIN_TTL_DAYS`), reuses it.
   - Otherwise calls `POST /stamps/{amount}/{depth}` with a label of
     `t4t-managed` and persists the returned `batchID`.
3. A background tick (e.g. every heartbeat) checks remaining TTL; if below
   threshold, calls `PATCH /stamps/topup/{batchID}/{amount}`.
4. Admin UI gets a **Stamps** tab showing current batch, depth, remaining
   TTL, utilization, and buttons for **Top up** and **Dilute**.

If `POSTAGE_BATCH_ID` *is* explicitly set, the container uses it verbatim
and does **not** manage it (escape hatch / backwards compat).

## Config

| Var | Meaning | Default |
|---|---|---|
| `T4T_STAMP_MANAGE` | `true` to enable container-managed stamps | `false` (opt-in initially) |
| `T4T_STAMP_DEPTH` | Bee batch depth (2^depth chunks addressable) | `22` |
| `T4T_STAMP_TTL_DAYS` | Target lifetime when purchasing a new batch | `30` |
| `T4T_STAMP_MIN_TTL_DAYS` | Auto-topup trigger | `7` |
| `T4T_STAMP_LABEL` | Label used to identify t4t-managed batches | `t4t-managed` |

`amount` is derived from `T4T_STAMP_TTL_DAYS` × current chain price (from
`GET /chainstate` → `currentPrice`) × blocks/day. Bee exposes this; compute
on the fly rather than asking the operator for raw wei.

## Bee API surface used

- `GET /stamps` — list existing batches.
- `GET /chainstate` — fetch `currentPrice` for amount math.
- `POST /stamps/{amount}/{depth}?label=...` — buy.
- `PATCH /stamps/topup/{batchID}/{amount}` — extend TTL.
- `PATCH /stamps/dilute/{batchID}/{depth}` — grow capacity.

## Safety / idempotency rules

- Never buy a new stamp if a `t4t-managed` batch with `usable: true` already
  exists. (Multiple t4t containers against the same Bee node should converge
  on one batch.)
- Never buy more than one stamp per container lifetime without explicit UI
  confirmation. Restart loops must not drain the Bee node's wallet.
- Log the planned amount + xBZZ cost before submitting; expose dry-run via
  `T4T_STAMP_DRY_RUN=true`.
- Surface failures loudly in the admin UI (red banner) — providers can't
  serve jobs and clients can't post jobs without a usable stamp.
- All stamp mutations require an admin UI confirmation modal (top up /
  dilute aren't reversible).

## Where the code lives

- New module: `container/src/lib/stamps.ts` — pure functions for list / buy
  / topup / dilute / amount-from-ttl, talking to Bee via the existing
  `Bee` client (extend if needed). Mode-agnostic.
- Wire-up (provider): `container/src/modes/provider/index.ts` — call
  `ensureStamp()` before the heartbeat loop starts.
- Wire-up (client): `container/src/modes/client/index.ts` — call
  `ensureStamp()` before the HTTP server starts accepting requests.
- Admin UI: new route group `/admin/stamps` shared between
  `container/src/modes/provider/admin.ts` and
  `container/src/modes/client/admin.ts` — extract the panel into
  `container/src/lib/admin-stamps.ts` so both modes mount the same view.
- Config: extend `container/src/lib/config.ts` with the new env vars
  (shared block; both modes read the same names).

## Docs to update once shipped

- `docs/getting-started-provider.md` — remove the "funded postage batch"
  prereq when `T4T_STAMP_MANAGE=true`; add the new env vars.
- `docs/getting-started-client.md` — same change on the client side.
- `docs/architecture.md` — note that the container talks to Bee's stamp
  endpoints, not just chunk upload/download.
