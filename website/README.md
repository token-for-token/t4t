# t4t.eth website

Static landing page + live model directory for Token4Token. Reads
`ProviderRegistry` directly from Gnosis Chain in the browser via viem,
so the deployed site has no backend, no server, no runtime infrastructure
— it lives entirely on Swarm and is served via the ENS `t4t.eth`
contenthash.

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

Needs a running Bee node and a funded postage stamp.

```bash
BEE_API_URL=http://localhost:1633 \
POSTAGE_BATCH_ID=0x… \
npm run deploy
```

The script uploads `dist/` to Bee as a Swarm collection and prints two
things:

- the **Swarm reference** (preview at `https://<reference>.bzz.link/`)
- the **EIP-1577 contenthash** to paste into the ENS app under
  `t4t.eth → Records → Content`.

Once the ENS record is updated, ENS-aware browsers (Brave, MetaMask,
Status, the IPFS/Swarm gateway extension) resolve `t4t.eth` straight
to the Swarm-hosted bundle.

## Preview before deploying

The bundle uses ES modules, so opening `dist/index.html` over `file://`
won't load `bundle.js`. The cleanest preview is to upload to your local
Bee node (the deploy script works against `http://localhost:1633`) and
open the printed gateway URL.
