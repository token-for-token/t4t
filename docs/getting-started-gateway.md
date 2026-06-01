# Getting started — gateway

You want to use T4T from any OpenAI-compatible app. Run the gateway container; point your app at `http://localhost:3000/v1`.

## 1. Prerequisites

- A local Bee node (`bee` or run with the bundled `docker-compose.gateway-example.yml`).
- A wallet with **xBZZ** (for payment) and a little **xDAI** (for gas) on Gnosis Chain.
- A Swarm postage batch — set `T4T_STAMP_MANAGE=true` to have the container buy and top up one automatically (recommended), or pre-buy via the Bee dashboard and pin its 64-char hex in `POSTAGE_BATCH_ID`. The Bee node's own wallet pays for the batch.
- The deployed T4T contract addresses (registry, escrow, xBZZ).

## 2. Configure

Set these env vars (or put them in `.env`):

| Var | Example |
|---|---|
| `T4T_MODE` | `client` |
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
| `T4T_STAMP_LABEL` | Label applied to managed batches (default `t4t`). The resolved batchId is persisted to `/data/postage-batch.json` so the same batch is reused across restarts. |
| `T4T_STAMP_DRY_RUN` | `true` to log the planned tx without spending xBZZ (default `false`) |
| `WALLET_KEY` | `0x…` (or `WALLET_KEY_FILE`) |
| `T4T_HTTP_PORT` | `8080` |
| `T4T_SELECTION_STRATEGY` | `top_rep_cheapest` |
| `T4T_DEFAULT_DEADLINE_SECONDS` | `300` |
| `T4T_FAKE_STREAMING` | `true` |
| `T4T_DEFAULT_MAX_OUTPUT_TOKENS` | `16384` (fallback completion cap when request omits `max_tokens`) |
| `T4T_ESCROW_HEADROOM_RATIO` | `0.2` (multiplicative buffer on the per-job escrow) |
| `T4T_MAX_ESCROW_PER_JOB` | unset (hard per-job escrow ceiling, xBZZ wei; HTTP 413 if exceeded) |

## 3. Run

```bash
docker run --rm -p 8080:8080 --env-file .env t4t:dev
```

Or directly:

```bash
cd container
T4T_MODE=gateway npm run dev
```

## 4. Use it

```bash
curl -s http://localhost:8080/v1/models | jq

curl -s http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "llama3:8b",
    "messages": [{"role": "user", "content": "Hello!"}]
  }' | jq
```

For Open WebUI / LibreChat / Continue.dev, set the base URL to `http://localhost:8080/v1` and any non-empty API key.

## How payment flows

1. Client picks a provider from the on-chain registry that offers the requested model within `T4T_MAX_PRICE_PER_MILLION_TOKENS` (cap on input + output combined).
2. Client uploads the encrypted request to Swarm, then calls `JobEscrow.postJob`, locking a conservative `maxPayment` derived from the provider's per-model input/output rates and the requested `max_tokens`.
3. Provider runs inference, uploads the response, and calls `claimJob` for the actual cost: `(inputPrice·promptTokens + outputPrice·completionTokens) / 1M`. The difference refunds back.
4. If the provider never ACKs or never delivers, the gateway cancels/times-out the job. The provider's stake is slashed and the slashed tokens are burned (see [spec §4.2](spec.md)). You get your `maxPayment` refunded — but **no share of the slash**. This is intentional: paying gateways a bounty for failures would make it profitable to grief providers into failing.
