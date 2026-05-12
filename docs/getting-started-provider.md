# Getting started — provider

You want to earn xBZZ by serving Ollama inference. Run the provider container.

## 1. Prerequisites

- A box with a GPU (or a fast CPU) running [Ollama](https://ollama.com).
- A local Bee node.
- A wallet with **xBZZ** (≥ 100 for the minimum stake, plus headroom for concurrent jobs) and a little **xDAI** for gas.
- A funded Swarm postage batch ID.

## 2. Pull the models you offer

```bash
ollama pull llama3:8b
ollama pull mistral:7b
```

On startup the container queries the backend's `GET /v1/models` and registers every model it finds as an on-chain offering. To stop serving a model, remove it from the backend (`ollama rm <model>` or unload it from vLLM) and restart the container.

## 3. Configure

| Var | Example |
|---|---|
| `T4T_MODE` | `provider` |
| `BEE_API_URL` | `http://localhost:1633` |
| `OPENAI_BASE_URL` | `http://host.docker.internal:11434` (Ollama) or `http://vllm:8000` (vLLM) |
| `OPENAI_API_KEY` | _optional_ — set for vLLM with `--api-key` or cloud backends |
| `GNOSIS_RPC_URL` | `https://rpc.gnosischain.com` |
| `REGISTRY_ADDRESS` | `0x…` |
| `ESCROW_ADDRESS` | `0x…` |
| `XBZZ_ADDRESS` | `0x…` |
| `POSTAGE_BATCH_ID` | 64-char hex |
| `WALLET_KEY` | `0x…` |
| `T4T_INPUT_PRICE_DEFAULT` | xBZZ wei per 1M prompt tokens for newly-seen models; per-model overrides live on-chain via the admin UI |
| `T4T_OUTPUT_PRICE_DEFAULT` | xBZZ wei per 1M completion tokens, same semantics |
| `T4T_HEARTBEAT_INTERVAL_SECONDS` | `300` |
| `T4T_MAX_CONCURRENT_JOBS` | `2` |

## 4. Run

```bash
docker run --rm --env-file .env t4t:dev
```

On first boot the container:

1. Reads its on-chain provider row. If absent, calls `register()` with the minimum stake.
2. Calls `updateOfferings()` with the comma-list of models.
3. Starts a heartbeat loop (`heartbeat()` every 5 min).
4. Subscribes to `t4t:provider:<your-address>` over PSS.

## 5. Slashing — read this

If you fail to ACK within 30s **or** ACK and miss the delivery deadline, your stake is slashed:

- No ACK: `max(2 × maxPayment, 1 xBZZ)`
- Timeout after ACK: `max(3 × maxPayment, 1 xBZZ)`

1.5× `maxPayment` goes to the client as an apology; the remainder goes to the treasury. Don't oversubscribe — the registry enforces `(openJobs + 1) × 3 × maxPayment ≤ stake` at `postJob` time.

## 6. Withdrawing

Call `deactivate()`, wait `UNBONDING_PERIOD` (2 days) and for all open jobs to settle, then call `withdrawStake()`.
