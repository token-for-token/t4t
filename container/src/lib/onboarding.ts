import express from 'express'
import {privateKeyToAccount} from 'viem/accounts'
import type {Logger} from './logger'
import {escape, layout, type NavTab} from './admin-html'
import {
  newMnemonic,
  isMnemonic,
  mnemonicToPrivateKey,
  parseWalletInput,
  saveWalletKey,
} from './wallet'

// Onboarding mode only serves /wallet — all other admin routes are
// registered by the post-onboarding admin servers. Render just the wallet tab
// so the operator doesn't get 404s clicking Jobs/Status/Models.
const ONBOARDING_TABS: NavTab[] = [{id: 'wallet', href: '/wallet', label: 'Wallet'}]

export interface OnboardingDeps {
  /** 'gateway' | 'provider' — only affects display copy. */
  role: string
  host: string
  port: number
  walletFilePath: string
  /** When non-null, wallet already exists — the page shifts to "waiting for
   *  contracts" / status mode. Null means the user still needs to create one. */
  existingAddress: string | null
  /** Snapshot of REGISTRY/ESCROW/XBZZ addresses so the page can tell the
   *  operator exactly what's still unset. */
  protocol: {registry: string; escrow: string; xbzz: string}
  /** Set when the wallet+contracts are configured but the Bee node has no
   *  usable postage batch yet. Page shows "buy a stamp" instructions. */
  stamp?: {missing: true; beeUrl: string}
  /** Set when the wallet exists but doesn't hold enough xBZZ to register as a
   *  provider. Page shows the wallet address + required top-up amount. */
  funding?: {required: bigint; current: bigint}
  /** Optional periodic callback that re-evaluates whether the missing
   *  prerequisite is now satisfied (wallet got funded, stamp got bought, …).
   *  Returns true once we should restart into normal mode; the container then
   *  exits and docker brings it back up via its restart policy. */
  recheck?: () => Promise<boolean>
  /** How often to call `recheck`. Defaults to 10s. */
  recheckIntervalSeconds?: number
  logger: Logger
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000'
export function isZeroAddress(a: string): boolean {
  return a.toLowerCase() === ZERO_ADDR
}

/** Minimal admin server used when no wallet key is configured yet. Exposes
 *  the /wallet routes only; once a key is saved it calls process.exit(0)
 *  so docker-compose restarts the container into the normal startup path. */
export function startOnboardingServer(deps: OnboardingDeps): void {
  const app = express()
  app.use(express.json({limit: '64kb'}))
  app.use(express.urlencoded({extended: false, limit: '64kb'}))

  app.get('/healthz', (_req, res) => res.json({ok: true, mode: 'onboarding'}))

  app.get('/', (_req, res) => res.redirect('/wallet'))

  app.get('/wallet', (_req, res) => {
    res.send(
      layout({
        title: `t4t ${deps.role} — setup`,
        refreshSeconds: 10,
        active: 'wallet', tabs: ONBOARDING_TABS,
        body: onboardingPage(deps, null, null),
      }),
    )
  })

  app.post('/wallet/generate', (_req, res) => {
    if (deps.existingAddress) return res.redirect('/wallet')
    const mnemonic = newMnemonic()
    res.send(
      layout({
        title: `t4t ${deps.role} — setup`,
        refreshSeconds: 0,
        active: 'wallet', tabs: ONBOARDING_TABS,
        body: onboardingPage(deps, mnemonic, null),
      }),
    )
  })

  app.post('/wallet/save', (req, res) => {
    if (deps.existingAddress) return res.redirect('/wallet')
    const mnemonic = String((req.body as {mnemonic?: string}).mnemonic ?? '').trim()
    if (!isMnemonic(mnemonic)) {
      return res.status(400).send(
        layout({
          title: `t4t ${deps.role} — setup`,
          refreshSeconds: 0,
          active: 'wallet', tabs: ONBOARDING_TABS,
          body: onboardingPage(deps, null, 'Invalid mnemonic — generate or import again.'),
        }),
      )
    }
    const key = mnemonicToPrivateKey(mnemonic)
    const address = privateKeyToAccount(key).address
    saveWalletKey(deps.walletFilePath, key)
    deps.logger.info({address, path: deps.walletFilePath}, 'wallet created — exiting so container restarts')
    res.send(savedPage(address))
    res.on('finish', () => setTimeout(() => process.exit(0), 100))
  })

  app.post('/wallet/import', (req, res) => {
    if (deps.existingAddress) return res.redirect('/wallet')
    const input = String((req.body as {input?: string}).input ?? '').trim()
    try {
      const key = parseWalletInput(input)
      const address = privateKeyToAccount(key).address
      saveWalletKey(deps.walletFilePath, key)
      deps.logger.info({address, path: deps.walletFilePath}, 'wallet imported — exiting so container restarts')
      res.send(savedPage(address))
      res.on('finish', () => setTimeout(() => process.exit(0), 100))
    } catch (err) {
      res.status(400).send(
        layout({
          title: `t4t ${deps.role} — setup`,
          refreshSeconds: 0,
          active: 'wallet', tabs: ONBOARDING_TABS,
          body: onboardingPage(deps, null, `Import failed: ${err instanceof Error ? err.message : String(err)}`),
        }),
      )
    }
  })

  // Auto-progress: poll the missing prerequisite. Once satisfied, exit so the
  // container restarts into normal startup. Avoids the operator having to run
  // `docker compose restart` after sending xBZZ or buying a postage batch.
  if (deps.recheck) {
    const intervalMs = (deps.recheckIntervalSeconds ?? 10) * 1000
    let inFlight = false
    setInterval(async () => {
      if (inFlight) return
      inFlight = true
      try {
        if (await deps.recheck!()) {
          deps.logger.info('onboarding prerequisite resolved — exiting to restart container')
          setTimeout(() => process.exit(0), 100)
        }
      } catch (err) {
        deps.logger.warn({err}, 'onboarding recheck failed')
      } finally {
        inFlight = false
      }
    }, intervalMs).unref()
  }

  app.listen(deps.port, deps.host, () => {
    const reason = !deps.existingAddress
      ? 'no wallet configured'
      : deps.funding
        ? 'wallet under-funded for provider stake'
        : deps.stamp?.missing
          ? 'no usable postage batch on Bee'
          : 'protocol addresses are placeholder zeros'
    deps.logger.warn(
      {host: deps.host, port: deps.port, walletFilePath: deps.walletFilePath, existingAddress: deps.existingAddress},
      `onboarding UI listening — ${reason}; finish setup at /wallet`,
    )
  })
}

function onboardingPage(deps: OnboardingDeps, mnemonic: string | null, error: string | null): string {
  const errBanner = error ? `<p class="err mono">${escape(error)}</p>` : ''

  // Phase 4: wallet + contracts + postage all set, but wallet isn't funded enough to register.
  if (deps.existingAddress && deps.funding) return fundingPendingPage(deps, errBanner)

  // Phase 3: wallet + contracts ready but no usable postage stamp on Bee.
  if (deps.existingAddress && deps.stamp?.missing) return stampPendingPage(deps, errBanner)

  // Phase 2: wallet exists but protocol addresses aren't configured yet —
  // the container can't start the chain client. Show what's missing.
  if (deps.existingAddress) return contractsPendingPage(deps, errBanner)

  // Phase 1: no wallet yet — render create/import.
  const mnemonicBlock = mnemonic
    ? `
<section>
  <h2>New mnemonic</h2>
  <p class="warn"><strong>Write this down.</strong> Anyone with these words controls the wallet.
    Once you confirm below, the derived private key is saved to <span class="mono">wallet.key</span>
    and the container restarts. The mnemonic itself is <strong>not</strong> stored &mdash; there's no recovery.</p>
  <div class="mnemonic mono">${escape(mnemonic)}</div>
  <form method="post" action="/wallet/save">
    <input type="hidden" name="mnemonic" value="${escape(mnemonic)}">
    <label class="inline">
      <input type="checkbox" required>
      I have saved this mnemonic somewhere safe and understand it cannot be recovered.
    </label>
    <button type="submit">Confirm and save</button>
  </form>
</section>`
    : ''

  return `
${errBanner}
<section>
  <h2>Wallet setup &mdash; ${escape(deps.role)}</h2>
  <p>This ${escape(deps.role)} has no wallet yet. Create a fresh one or import an existing key/mnemonic to continue.
    The wallet signs every on-chain transaction (registration, heartbeats, job claims). Fund it with
    <span class="mono">xDAI</span> for gas and <span class="mono">xBZZ</span> for stake/payment before going live.</p>
</section>

${mnemonicBlock}

<div class="grid2">
  <section>
    <h3>Create new wallet</h3>
    <p class="muted">Generates a 12-word BIP39 mnemonic. You'll see the words once.</p>
    <form method="post" action="/wallet/generate"><button type="submit">Generate mnemonic</button></form>
  </section>
  <section>
    <h3>Import existing</h3>
    <p class="muted">Paste a 12 / 15 / 18 / 21 / 24-word mnemonic, or a <span class="mono">0x</span>-prefixed
      32-byte private key.</p>
    <form method="post" action="/wallet/import">
      <textarea name="input" rows="3" required placeholder="word1 word2 …  or  0x…"></textarea>
      <button type="submit">Import</button>
    </form>
  </section>
</div>`
}

function contractsPendingPage(deps: OnboardingDeps, errBanner: string): string {
  const rows: Array<[string, string, boolean]> = [
    ['REGISTRY_ADDRESS', deps.protocol.registry, isZeroAddress(deps.protocol.registry)],
    ['ESCROW_ADDRESS', deps.protocol.escrow, isZeroAddress(deps.protocol.escrow)],
    ['XBZZ_ADDRESS', deps.protocol.xbzz, isZeroAddress(deps.protocol.xbzz)],
  ]
  const list = rows
    .map(
      ([name, value, missing]) => `<tr>
      <td class="mono">${escape(name)}</td>
      <td class="mono">${escape(value || '(empty)')}</td>
      <td>${missing ? '<span class="err">unset</span>' : '<span class="ok">set</span>'}</td>
    </tr>`,
    )
    .join('')
  return `
${errBanner}
<section>
  <h2>Almost there &mdash; protocol addresses missing</h2>
  <p>Wallet is configured at <span class="mono">${escape(deps.existingAddress ?? '')}</span>.
    The ${escape(deps.role)} can't connect to the T4T protocol yet because one or more contract addresses
    in <span class="mono">docker-compose.yml</span> are still placeholder zeros. Set them and
    <span class="mono">docker compose up -d</span> to restart this container.</p>
  <table>
    <thead><tr><th>Env var</th><th>Current value</th><th>Status</th></tr></thead>
    <tbody>${list}</tbody>
  </table>
  <p class="muted">This page refreshes every 10s. Once the addresses are real, the container will pass startup
    and switch to the normal jobs/status view.</p>
</section>`
}

function savedPage(address: string): string {
  return `<!doctype html><html><head><meta http-equiv="refresh" content="3"><title>Wallet saved</title>
<style>body{font:14px/1.4 system-ui,sans-serif;padding:32px;background:#0f1115;color:#e7eaf0}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.muted{color:#8b93a7}</style></head><body>
<h1>Wallet saved</h1>
<p>Address: <span class="mono">${escape(address)}</span></p>
<p class="muted">The container will exit so docker can restart it into normal mode. This page will reload in a few seconds.</p>
</body></html>`
}

function formatBzz(wei: bigint): string {
  // xBZZ has 16 decimals on Gnosis.
  const scale = 10n ** 16n
  const whole = wei / scale
  const frac = wei % scale
  if (frac === 0n) return `${whole}`
  const fracStr = (frac + scale).toString().slice(1).replace(/0+$/, '')
  return `${whole}.${fracStr.slice(0, 4)}`
}

function fundingPendingPage(deps: OnboardingDeps, errBanner: string): string {
  const required = deps.funding!.required
  const current = deps.funding!.current
  const missing = required > current ? required - current : 0n
  return `
${errBanner}
<section>
  <h2>Almost there &mdash; please add xBZZ to this wallet</h2>
  <p>The ${escape(deps.role)} can't register on-chain yet: the wallet holds
    <strong>${escape(formatBzz(current))} BZZ</strong> but the
    <span class="mono">ProviderRegistry.MIN_STAKE</span> requires
    <strong>${escape(formatBzz(required))} BZZ</strong> as the initial stake.</p>
  <p>Send at least <strong>${escape(formatBzz(missing))} BZZ</strong> on Gnosis Chain to:</p>
  <pre class="mono">${escape(deps.existingAddress ?? '')}</pre>
  <p class="muted">The container polls this balance every 10s. As soon as it reaches the
    threshold, the ${escape(deps.role)} auto-restarts into the normal jobs/status view &mdash; no manual
    intervention required.</p>
  <p class="muted">xBZZ contract:
    <span class="mono">0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da</span> (16 decimals).
    You'll also want roughly <span class="mono">0.05 xDAI</span> for gas.</p>
</section>`
}

function stampPendingPage(deps: OnboardingDeps, errBanner: string): string {
  const beeUrl = deps.stamp?.beeUrl ?? ''
  return `
${errBanner}
<section>
  <h2>One more thing &mdash; need a postage stamp</h2>
  <p>Wallet is configured at <span class="mono">${escape(deps.existingAddress ?? '')}</span> and the
    T4T protocol contracts are set. The connected Bee node has no usable postage batch yet, so the
    ${escape(deps.role)} can't upload to Swarm. Buy one and the container will pick it up automatically
    on the next refresh.</p>
  <h3>Buy via Bee API</h3>
  <p class="muted">Replace <span class="mono">10000000</span> and <span class="mono">20</span> with your
    desired amount (per-chunk price &times; blocks) and depth (17&ndash;22). Larger depth = larger batch.</p>
  <pre class="mono">curl -X POST "${escape(beeUrl)}/stamps/10000000/20"</pre>
  <p class="muted">Buying a batch costs xBZZ from the Bee node's own wallet (not this ${escape(deps.role)}'s
    wallet). See the
    <a href="https://docs.ethswarm.org/docs/develop/access-the-swarm/keep-your-data-alive">Bee docs</a>
    for amount/depth guidance.</p>
  <p class="muted">The container polls Bee every 10s. As soon as a usable batch appears, the
    ${escape(deps.role)} auto-restarts into the normal jobs/status view.</p>
</section>`
}
