# Proposal — on-chain provider reviews

Today T4T has no on-chain reputation. Per `docs/spec.md` §8, output quality is
"policed by client switching" and the only signal a client has when picking a
provider is the registry's `ModelOffering` list and liveness state. There is no
way for a client to tell a community-trusted operator from a freshly-funded
one.

This proposal adds a thin, **proof-of-customer-gated** review primitive: any
address that has settled a `claimJob` against a provider can leave one signed
up/down vote plus an optional free-text comment (stored on Swarm, pointed to
from chain). Reviews are a UX-layer signal feeding the client selector and the
website provider directory. They do **not** replace liveness slashing and they
are **not** a cryptographic proof of model identity (see `docs/spec.md` §9 bullet
on model-identity honesty).

## Goals

- Give clients a track-record signal beyond raw liveness when choosing a
  provider for a given model.
- Make review submission cheap (one tx, short calldata) and resistant to the
  most obvious Sybil and astroturfing attacks.
- Surface aggregate scores in the existing admin UI and `website/` directory
  without a separate backend.
- Stay strictly additive: providers and clients that ignore reviews still get
  exactly the v1 flow.

## Non-goals

- Replacing slashing, stake bonding, or the §8 reputation work scheduled for
  M4. Reviews are advisory, not punitive in v1.
- Cryptographic proof of model identity, output correctness, or honest
  pricing. Those remain deferred per spec §10.
- Dispute resolution / appeals UI. Out of scope for the first cut — providers
  can publicly respond by leaving a reply (same gated primitive) but there is
  no on-chain takedown.
- Stake-weighted or token-weighted voting. Flat one-vote-per-settled-job; see
  Sybil resistance below.

## UX

1. After a successful `claimJob`, the client container shows a non-blocking
   prompt in `/admin/jobs/:id`: **"Rate this job"** with up / neutral / down
   buttons and an optional comment textarea.
2. On submit the container:
   - If a comment was entered, uploads it as a UTF-8 chunk to Swarm via the
     existing managed stamp; records the returned reference.
   - Calls `ReviewRegistry.submitReview(jobId, score, swarmRef)` on Gnosis
     Chain. Contract verifies (a) `msg.sender` is the `client` recorded in
     `JobEscrow.jobs[jobId]`, (b) the job is in `Claimed` state, (c) no prior
     review exists for that `jobId`.
3. Admin UI **Reviews** tab (both modes):
   - Provider mode shows reviews left *about* this provider with reply
     affordance (provider can submit one Swarm-hosted reply per review, keyed
     on the original `jobId`; replies do not change the score).
   - Client mode shows reviews this wallet has left, with edit-window
     behaviour (see Safety below).
4. `website/` provider directory shows per-provider aggregates: total reviews,
   up-vote ratio, recent-window ratio (last 30 days), and the most recent N
   comments. Pulled directly from on-chain events, no backend required.
5. Client selector (`container/src/modes/client/selector.ts`) optionally
   filters or ranks by `min-up-ratio` and `min-reviews` thresholds set via
   env. Default thresholds are zero so existing flows are unaffected.

## Contract surface

New contract `contracts/src/ReviewRegistry.sol`. Lives alongside
`ProviderRegistry` and `JobEscrow`; reads `JobEscrow` to enforce
proof-of-customer.

```solidity
enum Score { Down, Neutral, Up } // -1 / 0 / +1

struct Review {
    address reviewer;        // == JobEscrow.jobs[jobId].client
    address provider;        // == JobEscrow.jobs[jobId].provider
    bytes32 jobId;
    Score   score;
    bytes32 swarmRef;        // optional comment body; bytes32(0) if none
    uint64  ts;
}

event ReviewSubmitted(address indexed provider, address indexed reviewer, bytes32 indexed jobId, Score score, bytes32 swarmRef);
event ReviewReplied(address indexed provider, bytes32 indexed jobId, bytes32 swarmRef);
event ReviewRetracted(bytes32 indexed jobId);
```

Methods:

- `submitReview(bytes32 jobId, Score score, bytes32 swarmRef)` — client only,
  job must be `Claimed`, one per `jobId`.
- `replyToReview(bytes32 jobId, bytes32 swarmRef)` — provider only, requires
  an existing review on that `jobId`, one reply per review.
- `retractReview(bytes32 jobId)` — client only, callable within
  `RETRACT_WINDOW` (default 7 days) of submission. Sets score to `Neutral` and
  clears `swarmRef`; keeps the row so reply references stay valid.

Aggregation lives off-chain (admin UI / website) via event indexing. The
contract itself stores only the latest row per `jobId` to keep gas bounded.

## Sybil resistance

The only Sybil defence that matters here is **proof-of-customer**: the
reviewer must be the `client` field on a `Claimed` job in `JobEscrow`, and
each `jobId` admits exactly one review. This naturally rate-limits attackers
because every fake review costs at least one full inference job (xBZZ fee +
gas, paid net-of-treasury-cut). Self-reviews are still possible — a provider
funds a client wallet and runs throwaway jobs against itself — but every such
review costs the provider real xBZZ that leaves their balance sheet (treasury
cut), so this is a tax, not a free attack. We do **not** add stake-weighting,
identity proofs, or KYC.

## Known abuse paths (documented, not solved in v1)

- **Bribery**: provider offers fee rebates in exchange for up-votes. Not
  preventable on-chain; surfaces over time as up-ratio decoupling from repeat
  business.
- **Extortion**: client threatens a down-vote unless the provider refunds.
  Mitigated weakly by the 7-day `RETRACT_WINDOW` (provider can ask the client
  to retract, but cannot compel it).
- **Review-bombing by competitors**: another provider's operator funds client
  wallets and runs jobs against a rival to leave down-votes. Same Sybil tax
  as self-review; surfaces in the recent-window ratio if it spikes.
- **Comment spam / illegal content**: `swarmRef` is Swarm-hosted free text.
  The client and website render layers must escape HTML and offer a "report"
  link. Removal is impossible at the chain layer (and out of scope); the
  website may maintain a client-side blocklist of `jobId`s.

These are all called out so reviewers and operators set expectations
correctly — reviews are a noisy signal, not a verdict.

## Safety / idempotency rules

- Never allow a second review for the same `jobId`. Re-submission silently
  reverts via `revert AlreadyReviewed()`.
- `submitReview` reverts if the job is not in `Claimed` state — no reviews
  for cancelled / timed-out jobs (those already produced slashing).
- `retractReview` is the only post-submission mutation a client has, and it
  expires after `RETRACT_WINDOW`. No edit-to-the-text after retract — they
  resubmit by waiting for the next job.
- Provider replies are one-shot per review and immutable. Avoids back-and-
  forth flame threads on-chain.
- Container never auto-submits a review without an explicit UI click. Even
  with `T4T_REVIEW_AUTOPROMPT=true` the click is required.
- Comment uploads use the same managed-stamp path as request/response chunks
  (`docs/proposal-container-managed-stamps.md`). Failed upload aborts the
  whole flow — never submit an on-chain review pointing to a missing chunk.

## Config

| Var | Meaning | Default |
|---|---|---|
| `T4T_REVIEW_ENABLED` | Show review UI in admin; opt-in initially | `false` |
| `T4T_REVIEW_AUTOPROMPT` | Auto-open the rate-this-job panel on claim | `true` (when enabled) |
| `T4T_REVIEW_MIN_UP_RATIO` | Selector filter: drop providers below ratio | `0` (off) |
| `T4T_REVIEW_MIN_REVIEWS` | Selector filter: require at least N reviews | `0` (off) |
| `T4T_REVIEW_WINDOW_DAYS` | Recent-window for ratio calc on the directory | `30` |

`RETRACT_WINDOW` is a contract constant, not an env var (changing it would
fork the dataset).

## Where the code lives

- New contract: `contracts/src/ReviewRegistry.sol`, deployed alongside the
  existing two in `contracts/script/Deploy.s.sol`.
- New tests: `contracts/test/ReviewRegistry.t.sol` covering proof-of-customer
  enforcement, one-review-per-job, retract window, and reply rules. Add a
  fuzz case for replay attempts.
- New module: `container/src/lib/reviews.ts` — pure helpers for submit /
  reply / retract / aggregate, talking to `ReviewRegistry` via the existing
  ethers wiring in `container/src/lib/chain.ts`.
- Wire-up (client): `container/src/modes/client/admin.ts` mounts the rate-
  this-job panel and the "my reviews" tab.
- Wire-up (provider): `container/src/modes/provider/admin.ts` mounts the
  "reviews about me" tab with reply affordance.
- Selector hook: `container/src/modes/client/selector.ts` reads the new
  thresholds when filtering candidates.
- Website: `website/` directory page reads `ReviewSubmitted` events directly
  via a public Gnosis RPC; no new server-side component.

## Docs to update once shipped

- `docs/spec.md` §8 — replace "No off-chain rating in v1" with a pointer to
  the new contract and a brief description of the proof-of-customer
  primitive.
- `docs/spec.md` §10 — remove the "Out of Scope" entry for reputation if
  applicable.
- `docs/architecture.md` — add `ReviewRegistry` to the on-chain components
  diagram.
- `docs/getting-started-client.md` — note the new env vars and the rate-
  this-job panel.
- `docs/getting-started-provider.md` — note the reply affordance and that
  reviews surface in the website directory.
