# Token4Token (T4T) — Protocol Specification

A decentralized AI inference marketplace on Gnosis Chain + Ethereum Swarm.

Clients pay providers in **xBZZ** to run inference on locally-hosted Ollama models. Requests and responses are stored on Swarm, addressed by hash. Job coordination happens via Swarm PSS. Payment, escrow, registry, and slashing are enforced by Solidity contracts on Gnosis Chain. xDAI is used only for gas.

ENS: `t4t.eth`

---

## 1. Design Principles

- **Async first.** Inference is slow; jobs are submitted and fulfilled asynchronously. No streaming over the wire.
- **Content-addressable I/O.** Request and response payloads live on Swarm. Only hashes traverse PSS and the chain.
- **Tokens for tokens.** Clients spend xBZZ; providers earn xBZZ. xDAI only for gas. xBZZ doubles as Swarm postage currency, closing the economic loop.
- **No verifiable computation in v1.** Honesty is enforced economically: declared model, reputation, stake, and slashing on liveness failures. Output correctness is socially and statistically verified, not cryptographically proven.
- **Drop-in OpenAI compatibility.** The client container exposes an OpenAI-compatible HTTP API so existing chat apps (Open WebUI, LibreChat, Continue.dev, etc.) work unchanged.
- **Two containers, one protocol.** A single Docker image with two modes (`client` / `provider`) is the canonical way to participate.

---

## 2. Architecture Overview

```
┌─────────────────────┐         ┌─────────────────────┐
│  Chat App           │         │  Ollama             │
│  (Open WebUI, etc.) │         │  (local models)     │
└──────────┬──────────┘         └──────────▲──────────┘
           │ OpenAI HTTP                   │ HTTP
           ▼                               │
┌─────────────────────┐         ┌──────────┴──────────┐
│  T4T Client         │         │  T4T Provider       │
│  Container          │         │  Container          │
└──────────┬──────────┘         └──────────▲──────────┘
           │                               │
           │  PSS (hashes)                 │
           ├───────────────────────────────┤
           │  Swarm (request/response)     │
           ├───────────────────────────────┤
           │  Gnosis Chain (escrow, reg.)  │
           ▼                               │
   ┌───────────────┐              ┌────────┴────────┐
   │ Local Bee     │              │ Local Bee       │
   │ Local Wallet  │              │ Local Wallet    │
   └───────────────┘              └─────────────────┘
```

### Layer responsibilities

| Layer | Tech | Role |
|---|---|---|
| App | Any OpenAI-compatible client | User-facing chat / agent |
| Client container | Node/Go, OpenAI shim | Translates OpenAI ↔ T4T, selects provider, manages escrow |
| Provider container | Node/Go, Ollama wrapper | Subscribes to jobs, runs inference, returns responses |
| Transport | Swarm PSS | Job announcements, ACKs, response notifications |
| Storage | Swarm (chunks + postage stamps) | Encrypted request and response payloads |
| Payment | Gnosis Chain, xBZZ (ERC-20) | Escrow, stake, slashing |
| Gas | Gnosis Chain, xDAI | Transaction fees only |
| Discovery | `ProviderRegistry` contract | Capabilities, pricing, reputation, stake |
| Escrow | `JobEscrow` contract | Lock payment, release on delivery, slash on failure |

---

## 3. Job Lifecycle

```
Client                                   Chain                        Provider
  │                                        │                              │
  │ 1. Select provider from registry       │                              │
  │ 2. Upload encrypted request to Swarm   │                              │
  │    → requestHash                       │                              │
  │ 3. postJob(provider, requestHash,      │                              │
  │            modelId, maxXBZZ, deadline) │                              │
  │ ──────────────────────────────────────►│ JobPosted(jobId)             │
  │                                        │─────────────────────────────►│ (event)
  │ 4. PSS notify(jobId, requestHash) ────────────────────────────────────►│
  │                                        │                              │
  │ ◄─────────────────────────── 5. PSS ack(jobId) (within ACK_WINDOW)    │
  │                                        │                              │
  │                                        │   6. Fetch + decrypt request │
  │                                        │   7. Run Ollama inference    │
  │                                        │   8. Upload encrypted resp.  │
  │                                        │      → responseHash          │
  │                                        │                              │
  │ ◄────────────────────── 9. PSS deliver(jobId, responseHash)           │
  │                                        │                              │
  │                                        │  10. claimJob(jobId,         │
  │                                        │      responseHash, sig)      │
  │                                        │◄─────────────────────────────│
  │                                        │ JobClaimed(jobId)            │
  │                                        │ xBZZ → provider              │
  │                                        │                              │
  │ 11. Fetch + decrypt response           │                              │
  │ 12. Return to chat app                 │                              │
```

### Failure paths

- **No ACK within `ACK_WINDOW`** (default 30s): client calls `cancelJob(jobId)`. Client is refunded; the provider's stake is slashed and burned (see §4.2). The client gets no share of the slash — refund only.
- **ACK but no delivery within `deadline`**: client calls `timeoutJob(jobId)`. Larger slash on the same burn-only terms; refund only to the client.
- **Client never confirms / never online**: provider can still call `claimJob` with a valid `responseHash` and signature; the on-chain record is sufficient proof of delivery.
- **Network partition / disputed delivery**: heartbeat history in the registry is the tiebreaker. Out of scope for v1 dispute UI — just slash on missed deadline.

---

## 4. Smart Contracts

Solidity `^0.8.28`, Foundry. Deploy to Gnosis Chain (chain id 100) and Chiado (10200) for testing.

### 4.1 `ProviderRegistry.sol`

Public on-chain directory of providers, their capabilities, pricing, stake, and reputation.

```solidity
struct Provider {
    address owner;            // wallet
    bytes32 pssPublicKey;     // for encrypting requests
    bytes32 swarmOverlay;     // for PSS routing
    string  metadataURI;      // bzz:// hash → JSON: models, hardware, contact
    uint128 stake;            // locked xBZZ
    uint64  lastHeartbeat;    // unix seconds
    uint32  totalJobs;
    uint32  successfulJobs;
    bool    active;
}

struct ModelOffering {
    string  modelId;          // e.g. "llama3:70b-instruct-q4_K_M"
    uint128 inputPricePerMillionTokens;   // xBZZ wei per 1M prompt tokens
    uint128 outputPricePerMillionTokens;  // xBZZ wei per 1M completion tokens
    uint128 maxContextTokens;
    uint64  maxLatencySeconds; // declared SLA
}

function register(
    bytes32 pssPublicKey,
    bytes32 swarmOverlay,
    string calldata metadataURI,
    uint128 initialStake
) external;

function updateOfferings(ModelOffering[] calldata offerings) external;
function heartbeat() external;            // call ~every 5 minutes
function deactivate() external;           // start unbonding
function withdrawStake() external;        // after UNBONDING_PERIOD

// Views
function listProviders(uint256 cursor, uint256 limit)
    external view returns (Provider[] memory, uint256 nextCursor);
function getProvider(address owner) external view returns (Provider memory);
function getOfferings(address owner) external view returns (ModelOffering[] memory);

// Events
event ProviderRegistered(address indexed owner, bytes32 pssPubKey);
event Heartbeat(address indexed owner, uint64 timestamp);
event StakeSlashed(address indexed owner, uint128 amount, bytes32 indexed jobId);
event ProviderDeactivated(address indexed owner);
```

**Constants**
- `MIN_STAKE`: 100 xBZZ (tunable)
- `HEARTBEAT_TTL`: 600 seconds (provider drops from selectable set after this)
- `UNBONDING_PERIOD`: 2 days

### 4.2 `JobEscrow.sol`

Holds payment + slash collateral for each job; settles on delivery, refund, or timeout.

```solidity
enum JobStatus { Pending, Acked, Delivered, Claimed, Cancelled, TimedOut }

struct Job {
    address client;
    address provider;
    bytes32 requestHash;      // Swarm chunk reference
    bytes32 responseHash;     // set on delivery
    string  modelId;
    uint128 maxPayment;       // xBZZ escrowed by client
    uint64  postedAt;
    uint64  ackedAt;
    uint64  ackDeadline;      // postedAt + ACK_WINDOW
    uint64  deliveryDeadline; // postedAt + provider SLA
    JobStatus status;
}

function postJob(
    address provider,
    bytes32 requestHash,
    string  calldata modelId,
    uint128 maxPayment,
    uint64  deliveryDeadline
) external returns (bytes32 jobId);

function ackJob(bytes32 jobId) external;   // provider only

function claimJob(
    bytes32 jobId,
    bytes32 responseHash,
    uint128 actualPayment,    // ≤ maxPayment
    bytes calldata clientSig  // optional — speeds settlement
) external;                    // provider only

function cancelJob(bytes32 jobId) external; // client, only if !acked && now > ackDeadline
function timeoutJob(bytes32 jobId) external; // client, only if acked && now > deliveryDeadline

// Events
event JobPosted(bytes32 indexed jobId, address indexed client, address indexed provider);
event JobAcked(bytes32 indexed jobId);
event JobClaimed(bytes32 indexed jobId, bytes32 responseHash, uint128 paid);
event JobCancelled(bytes32 indexed jobId, uint128 slash);
event JobTimedOut(bytes32 indexed jobId, uint128 slash);
```

**Slashing rules**
- `cancelJob` (no ACK): slash = `min(stake, max(2 * maxPayment, MIN_SLASH))`. **100 % burned** (sent to `ProviderRegistry.BURN_ADDRESS = 0x…dEaD`). Client gets only their `maxPayment` refund — no share of the slash.
- `timeoutJob` (ACKed but undelivered): slash = `min(stake, max(3 * maxPayment, MIN_SLASH))`. Same burn-only treatment, same refund.
- `MIN_SLASH`: 1 xBZZ.

Why pure burn rather than a client apology or a protocol treasury: any payout
to either side creates an economic incentive to *make* a job fail. A client
could withhold the encrypted payload long enough to trip `cancelJob`; a
treasury-funded protocol team could be accused of the same — even if they
never act on it. Burning the slash means the only beneficiary of a failed job
is "nobody," which leaves liveness as the only path that compensates anyone.
See §9 for the threat model.

**Concurrency cap**
`postJob` reverts if `provider.openJobs * MAX_SLASH_PER_JOB > provider.stake`. Prevents oversubscription wipeout.

---

## 5. Wire Protocol

### 5.1 PSS topics

| Topic | Subscriber | Purpose |
|---|---|---|
| `t4t:provider:<address>` | provider | inbound job notifications |
| `t4t:client:<address>` | client | inbound ACKs and delivery notifications |

Topic strings are hashed per Bee PSS conventions. Address is the lowercased 0x… wallet.

### 5.2 PSS message envelope

All PSS messages share an envelope (matches SwarmChat's pattern):

```json
{
  "v": 1,
  "type": "job_notify | job_ack | job_deliver",
  "from": "0x…",
  "to":   "0x…",
  "ts":   1700000000,
  "nonce": "hex",
  "body": { … },
  "sig":  "0x…"   // EIP-191 over canonical-JSON of {v,type,from,to,ts,nonce,body}
}
```

### 5.3 Message bodies

**`job_notify`** (client → provider)
```json
{
  "jobId": "0x…",
  "requestHash": "<swarm hash>",
  "modelId": "llama3:70b-instruct-q4_K_M",
  "maxPayment": "1500000000000000000",   // wei xBZZ
  "deliveryDeadline": 1700000300
}
```

**`job_ack`** (provider → client)
```json
{ "jobId": "0x…", "estimatedCompletion": 1700000180 }
```

**`job_deliver`** (provider → client)
```json
{ "jobId": "0x…", "responseHash": "<swarm hash>" }
```

---

## 6. Swarm Payload Schemas

Both request and response are JSON, encrypted to the recipient's PSS public key, uploaded as a single Swarm chunk with a short-lived postage stamp.

### 6.1 Request payload

```json
{
  "v": 1,
  "jobId": "0x…",
  "client": "0x…",
  "modelId": "llama3:70b-instruct-q4_K_M",
  "openaiRequest": {
    "model": "llama3:70b-instruct-q4_K_M",
    "messages": [ { "role": "user", "content": "…" } ],
    "temperature": 0.7,
    "max_tokens": 1024
  },
  "clientPssPubKey": "0x…",
  "ts": 1700000000
}
```

The `openaiRequest` field is a verbatim OpenAI `/v1/chat/completions` payload — providers feed it to Ollama's OpenAI-compatible endpoint with no translation.

### 6.2 Response payload

```json
{
  "v": 1,
  "jobId": "0x…",
  "provider": "0x…",
  "openaiResponse": {
    "id": "chatcmpl-…",
    "object": "chat.completion",
    "created": 1700000180,
    "model": "llama3:70b-instruct-q4_K_M",
    "choices": [ { "index": 0, "message": { "role": "assistant", "content": "…" }, "finish_reason": "stop" } ],
    "usage": { "prompt_tokens": 42, "completion_tokens": 318, "total_tokens": 360 }
  },
  "ts": 1700000180
}
```

### 6.3 Postage stamp policy

- **Request stamp**: client buys, depth small, TTL ≥ `deliveryDeadline + 1h`.
- **Response stamp**: provider buys from a pre-funded rolling batch, TTL ≥ `RESPONSE_FETCH_WINDOW` (default 6h).
- After fetch, the client is responsible for any long-term archival (re-upload with their own stamp).

---

## 7. Container Design

Single Docker image, two modes selected by `T4T_MODE` env var.

### 7.1 Common environment

| Variable | Required | Description |
|---|---|---|
| `T4T_MODE` | yes | `client` or `provider` |
| `BEE_API_URL` | yes | e.g. `http://bee:1633` |
| `GNOSIS_RPC_URL` | yes | Gnosis Chain RPC |
| `WALLET_KEY` | yes | hex private key (or path via `WALLET_KEY_FILE`) |
| `REGISTRY_ADDRESS` | yes | `ProviderRegistry` contract |
| `ESCROW_ADDRESS` | yes | `JobEscrow` contract |
| `LOG_LEVEL` | no | default `info` |

### 7.2 Client mode

Additional env:
| Variable | Default | Description |
|---|---|---|
| `T4T_HTTP_PORT` | `8080` | OpenAI-compatible API port |
| `T4T_SELECTION_STRATEGY` | `top_rep_cheapest` | `cheapest`, `top_rep_cheapest`, `manual` |
| `T4T_MAX_PRICE_PER_MILLION_TOKENS` | unset | upper bound on (input + output) xBZZ wei per 1M tokens combined |
| `T4T_DEFAULT_DEADLINE_SECONDS` | `300` | per-job |
| `T4T_FAKE_STREAMING` | `true` | emulate SSE for `stream: true` |

Exposes:
- `POST /v1/chat/completions` — OpenAI-compatible
- `GET  /v1/models` — lists models available across discovered providers
- `GET  /healthz`

Behavior on `stream: true` with `T4T_FAKE_STREAMING=true`: SSE headers are flushed immediately and the gateway opens a `<think>` block at the head of the assistant turn (the de-facto reasoning-content convention used by DeepSeek R1, o1, QwQ et al.), then emits a bullet line for each lifecycle event (`selecting_provider`, `provider_selected`, `posting_job`, `job_posted`, `notifying_provider`, `provider_acked`, `awaiting_delivery`, `delivered`) as it happens. Every chat client that supports reasoning models — Open WebUI, LibreChat, Continue, Cline, Cursor, Big-AGI — already renders `<think>` as a collapsed "thinking" section visually distinct from the assistant answer, giving the two-message UX (status + AI response) inside the OpenAI single-message-per-request protocol. A `: keepalive` SSE comment is sent every 10s so reverse-proxy / fetch idle timeouts don't kill the connection during the multi-second T4T round-trip. After delivery, if the model's response itself starts with a `<think>…</think>` block (reasoning models), it's spliced into the gateway's thinking block so the user sees one unified collapsed panel ("network status + model reasoning") rather than two stacked ones; the model's actual answer follows the merged `</think>`. The response is emitted as a single `chat.completion.chunk` delta (the response arrives from Swarm as one finalized blob — there's nothing to actually token-stream), followed by `data: [DONE]`. Errors are appended inside the thinking block, the block is closed, and the stream ends normally (no dropped socket).

When the request signals **structured output** — `response_format.type` is set to anything other than `text` (e.g. `json_object`, `json_schema`), or `tools` is non-empty — the `<think>` wrapper is suppressed entirely. The assistant `delta.content` will be exactly what the provider produced (parseable JSON, tool-call payload, etc.) so headless agents (Cline, OpenCode, Aider, raw OpenAI SDK with JSON mode) can consume the response without reasoning-tag noise. SSE keepalive comments still flow during the wait so the connection survives the round-trip. Round-trip errors set `finish_reason: 'error'` on the terminal chunk instead of injecting markdown into content.

With `T4T_FAKE_STREAMING=false`: 400.

### 7.3 Provider mode

Additional env:
| Variable | Default | Description |
|---|---|---|
| `T4T_ENDPOINTS_FILE` | `${T4T_DATA_DIR}/endpoints.json` | Path to a JSON array of `{name, url, apiKey?}` entries describing every OpenAI-compatible inference backend the provider routes to (Ollama, vLLM, LiteLLM, llama.cpp, OpenAI, …). At least one entry required. First endpoint to advertise a given model id wins on collision (later collisions are logged and ignored). |
| `T4T_INPUT_PRICE_DEFAULT` | required | xBZZ wei per 1M prompt tokens, applied to newly-discovered models only. Per-model prices live on-chain in `ModelOffering.inputPricePerMillionTokens` and are editable from the admin UI. |
| `T4T_OUTPUT_PRICE_DEFAULT` | required | xBZZ wei per 1M completion tokens, same semantics as the input default. |
| `T4T_HEARTBEAT_INTERVAL_SECONDS` | `300` | |
| `T4T_MAX_CONCURRENT_JOBS` | `2` | |

Behavior:
1. On start: read state, register if needed, load the endpoints file, query each backend's `GET /v1/models` and aggregate the unique model ids, read existing on-chain offerings, build merged set (preserve any per-model prices already on-chain; apply `T4T_INPUT_PRICE_DEFAULT` and `T4T_OUTPUT_PRICE_DEFAULT` to newly-seen models), publish via `updateOfferings` only if the merged set differs from chain, begin heartbeat loop. To stop serving a model, remove it from the backend (or drop the backend from `endpoints.json`) and restart. To change a model's prices, use the admin UI's Models page (writes via `updateOfferings`). At claim time: `actualPayment = (inputPrice·promptTokens + outputPrice·completionTokens) / 1_000_000`.
2. Subscribe to `t4t:provider:<address>`.
3. On `job_notify`: validate registry pricing matches, ACK within `ACK_WINDOW / 2`.
4. Fetch + decrypt request, look up the backend serving `modelId`, call its `/v1/chat/completions`, encrypt + upload response, send `job_deliver`.
5. Call `claimJob` on the chain.

---

## 8. Reputation (v1)

Simple and on-chain-readable:

- `successRate = successfulJobs / totalJobs`, only counted for jobs `Claimed` without dispute.
- Client containers default to selection from providers with `successRate ≥ 0.95` and `totalJobs ≥ 20`. New providers (< 20 jobs) get a small "exploration" share of routing — say 5%.

No off-chain rating in v1. Output-quality verification is deferred — we accept that "honest about declared model" is the SLA, and that quality is policed by client switching.

---

## 9. Security Considerations

- **Replay**: every PSS envelope includes `nonce` and `ts`; recipients keep an LRU dedup cache (10k entries, matches SwarmChat).
- **Encryption**: requests and responses are encrypted to the counterparty's PSS public key. Anyone with the Swarm hash can fetch the chunk, but not decrypt it.
- **Wallet exposure**: containers ship without keys. First run generates one and prints the funding address; operator funds with xBZZ + a little xDAI.
- **Key rotation**: providers can update `pssPublicKey` in the registry; clients always read the current key before encrypting.
- **MITM on selection**: client reads provider's PSS pubkey from the on-chain registry, not from PSS, so a malicious peer can't substitute keys.
- **Prompt privacy**: payloads encrypted end-to-end. Operator of the provider node can of course see decrypted prompts — same trust model as any local inference host. Document this clearly.
- **Model-identity honesty**: the declared `modelId` is part of the SLA but is *not* cryptographically bound to the response in v1. A malicious provider can register `llama3:70b` pricing and serve `llama3:8b` (or a heavier-quantised variant), keeping the spread. Defenses in v1 are economic (liveness slashing) and reputational (client switching, see §8). Ollama's manifest digest (`/api/show.digest`) is available as a **soft signal** — useful at registration time to flag blob substitution against a known-good digest list — but it is not a proof: the provider operates the inference node and controls both what `/api/show` returns and which model `/api/chat` is actually routed to. We deliberately accept this trust band: the major commercial AI providers also swap underlying models without notifying clients, so requiring stronger guarantees here would be out of step with the industry. Hard proof of model identity (zkML, TEE attestations, statistical challenge protocols) is deferred — see §10.
- **Client-side griefing of providers**: a slashing system that pays the slashed stake to anyone (the client, or a protocol treasury) creates the inverse incentive — *causing* a job to fail becomes profitable. A malicious client could withhold the encrypted request from Swarm, PSS-flood the provider, or front-run an ACK to trip `cancelJob`/`timeoutJob` and harvest the slash. A protocol-controlled treasury suffers the same critique from the outside, even if the operator never intends to act on it. v1 sidesteps the entire question by sending 100 % of every slash to `BURN_ADDRESS` (`0x…dEaD`), so no participant — client, operator, or anyone else — profits from a failed inference. The client's compensation is solely the refund + the option to retry against another provider; the cost of a single failed round-trip is low enough that this is acceptable. Heartbeat history and per-provider reputation (§8) remain the long-term sticks against unreliable providers; defending providers against clients that repeatedly post jobs they then cancel is left to provider-side address filtering — out of scope for v1.

---

## 10. Out of Scope (v1)

- Cryptographic proof of model identity (zkML, TEE attestations)
- Multi-provider quorum / output cross-checking
- Streaming over PSS
- Subscriptions, prepaid credits, multi-job batching
- ENS subdomain assignment to providers
- Mobile clients
- Native token

---

## 11. Repository Layout (target)

```
t4t/
├── contracts/
│   ├── src/
│   │   ├── ProviderRegistry.sol
│   │   └── JobEscrow.sol
│   ├── test/                          # Foundry: unit + fuzz + invariant
│   ├── script/Deploy.s.sol
│   └── foundry.toml
├── container/
│   ├── src/
│   │   ├── modes/client/              # OpenAI shim, selection, job posting
│   │   ├── modes/provider/            # PSS subscriber, Ollama wrapper, claim
│   │   ├── lib/
│   │   │   ├── envelope.ts            # PSS envelope sign/verify (mirrors SwarmChat)
│   │   │   ├── swarm.ts               # upload/download + stamp mgmt
│   │   │   ├── chain.ts               # contract bindings (viem)
│   │   │   ├── inference.ts           # OpenAI-compatible backend client (Ollama/vLLM/…)
│   │   │   └── crypto.ts              # ECIES-style encrypt/decrypt for payloads
│   │   └── index.ts                   # mode dispatch
│   ├── test/
│   ├── Dockerfile
│   └── package.json
├── docs/
│   ├── spec.md                        # this file
│   ├── getting-started-gateway.md
│   ├── getting-started-provider.md
│   └── architecture.md
├── docker-compose.provider-example.yml
├── docker-compose.gateway-example.yml
└── README.md
```

---

## 12. Milestones

**M1 — Loop closed.** Local Anvil fork, one client and one provider container, one successful round-trip from Open WebUI. No reputation, fixed pricing, no slashing.

**M2 — Contracts hardened.** Full Foundry suite (unit + fuzz + invariants) on `ProviderRegistry` and `JobEscrow`. Deployed to Chiado.

**M3 — Real network.** Two real Bee nodes, Chiado, multiple providers, client selection working, heartbeat + basic reputation.

**M4 — Slashing live.** Liveness slashing (burn-only — see §4.2), stake bonding/unbonding.

**M5 — Mainnet candidate.** Audit-prep pass on contracts, deploy to Gnosis Chain mainnet, frontend on Swarm at `t4t.eth`.

---

## 13. Open Questions

- Settlement currency for token-billed payments: provider declares `inputPricePerMillionTokens` + `outputPricePerMillionTokens`. Cost depends on both prompt and completion tokens. Client signs a `maxPayment` bound; provider reports actual usage at `claimJob`; on-chain logic enforces `actualPayment ≤ maxPayment` and refunds the difference.
- Should client signatures on response receipt be required for fastest settlement, with a fallback to time-based finalization if the client is unreachable? Leaning yes.
- Heartbeat on-chain vs off-chain: on-chain costs gas, off-chain needs a separate gossip mechanism. Cheapest path is a once-per-5-min on-chain `heartbeat()` — at Gnosis gas prices, negligible.
- Postage stamp issuance flow inside the provider container: pre-buy a long-lived deep batch at startup, or buy per-job? Pre-buy is faster and simpler.
- Provider metadata schema (the `metadataURI` JSON): pin contents in v1 or leave flexible? Recommend pinning a minimal v1 schema and reserving extensibility via a `extensions` map.
