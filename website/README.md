# t4t.eth website

Static landing page + live model directory for Token4Token. Reads
`ProviderRegistry` directly from Gnosis Chain in the browser via viem,
so the deployed site has no backend, no server, no runtime infrastructure
— it lives entirely on Swarm and is served via the ENS `t4t.eth`
contenthash.

Live at [t4t.eth](https://t4t.eth.limo) (any ENS-aware browser also
resolves it natively).

## Configure

Edit [`src/config.js`](src/config.js):

- `registryAddress` — the deployed `ProviderRegistry` address on Gnosis.
- `rpcUrl` — a CORS-enabled Gnosis RPC. Defaults to `rpc.gnosischain.com`.

## Build

```bash
npm install
npm run build      # writes dist/ — three static files: index.html, bundle.js, style.css
```

## Deploy to Swarm + ENS

End-to-end is three scripts, each idempotent. All three read
`MNEMONIC`, `MNEMONIC_INDEX`, `ETH_RPC_URL` (and optionally `ENS_NAME`)
from `../.env`.

```bash
BEE_API_URL=https://bee.example.com \
POSTAGE_BATCH_ID=0x… \
npm run deploy                                  # 1. upload dist/ to Swarm

node ens-set-contenthash.mjs 0xe40101…           # 2a. dry-run the resolver write
node ens-set-contenthash.mjs 0xe40101… --broadcast   # 2b. send it
```

The deploy script prints both the **Swarm reference** (preview at
`https://<reference>.bzz.link/`) and the **EIP-1577 contenthash** —
the latter is what `ens-set-contenthash.mjs` writes onto the resolver.

### First-time registration

If the `.eth` name doesn't exist yet (or has expired), use the
commit-reveal script. Wallet must hold enough ETH for `rentPrice` + gas
— 0.30 ETH covers a 1-year 3-letter name. The script is resumable:
state is written to `ens-register-<name>.json` between the commit and
register txs so it can pick up where it left off if anything dies.

```bash
node ens-register.mjs                  # dry run (simulate only)
node ens-register.mjs --broadcast      # commit → wait 60s → register
```

Customise via `../.env`:

- `ENS_NAME=foo.eth`
- `ENS_DURATION_SEC=63072000`  (default 1 year)

### What's on-chain

| What                | Where     | Contract                                       |
|---------------------|-----------|------------------------------------------------|
| Name registration   | Mainnet   | ETHRegistrarController v3 `0x2535…303b`        |
| Resolver records    | Mainnet   | PublicResolver v3 `0x231b…8E63`                |
| Content blob        | Swarm     | (Bee node, paid in xBZZ on Gnosis)             |

The `.eth` ownership is held in the canonical NameWrapper (registry
`owner(node)` returns `0xD441…6401`); the actual holder of the wrapped
ERC-1155 is the wallet derived from `MNEMONIC` at index
`MNEMONIC_INDEX`.

## Preview before deploying

The bundle uses ES modules, so opening `dist/index.html` over `file://`
won't load `bundle.js`. Cleanest preview is uploading to a Bee node
(the deploy script works against any URL via `BEE_API_URL`) and
opening the printed gateway URL.
