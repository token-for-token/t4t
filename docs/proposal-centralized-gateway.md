# Proposal — hosted multi-tenant gateway

Today, using T4T as a client requires running the gateway container yourself
(`docs/getting-started-gateway.md`). That means a Bee node, a Gnosis Chain RPC,
a wallet funded with xBZZ for payment and xDAI for gas, and a managed postage
batch — before a single chat completion goes out. For protocol participants
this is fine; for someone who just wants OpenAI-compatible inference against
the T4T network, it is several onboarding steps too many.

This proposal sketches a **hosted gateway**: an OpenRouter-shaped frontend
over an Infura-shaped relay. From the user's perspective it looks like
OpenRouter — sign up, add a card, get an `Authorization: Bearer t4t_…` API
key, point any OpenAI-compatible app at `https://api.t4t.eth/v1`,
pay-per-token in USD against a unified model catalogue. From the protocol's
perspective the operator plays the same role Infura plays for Ethereum:
runs the heavy infrastructure (wallet, Bee, RPC, postage) so the end user
never touches it, while the underlying decentralized network does the real
work. The gateway operator runs the existing `T4T_MODE=gateway` container
as a multi-tenant deployment, holds the xBZZ / xDAI balance, manages the
postage batch, and bills users in fiat. End users get an OpenAI-shaped API
surface; providers see the gateway as a normal on-chain client. The
decentralized substrate is unchanged.

This is **strictly additive**: the self-hosted gateway in
`container/src/modes/gateway/` remains the canonical path and the trust-
minimised option. The hosted gateway is one operator's product running on top
of the existing protocol, not a replacement for it.

## Goals

- Remove every prerequisite between "I have a credit card" and "I can call
  `POST /v1/chat/completions` against T4T providers."
- Give app developers a stable, hosted endpoint they can embed without
  shipping a Bee node alongside their app.
- Reuse `modes/gateway` as the engine; add only the multi-tenant auth and
  billing layer in front of it.
- Keep the on-chain and PSS surface untouched. Providers must not need to
  know whether a job came from a hosted gateway or a self-hosted one.
- Document the trust deltas plainly so users opting into the hosted gateway
  understand what they are trading away versus running their own.

## Non-goals

- Replacing the self-hosted gateway. `T4T_MODE=gateway` stays the reference
  path and is the only option that gives the user end-to-end key custody.
- Changing `spec.md`. No new PSS topics, no new envelope types, no new
  contract methods. The hosted gateway is one wallet talking to the existing
  registry + escrow.
- Acting as a custodian of crypto for end users. Users buy *credits in fiat*
  consumed against the operator's xBZZ float; they never hold xBZZ
  themselves, and there is no withdrawal-to-wallet flow.
- Building a provider-facing dashboard. Providers continue to use the
  existing admin UI in `modes/provider/`.
- KYC / AML beyond what the payment processor (Stripe) already enforces for
  the operator. No identity gating beyond payment.

## UX

1. User visits `app.t4t.eth` (or a sibling domain), enters email + password,
   verifies email. No wallet, no seed phrase.
2. User adds a Stripe-backed card and tops up credits in USD (e.g. minimum
   $10). A dashboard shows current balance, recent spend, and a "create API
   key" button.
3. User creates an API key (`t4t_live_…`) scoped to their account, with
   optional spend cap and model allowlist. Multiple keys per account for
   per-app separation.
4. User points any OpenAI client at:
   ```
   base_url = https://api.t4t.eth/v1
   api_key  = t4t_live_…
   ```
   `GET /v1/models` lists the union of models the operator's gateway can
   route to, filtered against the key's allowlist if set.
5. Each request:
   - Auth middleware resolves the key → account, checks balance, checks
     model allowlist, applies rate limits.
   - The request is handed to the existing `modes/gateway` flow: provider
     selection, request upload to Swarm, `postJob`, ACK, response fetch.
   - On `claimJob` success, the actual xBZZ cost is converted to USD via a
     posted price (xBZZ/USD oracle or operator-set markup) and debited from
     the account balance. A row is written to the per-account usage log.
6. Dashboard shows: per-day spend, per-model spend, per-key spend, recent
   request log (job IDs only by default; payloads opt-in with a stronger
   retention warning — see Privacy below).

There is no wallet UI, no gas top-up prompt, no postage batch screen. The
operator handles all of that internally.

## Architecture

The hosted gateway sits on top of one (or a small pool of) existing
`T4T_MODE=gateway` containers. It is **not** a fork — the existing code in
`container/src/modes/gateway/` is the engine. New surfaces live in a sibling
package; the gateway container exposes a minimal internal API the hosted
layer calls.

```
┌──────────────────────────────────────────────────────────────────────┐
│  End-user app (Cursor, LibreChat, custom)                            │
│   └── OpenAI HTTP, key: t4t_live_…                                   │
└──────────────────────────┬───────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  hosted/ (new) — Node service, runs on the operator's infra          │
│   ├── auth         (API key → account, rate limit, model allowlist)  │
│   ├── billing      (Stripe webhooks, USD↔xBZZ conversion, ledger)    │
│   ├── dashboard    (Express + HTMX, mirrors existing admin style)    │
│   └── proxy        (forwards /v1/* into an internal gateway pool)    │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ internal HTTP, signed per-tenant header
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  modes/gateway (unchanged) — operator wallet, Bee, postage batch     │
│   ├── selector / server / models  (per docs/architecture.md)         │
│   └── per-job ledger row tagged with internal tenant ID              │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ PSS + Swarm + Gnosis (unchanged)
                           ▼
                  T4T provider network
```

Key points:

- **One operator wallet** funds all jobs. The wallet's xBZZ float is the
  operator's working capital; the per-account "balance" is an off-chain
  ledger entry that maps onto that float.
- **One Bee node** (or a small pool) handles all postage and chunk uploads.
  Reuses `container/src/lib/stamps.ts` with the existing
  `T4T_STAMP_MANAGE=true` flow.
- **Tenancy lives above the gateway container.** The gateway container does
  not learn about end-user accounts; it just sees a single client wallet
  posting many jobs. This keeps the gateway code free of multi-tenant
  branching and means a hosted operator can horizontally scale gateway
  containers without changing them.
- **Job → tenant attribution** lives in the hosted ledger. The hosted proxy
  tags each upstream request with an internal correlation ID and watches the
  corresponding `JobPosted`/`JobClaimed` events from the gateway container's
  existing admin DB to settle the tenant's balance once the on-chain cost is
  known.

## Payment / credit model

End users buy USD-denominated credits via Stripe. The operator buys xBZZ on
the open market (or via the existing on-chain liquidity path). Per-request
billing flow:

1. **Pre-flight**: estimate cost from selected provider's `inputPrice` +
   `outputPrice` × requested `max_tokens` (plus operator margin and slippage
   buffer). Reject the request if the account's USD balance is below this
   estimate.
2. **Lock**: reserve the estimated USD on the account ledger (pending row).
3. **On-chain settlement**: gateway container does its normal `postJob` →
   `claimJob`. Actual xBZZ paid is read from the `JobClaimed` event.
4. **Post-flight**: convert actual xBZZ to USD at a price the operator
   commits to per-billing-period (e.g. daily snapshot + spread), apply
   margin, debit the ledger, release the lock.
5. **Failure**: if `cancelJob`/`timeoutJob` fires, the gateway is refunded
   on-chain (minus its own gas). The hosted ledger refunds the user's lock
   in full and absorbs the gas as operator cost. The slash burn (`spec.md`
   §4.2) is unaffected by this flow.

Pricing transparency: the dashboard shows both the USD billed and the
underlying xBZZ used per request, so users can sanity-check the markup.

## Trust deltas vs self-hosted

The hosted gateway adds a trust hub that the self-hosted gateway avoids.
This must be documented explicitly so users can make an informed choice.
What changes when you use the hosted gateway instead of running your own:

| Concern | Self-hosted gateway | Hosted gateway |
|---|---|---|
| Prompt visibility | Decrypted only inside your container | Decrypted inside the operator's gateway container |
| Wallet key custody | You hold the key | Operator holds the key |
| Payment surface | xBZZ + xDAI on Gnosis | Credit card / fiat |
| Censorship resistance | None at the gateway layer; provider can decline | Operator can suspend an account |
| Compliance exposure | None (you transact directly) | Operator complies with payment-processor and local law |
| Identity | Pseudonymous (wallet address) | Operator-known (email + card) |

The provider-side trust model is unchanged: providers always operate the
inference node and can see prompts they serve, per `spec.md` §9. The hosted
gateway is one additional intermediate party that *also* sees the prompts on
the way past. This is the same trade-off Web2 inference APIs make today —
flagged here so users see it stated, not hidden.

The hosted gateway should publish:

- A privacy policy covering log retention (default: 30-day rolling, no
  prompt/response storage unless explicitly opted in per account).
- A terms-of-service with abuse handling, suspension policy, refund policy.
- A status page covering gateway uptime and Bee / RPC health.

## Privacy defaults

- Prompts and responses are **never** persisted by default. The hosted ledger
  records job IDs, model IDs, token counts, USD amounts — no payload bodies.
- Per-account opt-in to payload logging (e.g. for debugging) is allowed, with
  a clear retention TTL (default 7 days) and a one-click "purge all" affordance.
- Aggregate usage analytics (per-day spend, per-model counts) are computed
  from the ledger, not from payloads.
- The hosted gateway's wallet activity is on-chain and public — anyone can
  see total xBZZ throughput, but cannot link a specific job back to a
  specific end-user account.

## Compliance surface

This is the section most likely to kill the project for an unprepared
operator. The hosted gateway is a fiat-in, crypto-mediated service, which
puts it adjacent to money-transmitter regimes in several jurisdictions.
Sketch of what an operator has to think about, **not legal advice**:

- **Stripe ToS**: confirm the merchant category code and that "AI inference
  credits backed by crypto" is acceptable. Stripe has refused similar
  models; have a backup processor.
- **Money transmission**: in the US, holding customer USD against later
  crypto-denominated spend may trigger MTL requirements. Keeping balances
  small (per-account cap, e.g. $200) and treating credits as
  pre-paid-services (not stored value) is the usual mitigation. Talk to a
  lawyer in your operating jurisdiction.
- **Sanctions / OFAC**: geo-block at signup; reject API keys originating
  from sanctioned regions. Stripe handles this for payment but the gateway
  must enforce it on the API surface too.
- **Tax**: gateway revenue (markup) is operator income. Per-jurisdiction
  VAT/GST applies on the user's side.
- **Abuse**: rate limits, per-account spend caps, model-level safety filters
  (or explicit acknowledgement that this is uncensored inference and the
  operator passes the input through). Suspension policy needs to be visible
  on the ToS page before signup.

None of this is exotic — it is the same compliance surface any Web2 AI API
provider already deals with. The point is that running the hosted gateway is
qualitatively a different operation from running a self-hosted gateway, and
the docs should not pretend otherwise.

## Config

New env vars are scoped to the `hosted/` service, not the existing gateway
container. The gateway container itself is unchanged.

| Var | Meaning |
|---|---|
| `HOSTED_DB_URL` | Postgres (account ledger; SQLite isn't enough for multi-process) |
| `HOSTED_STRIPE_SECRET` | Stripe API key |
| `HOSTED_STRIPE_WEBHOOK_SECRET` | Stripe webhook signature verification |
| `HOSTED_GATEWAY_INTERNAL_URL` | Where to reach the operator's `modes/gateway` container(s) |
| `HOSTED_USD_PER_XBZZ` | Pricing snapshot used by the billing engine, refreshed daily |
| `HOSTED_MARGIN_BPS` | Operator margin in basis points (e.g. `2000` = 20%) |
| `HOSTED_MIN_TOPUP_USD` | Minimum top-up (e.g. `10.00`) |
| `HOSTED_PER_KEY_RATE_LIMIT_RPS` | Default per-key rate limit |
| `HOSTED_GEO_BLOCKLIST` | Comma list of country codes to refuse signup from |

The existing `T4T_*` vars on the gateway container keep their current
meanings — `WALLET_KEY`, `BEE_API_URL`, `GNOSIS_RPC_URL`, etc. are operator-
facing config of the engine layer.

## Where the code lives

- New package: `hosted/` at the repo root, sibling to `container/` and
  `contracts/`. Node/TypeScript, same toolchain as the container so existing
  contributors don't need a new runtime.
  - `hosted/src/auth/` — API key store, hashing (argon2id), per-account
    quotas. Keys are stored as `t4t_live_<base32>` with the secret hashed at
    rest; the prefix is shown in the dashboard for identification.
  - `hosted/src/billing/` — Stripe integration (intents, webhooks, refunds),
    ledger writes, xBZZ→USD pricing.
  - `hosted/src/proxy/` — Express handlers for `/v1/*` that auth, debit, and
    forward into the gateway container's existing OpenAI endpoint.
  - `hosted/src/dashboard/` — Express + HTMX dashboard, same stack as the
    existing admin UI (`container/src/modes/gateway/admin.ts`).
  - `hosted/test/` — Vitest, hermetic, mocks Stripe and the gateway.
- Internal API on the gateway container: a small authenticated `/internal/v1/*`
  surface that mirrors `/v1/*` but accepts a tenant correlation ID header.
  Lives in `container/src/modes/gateway/internal.ts`. Bound to a private
  interface only; the public `/v1/*` endpoint still works for self-hosted
  users.
- Docs: this proposal plus a new `docs/getting-started-hosted-user.md` (for
  end users — short, screenshots) and `docs/operating-hosted-gateway.md` (for
  operators wanting to stand up their own — long, covers compliance).

## Prior art

The shape of this is not novel — it is the combination of two existing
patterns the ecosystem already understands:

- **OpenRouter** (and similar: Together, Fireworks, Replicate) — aggregates
  many inference providers behind a unified OpenAI-compatible API, sells
  pay-per-token credits in USD, attaches per-model pricing and provider
  metadata. This is the *user-facing* shape of the hosted gateway.
- **Infura** (and similar: Alchemy, QuickNode, Pinata for IPFS) — hosts the
  infrastructure (Ethereum node, IPFS pinning) so dApp developers do not
  have to operate their own, while the underlying protocol (Ethereum, IPFS)
  stays decentralized and the hosted endpoint stays optional. This is the
  *protocol-relationship* shape of the hosted gateway.

T4T already has the OpenRouter-side surface — `modes/gateway/server.ts`
exposes `/v1/chat/completions` and `/v1/models` aggregating across
providers. What is missing is the Infura-side framing: a single operator
running that surface as a hosted service that abstracts the chain and
storage layer from end users entirely. This proposal fills that gap without
changing the protocol underneath.

## Coexistence with self-hosted

The two paths should be visible and clearly distinguished in the README:

- **Self-hosted gateway** — `docs/getting-started-gateway.md`. No
  intermediaries. You hold the wallet. Recommended for power users,
  developers, and anyone who wants the protocol's trust posture intact.
- **Hosted gateway** — `docs/getting-started-hosted-user.md`. Credit card,
  API key, no wallet. Recommended for app developers and casual users who
  treat T4T as an inference endpoint, not a protocol.

Both terminate at the same provider network. The hosted gateway should never
become a *preferred* path in protocol docs — it is an accessibility ramp, not
the canonical UX. Concretely: `spec.md` and `architecture.md` do not
reference it; only the README and a top-level "How do I use this?" page do.

## Operator decentralization

One hosted gateway run by the core team is a single point of failure and
censorship. Two design choices keep that bearable:

- The hosted layer is a thin shell over the public gateway container. Anyone
  can stand up their own hosted gateway with their own Stripe account and
  user base — there is no protocol-level permission required.
- The README should list known hosted gateway operators (once there is more
  than one) so users can choose where to onboard. The `website/` provider
  directory is the natural place to add this.

This mirrors the email-provider model: SMTP is the protocol; Gmail,
Fastmail, and self-hosted Postfix all coexist on top of it. T4T's protocol
is `ProviderRegistry` + `JobEscrow`; the hosted gateway is one operator's
Gmail.

## Open questions

- **Pricing oracle**: should the hosted gateway use a public xBZZ/USD price
  feed (if/when one exists), an operator-set snapshot, or a hybrid (oracle
  with a spread)? Snapshot is simplest for v1; oracle is fairer long-term.
- **Refund granularity**: do users get USD refunds for slashed jobs, or only
  credit? Credit is simpler; USD refund needs Stripe refund flow per job and
  may hit per-transaction minimums.
- **Streaming**: the gateway's `T4T_FAKE_STREAMING=true` mode (see
  `spec.md` §7.2) emits SSE chunks rapidly after the full response arrives.
  Hosted gateway inherits this; should it advertise stream support honestly,
  or relay the fake-streaming behaviour? Lean toward honest documentation in
  the dashboard plus a "real streaming not supported in v1" note.
- **Multi-region**: one operator running gateways in EU + US for latency
  needs job correlation across regions. Easiest is per-region accounts
  (user picks a region at signup); harder is global accounts with regional
  routing.
- **Account recovery**: with no wallet, account recovery is just email-
  based password reset. Document this clearly so users do not assume
  crypto-grade key loss semantics.
- **Bulk / enterprise**: do enterprise users get committed-spend discounts,
  invoiced billing, dedicated providers? Out of scope for v1 but worth
  flagging so the schema leaves room.

## Milestone fit

- **Phase 1 — credits-only proxy**. Hosted layer in front of one gateway
  container. Stripe top-up + API key + per-request debit. No dashboard
  beyond balance and recent-request list. Lands anytime after M2 (contracts
  hardened) — earlier carries unnecessary risk that on-chain semantics still
  shift.
- **Phase 2 — production polish**. Per-key spend caps and model allowlists,
  proper dashboard with usage analytics, status page, per-region gateway
  pool, refund automation. Lands during M4 (slashing live) so failure flows
  are exercised against real refund paths.
- **Phase 3 — operator playbook**. Public docs for standing up a competing
  hosted gateway (`docs/operating-hosted-gateway.md`), conformance checklist,
  reference Terraform / Helm. Lands on or after M5 (mainnet candidate).

Nothing in Phase 1 requires contract changes. The proposal is implementable
entirely as a new package (`hosted/`) plus a small internal surface on the
existing gateway container.
