# Getting started — client

You want to use T4T from any OpenAI-compatible app. Run the client container; point your app at `http://localhost:8080/v1`.

## 1. Prerequisites

- A local Bee node (`bee` or run with the bundled `docker-compose.client-example.yml`).
- A wallet with **xBZZ** (for payment) and a little **xDAI** (for gas) on Gnosis Chain.
- A funded Swarm postage batch ID.
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
| `POSTAGE_BATCH_ID` | 64-char hex |
| `WALLET_KEY` | `0x…` (or `WALLET_KEY_FILE`) |
| `T4T_HTTP_PORT` | `8080` |
| `T4T_SELECTION_STRATEGY` | `top_rep_cheapest` |
| `T4T_DEFAULT_DEADLINE_SECONDS` | `300` |
| `T4T_FAKE_STREAMING` | `true` |

## 3. Run

```bash
docker run --rm -p 8080:8080 --env-file .env t4t:dev
```

Or directly:

```bash
cd container
T4T_MODE=client npm run dev
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
4. If the provider never ACKs or never delivers, the client cancels/times-out the job; stake is slashed and you get a refund + apology.
