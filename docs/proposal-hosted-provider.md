# Proposal — hosted-bridge provider mode

> **Status:** draft. Companion to `proposal-centralized-gateway.md`:
> that one abstracts the chain and storage away from end *users*; this one
> abstracts the GPU away from *operators*. Both are accessibility ramps
> on top of the unchanged protocol.

Today, running a T4T provider requires a GPU you operate yourself — a local
Ollama, vLLM, or llama.cpp serving open-weight models. That is the point of
the network: anyone with hardware can sell tokens for xBZZ without a
gatekeeper. It also caps the model menu to whatever runs on prosumer GPUs.
`llama3:8b`, `qwen2.5:7b`, and friends are useful, but a client who wants
`gpt-4o`, `claude-sonnet-4.5`, or `o4-mini` is out of luck on T4T today and
goes back to OpenAI direct.

This proposal adds a **hosted-bridge provider** mode: a `T4T_MODE=provider`
container that doesn't drive a local GPU at all, but instead proxies jobs
to an OpenAI-compatible upstream the operator pays for (OpenAI, Azure
OpenAI, OpenRouter, LiteLLM in front of anything, …) and resells per-token
capacity for xBZZ on the T4T network. The container handles the same
on-chain registration, escrow, and claim flow as a GPU-backed provider —
only the inference backend differs.

This is **strictly additive**: the GPU-backed provider in
`container/src/modes/provider/` remains the canonical path and the only
one that gives end-to-end provider-side privacy. Hosted-bridge providers
are flagged on-chain so clients and gateways can see them and decide.

## Goals

- Expand the T4T model catalogue to include frontier closed-weight models
  without forking the protocol or running them in-house.
- Reuse `modes/provider` as the engine; add only a config flag, model
  allow-list, and per-model pricing — no new code paths for the hot path.
- Make hosted-bridge providers **discoverable as such** on-chain so clients
  who want decentralized inference can filter them out, and clients who
  specifically want a particular hosted model can find them.
- Keep the on-chain and PSS surface untouched. The gateway side gains an
  opt-in filter; clients with no opinion see the union.
- Document the trust deltas plainly — ToS risk and privacy regression are
  real and they sit with the bridge operator, not the protocol.

## Non-goals

- Building a non-OpenAI-compatible upstream adapter in v1. Anthropic
  (`/v1/messages`) and Bedrock (SigV4 + per-model request shapes) need real
  translation layers and are deferred. OpenAI-compatible upstreams (OpenAI,
  Azure OpenAI, OpenRouter, LiteLLM, Groq, Together, Fireworks, llama.cpp
  in proxy mode, …) cover the whole user-facing model menu via OpenRouter
  alone, so v1 ships value without that work.
- Solving upstream-ToS compliance for the operator. OpenAI explicitly
  forbids reselling API access; Anthropic and most clouds are similar.
  The bridge mode is a tool, not a policy — the operator carries the legal
  and account-ban risk and the docs say so clearly.
- Improving provider-side privacy. A hosted bridge necessarily decrypts the
  prompt and forwards it cleartext to a third-party upstream. This is the
  same trade-off any Web2 API user already makes — but it is a regression
  vs the GPU-backed provider story and is flagged accordingly.
- Acting as a payment hub. The bridge operator pays the upstream in USD
  and receives xBZZ from the protocol. Conversion is the operator's
  problem — same as the centralized-gateway proposal.

## UX

### Operator (the bridge)

1. Operator has an OpenAI (or Azure OpenAI / OpenRouter / …) account with
   a funded API key.
2. Operator launches the provider container with:
   ```
   T4T_MODE=provider
   T4T_HOSTED=true
   T4T_HOSTED_UPSTREAM=openai          # label for the registry metadata
   OPENAI_BASE_URL=https://api.openai.com/v1
   OPENAI_API_KEY=sk-…
   T4T_MODEL_ALLOW=gpt-4o,gpt-4o-mini,o4-mini
   T4T_MODEL_PRICES='{"gpt-4o":{"in":"50000000000000000","out":"150000000000000000"}, …}'
   ```
3. On boot the container does its normal `register` flow, with
   `metadataURI = JSON.stringify({hosted: true, upstream: "openai"})`.
4. `listModels()` against `OPENAI_BASE_URL/v1/models` is filtered against
   `T4T_MODEL_ALLOW`; the survivors are published to
   `ProviderRegistry.updateOfferings` at the per-model prices.
5. The admin UI's "Offerings" panel marks the provider as **Hosted bridge —
   OpenAI** and shows the operator's per-model markup vs upstream cost
   (operator-supplied, since the container can't query Stripe).
6. Jobs flow exactly as today: PSS notify → fetch+decrypt prompt from Swarm
   → forward to upstream → upload encrypted response to Swarm → `claimJob`
   with actual token counts from the upstream's `usage` field.

There is no GPU, no Ollama, no vLLM. The Bee node, postage batch, and
Gnosis wallet are unchanged.

### Client

1. The gateway's `GET /v1/models` aggregates as today. Hosted-backed models
   show up alongside GPU-backed ones in the union.
2. The admin UI surfaces per-model "providers offering this" with a
   **Hosted** chip on bridge providers, so the user can see whether
   `llama3:8b` is being served by community GPUs or by an OpenRouter
   bridge.
3. Client opts in to a hosted filter via gateway env:
   `T4T_HOSTED_PROVIDERS=allow|deny|only` (default `allow`).
   - `allow` — union (today's behaviour, hosted providers visible).
   - `deny` — drop hosted providers; pure decentralized inference only.
   - `only` — drop GPU-backed providers; useful for "give me frontier
     models or nothing."
4. Per-request behaviour is identical to today. The on-chain selector
   already routes by price + reputation; hosted providers just compete on
   the same axes, with `metadataURI` available as a filter dimension.

## Architecture

The hosted-bridge mode reuses the existing provider container almost
entirely. The OpenAI-compatible client in `container/src/lib/inference.ts`
already speaks the right protocol against any upstream — the work is in
policy: who advertises, at what price, with what flag.

```
┌──────────────────────────────────────────────────────────────────────┐
│  T4T client / gateway                                                │
│   └── PSS notify, Swarm-uploaded encrypted prompt, postJob escrow    │
└──────────────────────────┬───────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  modes/provider (unchanged hot path)                                 │
│   ├── listener / worker / claim   (per docs/architecture.md)         │
│   └── InferenceClient → OPENAI_BASE_URL                              │
│                                                                       │
│  NEW policy layer (boot + heartbeat only, not per-request):          │
│   ├── filter listModels() by T4T_MODEL_ALLOW                         │
│   ├── per-model price overrides from T4T_MODEL_PRICES                │
│   └── metadataURI = {hosted, upstream} at register()                 │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ OpenAI-compatible HTTP, Bearer api-key
                           ▼
                  OpenAI / Azure OpenAI / OpenRouter / LiteLLM
```

Key points:

- **The hot path doesn't branch.** `worker.ts` already calls
  `inference.chatCompletion(req)` and reads `usage.prompt_tokens` /
  `completion_tokens` for settlement. OpenAI populates these honestly;
  LiteLLM and OpenRouter preserve them. No new code there.
- **Registration is the only on-chain difference.** `metadataURI`
  goes from `''` to a JSON blob; the field has been reserved for this
  purpose in `ProviderRegistry.sol` since day one but never used.
- **Allow-list is mandatory in hosted mode.** OpenAI's `/v1/models`
  returns ~50 entries including embeddings (`text-embedding-3-large`),
  TTS (`tts-1`), Whisper, image-gen (`dall-e-3`), and legacy completions
  models. Auto-advertising the lot would publish offerings the provider
  cannot fulfil via chat-completions and every job to those models would
  fail. Config validation refuses to start `T4T_HOSTED=true` without
  `T4T_MODEL_ALLOW`.
- **Per-model pricing is mandatory in practice.** A single
  `T4T_INPUT_PRICE_DEFAULT` works fine when every model is a 7B-class
  open weight; it does not work when one operator advertises both
  `gpt-4o-mini` (~$0.15/1M in) and `gpt-4o` (~$5/1M in). The
  `T4T_MODEL_PRICES` JSON map sets per-model in/out wei-per-million; the
  admin UI's existing per-offering price editor still works for
  fine-tuning afterwards.
- **Gateway filter is one config var.** `T4T_HOSTED_PROVIDERS` filters
  the scan in `modes/gateway/models.ts` after parsing each provider's
  `metadataURI`. No new RPC calls; the data is already in the page
  returned by `listProviders`.

## On-chain surface

The proposal needs **no contract changes for v1**. `metadataURI` is a
`string` field on the existing `Provider` struct
(`contracts/src/ProviderRegistry.sol`:11-21), populated at `register()`
and currently always set to `''`. v1 simply uses it.

Trade-off: `metadataURI` is set once at `register()` and there is no
`updateMetadataURI` setter. An existing GPU-backed provider cannot
retroactively flip itself to "hosted" without `deactivate` → wait
unbonding → `withdrawStake` → re-`register` (2-day round trip). New
hosted operators are unaffected. A follow-up additive contract change
(`updateMetadataURI(string)` callable by the provider owner) is
recommended but out of scope for v1 — it requires a redeploy and a
registry-address rollover, which the centralized-gateway proposal and
on-chain-reviews proposal will also benefit from batching against.

The `metadataURI` payload is a small JSON object, stored inline rather
than as a Swarm reference, since it's well under the 32-byte SSTORE
threshold to amortise — typical:
```json
{"hosted": true, "upstream": "openai"}
```
Parsing is tolerant: empty string, non-JSON, or missing `hosted` field
all decode to `{hosted: false}` (today's GPU-backed providers Just Work
without re-registration).

## Trust deltas vs GPU-backed providers

The hosted-bridge mode introduces a third party (the upstream) on the
provider side of every job it serves. This must be documented explicitly
so clients see it stated, not hidden. What changes when a job lands on a
hosted-bridge provider vs a GPU-backed one:

| Concern | GPU-backed provider | Hosted-bridge provider |
|---|---|---|
| Who sees the prompt | The provider's container, in memory | The provider's container *and* the upstream (OpenAI / etc.) cleartext |
| Model identity | Whatever weights the operator loaded | Whatever the upstream serves under that name — operator can't verify |
| Reproducibility | Same weights → same outputs (modulo sampling) | Upstream can change the underlying model under a stable name |
| Censorship / abuse policy | None at the provider layer | Upstream's content policy applies |
| Outage modes | Local GPU / Ollama / vLLM | Upstream API + the local container |
| Settlement honesty | Provider claims `usage` from local backend | Provider claims `usage` from upstream — same code path, no extra trust hop on T4T side |
| Upstream ToS | N/A | Operator carries it. OpenAI explicitly prohibits reselling. |

The gateway-side `T4T_HOSTED_PROVIDERS=deny` flag is the affordance for
clients who care about the first four rows. The fifth (settlement) is
unchanged: the bridge provider claims whatever token counts the upstream
reports, just as a GPU-backed provider claims whatever its local backend
reports.

The point of stating this is not to discourage the mode — it is to keep
the protocol's honesty intact. A network that silently mixes
decentralized and Web2 inference under one model name is worse for
everyone than one that labels both clearly.

## Privacy

- Prompts are encrypted on Swarm and inside the PSS notify (today's
  behaviour, unchanged). The hosted-bridge provider decrypts the prompt
  the same way a GPU-backed provider does.
- The decrypted prompt is then forwarded **cleartext** to the upstream
  over HTTPS. The upstream's privacy policy applies from that point on.
- Responses come back cleartext over HTTPS, are encrypted, uploaded to
  Swarm, and the hash is PSS-delivered to the gateway. Same as today.
- The bridge operator MUST disclose the upstream they forward to. The
  `upstream` label in `metadataURI` is normative — operators
  misrepresenting it (e.g. labeling Azure OpenAI as "openai" or vice
  versa) is a documentation lie, and the docs treat it as such. There is
  no on-chain way to verify the claim; the registry is a directory, not
  an attestation system.

## Legal / ToS surface

This is the section most likely to bite an unprepared operator. The
hosted-bridge mode is a thin wrapper over reselling third-party API
access. Sketch of what an operator has to think about — **not legal
advice**:

- **OpenAI ToS** (as of 2026-05): "You will not… (k) buy, sell, or
  transfer API keys without our prior consent." Reselling per-token
  capacity through a bridge is exactly this. Practical posture: assume
  OpenAI can and will terminate the account if/when they notice; do not
  bet the bridge on a single upstream account; treat this as a
  permissionless market for "I'm willing to share my subscription"
  rather than a business.
- **Anthropic, Azure OpenAI, Google Vertex**: similar restrictions. Each
  upstream has its own clause; the docs link to the current text.
- **OpenRouter, LiteLLM**: these are themselves aggregators of upstreams
  and may have more permissive resale terms — but they're also a layer
  of trust the operator now relies on for token-count honesty. Recommend
  but do not require these as the upstream of choice.
- **Sanctions / OFAC**: if the bridge operator is in a jurisdiction
  where serving sanctioned end-users would be a problem, note that the
  gateway → provider flow is anonymous beyond the gateway's wallet
  address. The bridge has no end-user identity to enforce on; opt-out is
  via not running the bridge.
- **Tax**: xBZZ earned by the bridge is operator income, same as for a
  GPU-backed provider.

None of this is the protocol's problem. The docs name it because
running a bridge is a qualitatively different operation from running a
GPU and the getting-started guide should not pretend otherwise.

## Config

New env vars are all scoped to the existing provider container. The
gateway gains one filter var. No new modes, no new processes.

### Provider (`T4T_MODE=provider`)

| Var | Meaning | Default |
|---|---|---|
| `T4T_HOSTED` | `true` to register as a hosted bridge | `false` |
| `T4T_HOSTED_UPSTREAM` | Free-text label written into `metadataURI` (`openai`, `azure-openai`, `openrouter`, `litellm`, …) | `openai` |
| `T4T_MODEL_ALLOW` | CSV of model IDs the bridge will advertise. **Required when `T4T_HOSTED=true`.** | (unset) |
| `T4T_MODEL_PRICES` | JSON map of per-model overrides: `{"<id>":{"in":"<wei/1M>","out":"<wei/1M>"}}`. Applied to newly-seen models at first registration; admin UI edits override afterwards. | (unset) |

`OPENAI_BASE_URL`, `OPENAI_API_KEY`, `T4T_INPUT_PRICE_DEFAULT`, and
`T4T_OUTPUT_PRICE_DEFAULT` keep their current meanings. In hosted mode
`OPENAI_BASE_URL` points at the upstream, `OPENAI_API_KEY` carries the
upstream API key, and the `*_PRICE_DEFAULT` vars become last-resort
fallbacks if `T4T_MODEL_PRICES` doesn't cover a listed model.

### Gateway (`T4T_MODE=gateway`)

| Var | Meaning | Default |
|---|---|---|
| `T4T_HOSTED_PROVIDERS` | `allow`, `deny`, or `only` — filter providers by `metadataURI.hosted` | `allow` (today's behaviour) |

## Where the code lives

- New module: `container/src/lib/provider-metadata.ts` — tiny
  `encode/parseProviderMetadata` helpers. Tolerant parser: empty string
  or non-JSON returns `{hosted: false}`.
- Provider wiring: `container/src/modes/provider/index.ts` — apply the
  allow-list filter to `inference.listModels()` output (boot and
  `healthTick`), look up `T4T_MODEL_PRICES` when building the offering
  for a first-seen model, and pass the encoded metadata to
  `registerProvider`.
- Provider config: extend the `Provider` zod schema in
  `container/src/lib/config.ts` with the new vars. Refine: if
  `T4T_HOSTED=true` then `T4T_MODEL_ALLOW` must be non-empty.
- Gateway config: extend the `Gateway` zod schema with
  `T4T_HOSTED_PROVIDERS`.
- Gateway wiring: `container/src/modes/gateway/models.ts` — parse
  `metadataURI` per provider in the `scan()` loop; filter by the new
  flag before merging offerings.
- Admin UI (provider): show a "Hosted bridge — &lt;upstream&gt;" badge in
  the Offerings panel when `T4T_HOSTED=true`.
- Admin UI (gateway): tag each provider in the directory with a
  **Hosted** chip when applicable, mirroring how the model summary view
  already shows `providerCount`.
- Docs: this proposal, plus a new
  `docs/getting-started-provider-hosted.md` covering the upstream-ToS
  disclaimer, env-var reference, and a USD→xBZZ pricing helper formula
  with worked examples for `gpt-4o` and `gpt-4o-mini`. README gets a
  short paragraph in the "Earn xBZZ" section linking to it.

## Tests

Existing test style is Vitest with hand-rolled `ChainClient` mocks
(`container/test/models.test.ts`). The new tests follow the same shape:

- `container/test/provider-metadata.test.ts` — encode/decode round-trip,
  tolerant parsing (empty, malformed, missing fields).
- `container/test/provider-hosted.test.ts` — config validation
  (`T4T_HOSTED=true` without `T4T_MODEL_ALLOW` rejects); model
  allow-list filter; `T4T_MODEL_PRICES` JSON parse; per-model price
  application during offering construction.
- Extend `container/test/models.test.ts` — gateway `hostedMode=deny`
  excludes hosted providers from `scan()`; `only` keeps just them;
  `allow` is unchanged.

No upstream HTTP mocks needed in v1 — the existing `InferenceClient`
fetch path is untouched by this proposal.

## Open questions

- **`metadataURI` mutability.** Should v1 wait on an additive
  `updateMetadataURI` contract change so existing providers can flip the
  hosted flag without re-registration? Leaning no — new bridges register
  fresh, and the contract change is better batched with the next
  registry rollover (see also `proposal-onchain-reviews.md`,
  `proposal-centralized-gateway.md`).
- **`upstream` label whitelist.** Free text is the lightest path and
  matches today's "providers can lie in the registry, reputation
  punishes them" posture. Alternative: a normative set of upstream IDs
  in the docs so the admin UI can render known logos / pricing
  references. v1 keeps free text; the docs publish a recommended list.
- **Pricing helper.** A "fetch OpenAI's public pricing and suggest
  xBZZ/1M markups at a given margin" CLI subcommand would lower the
  setup friction substantially. Out of scope for v1 — operators set
  prices manually and the docs ship a static conversion table.
- **Anthropic upstream.** `/v1/messages` is incompatible with
  `/v1/chat/completions` at the wire level. A real adapter (system-prompt
  translation, content-block flattening, `usage` field reshaping) is a
  meaningful chunk of work and deserves its own proposal. v1 punts it.
- **Bedrock upstream.** SigV4 auth plus per-model request shapes
  (Anthropic-on-Bedrock vs Llama-on-Bedrock vs Titan are all different).
  Same answer — deferred to a separate proposal.
- **Multi-account upstreams.** Should one bridge container be able to
  round-robin across multiple upstream API keys for higher throughput /
  lower per-key spend caps? Deferred. Today's container is one process,
  one upstream URL, one key — operators wanting more keys run more
  containers with different wallets.
- **Streaming honesty.** `inference.ts` already disables streaming over
  the wire (`stream: false`) and the gateway fakes SSE upstream. Hosted
  bridges inherit this. Operators who want true upstream streaming
  benefit nothing from it under today's gateway behaviour; revisit when
  the gateway adds real streaming.

## Milestone fit

- **Phase 1 — provider hosted mode + gateway filter.** Config schema,
  allow-list filter, per-model pricing, metadata encoder/decoder,
  gateway-side `hostedMode`. Lands anytime — no contract change.
- **Phase 2 — admin UX.** Hosted badge in both admin UIs, pricing
  helper CLI subcommand, docs polish. Lands after Phase 1 is in
  production and at least one operator has stood up an OpenRouter bridge
  for feedback.
- **Phase 3 — non-OpenAI upstreams.** Anthropic adapter, then Bedrock.
  Each is its own proposal (`proposal-bridge-anthropic.md`, …) with its
  own protocol risk assessment. Lands as a separate work stream.
- **Phase 4 — `updateMetadataURI` contract change.** Batched with the
  next contract rollover (centralized gateway, on-chain reviews).
  Strictly additive on the contract side; backwards-compatible in
  TypeScript.

Phase 1 is the entire MVP. Everything else is sequencing.

## Coexistence with GPU-backed providers

Both modes should be visible and clearly distinguished in the README and
in the provider getting-started flow:

- **GPU-backed provider** — `docs/getting-started-provider.md`. You hold
  the weights and the GPU. Lower model menu, lower trust footprint,
  protocol-aligned. Recommended for anyone with hardware sitting idle.
- **Hosted-bridge provider** — `docs/getting-started-provider-hosted.md`.
  You hold an upstream API subscription. Frontier model menu, third-party
  privacy footprint, ToS-adjacent. Recommended for operators who want to
  expand the network's catalogue without buying GPUs.

Both publish offerings to the same `ProviderRegistry`. The gateway-side
filter and the admin-UI badging are what keep them honest. The protocol
underneath does not change.

The framing mirrors `proposal-centralized-gateway.md`: the canonical
path stays trust-minimised; the accessibility path is honest about what
it trades away. T4T's protocol is `ProviderRegistry` + `JobEscrow`. A
GPU-backed Ollama provider and an OpenAI-bridge provider are two
implementations of the same role on top of it.
