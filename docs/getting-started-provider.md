# Getting started — provider

You want to earn xBZZ by serving Ollama inference. Run the provider container.

## 1. Prerequisites

- A box with a GPU (or a fast CPU) running [Ollama](https://ollama.com).
- A local Bee node (with xBZZ + xDAI on the Bee node's own wallet — used for postage stamps).
- A wallet with **xBZZ** (≥ 100 for the minimum stake, plus headroom for concurrent jobs) and a little **xDAI** for gas.
- A Swarm postage batch — set `T4T_STAMP_MANAGE=true` to have the container buy and top up one automatically (recommended), or pre-buy via the Bee dashboard and pin its 64-char hex in `POSTAGE_BATCH_ID`.

## 2. Pull the models you offer

```bash
ollama pull llama3:8b
ollama pull mistral:7b
```

On startup the container queries each configured backend's `GET /v1/models` and registers every model it finds as an on-chain offering. To stop serving a model, remove it from the backend (`ollama rm <model>` or unload it from vLLM) — or drop the backend from `endpoints.json` — and restart the container.

## 3. Configure inference endpoints

Create `data/provider/endpoints.json` listing every OpenAI-compatible backend the provider should route to. Each entry is `{name, url, apiKey?}`:

```json
[
  {"name": "ollama", "url": "http://host.docker.internal:11434"},
  {"name": "openai", "url": "https://api.openai.com", "apiKey": "sk-..."}
]
```

`name` is a short label (no `/`) that appears in logs and acts as the disambiguation prefix when two backends serve the same model id. `url` is the base URL — `/v1/chat/completions` and `/v1/models` are appended at call time, so don't include them here. `apiKey` is optional (omit for Ollama; required for OpenAI / vLLM-with-`--api-key`).

If two backends advertise the same model id (e.g. both Ollama and OpenAI serve `llama3`), the provider registers each one on-chain under `<endpoint-name>/<modelId>` — so `ollama/llama3` and `openai/llama3` become two distinct offerings, each with its own price (editable on the Models page). Clients then request whichever flavour they want. Models served by a single backend keep their bare id.

Override the path with `T4T_ENDPOINTS_FILE`.

## 4. Configure the rest

| Var | Example |
|---|---|
| `T4T_MODE` | `provider` |
| `BEE_API_URL` | `http://localhost:1633` |
| `GNOSIS_RPC_URL` | `https://rpc.gnosischain.com` |
| `REGISTRY_ADDRESS` | `0x…` |
| `ESCROW_ADDRESS` | `0x…` |
| `XBZZ_ADDRESS` | `0x…` |
| `POSTAGE_BATCH_ID` | 64-char hex — leave unset to let the container manage one |
| `T4T_STAMP_MANAGE` | `true` to auto-create and auto-top-up a labelled postage batch (default `false`) |
| `T4T_STAMP_DEPTH` | Bee batch depth (default `22` ≈ 512MB) |
| `T4T_STAMP_TTL_DAYS` | Target lifetime when buying (default `30`) |
| `T4T_STAMP_MIN_TTL_DAYS` | Auto-top-up trigger when remaining TTL falls below this (default `7`) |
| `T4T_STAMP_LABEL` | Label used to recognise t4t-managed batches (default `t4t-managed`) |
| `T4T_STAMP_DRY_RUN` | `true` to log the planned tx without spending xBZZ (default `false`) |
| `WALLET_KEY` | `0x…` |
| `T4T_INPUT_PRICE_DEFAULT` | xBZZ wei per 1M prompt tokens for newly-seen models; per-model overrides live on-chain via the admin UI |
| `T4T_OUTPUT_PRICE_DEFAULT` | xBZZ wei per 1M completion tokens, same semantics |
| `T4T_HEARTBEAT_INTERVAL_SECONDS` | `300` |
| `T4T_MAX_CONCURRENT_JOBS` | `2` |

## 5. Run

```bash
docker run --rm --env-file .env -v $PWD/data/provider:/data t4t:dev
```

On first boot the container:

1. Reads its on-chain provider row. If absent, calls `register()` with the minimum stake.
2. Calls `updateOfferings()` with the comma-list of models.
3. Starts a heartbeat loop (`heartbeat()` every 5 min).
4. Subscribes to `t4t:provider:<your-address>` over PSS.

## 6. Slashing — read this

If you fail to ACK within 30s **or** ACK and miss the delivery deadline, your stake is slashed:

- No ACK: `max(2 × maxPayment, 1 xBZZ)`
- Timeout after ACK: `max(3 × maxPayment, 1 xBZZ)`

The slashed amount is **burned** — sent to `ProviderRegistry.BURN_ADDRESS` (`0x…dEaD`). Neither the client nor any treasury receives a share, which removes the inverse incentive for clients to grief providers into failing. Don't oversubscribe — the registry enforces `(openJobs + 1) × 3 × maxPayment ≤ stake` at `postJob` time.

## 7. Withdrawing

Call `deactivate()`, wait `UNBONDING_PERIOD` (2 days) and for all open jobs to settle, then call `withdrawStake()`.
