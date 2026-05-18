import express from 'express'
import type {Bee} from '@ethersphere/bee-js'
import type {ChainClient} from '../../lib/chain'
import {getProvider} from '../../lib/chain'
import type {JobsDb, ProviderJobRow} from '../../lib/jobs-db'
import type {Logger} from '../../lib/logger'
import type {ModelOffering} from '../../lib/types'
import type {JobQueue} from './listener'
import {
  escape,
  formatDuration,
  formatTs,
  formatXBZZ,
  layout,
  parseBzzToPlur,
  PROVIDER_TABS,
  shortHex,
  statusPill,
} from '../../lib/admin-html'
import {getBzzUsd} from '../../lib/bzz-price'
import {attachStampsAdmin, renderStampsPage} from '../../lib/admin-stamps'

const HEARTBEAT_TTL = 600

export interface ProviderAdminDeps {
  host: string
  port: number
  statusRefreshSeconds: number
  db: JobsDb
  chain: ChainClient
  bee: Bee
  /** Resolved postage batch ID used for every Swarm upload. Shown on the
   *  status page so the operator can confirm which stamp is active. */
  postageBatchId: string
  /** True when T4T_STAMP_MANAGE=true and the container is auto-managing the batch. */
  stampManaged: boolean
  /** True when T4T_STAMP_DRY_RUN=true — disables top-up/dilute buttons. */
  stampDryRun: boolean
  /** Operator's intended TTL (days) — used as the default for the top-up input. */
  stampTtlDays: number
  queue: JobQueue
  logger: Logger
  /** Live in-memory offerings map. Edits here are immediately persisted on-chain. */
  offerings: Map<string, ModelOffering>
  /** Push the current offerings map to the registry via updateOfferings(). */
  publishOfferings: () => Promise<void>
}

export function startAdminServer(deps: ProviderAdminDeps): void {
  const app = express()

  app.get('/healthz', (_req, res) => res.json({ok: true}))

  // Polled by the toast widget in every page. Returns transactions submitted
  // after `?since=<unix>` so the JS can render a notification for each new one.
  app.get('/events/tx', (req, res) => {
    const since = Number(req.query.since ?? 0)
    const txs = deps.db.listTransactions({sinceSeconds: since, limit: 20})
    res.json({txs, now: Math.floor(Date.now() / 1000)})
  })

  app.get('/', (_req, res) => {
    const rows = deps.db.listProviderJobs({limit: 200})
    res.send(
      layout({
        title: 't4t provider',
        refreshSeconds: 3,
        active: 'jobs', tabs: PROVIDER_TABS,
        body: jobsPage(rows, deps.db.countProviderByStatus(), deps.db.totalEarnedXBZZ(), deps.statusRefreshSeconds),
      }),
    )
  })

  app.get('/jobs/rows', (_req, res) => {
    const rows = deps.db.listProviderJobs({limit: 200})
    res.send(jobsTableBody(rows))
  })

  app.get('/status', async (_req, res) => {
    const status = await collectStatus(deps).catch(err => ({err: String(err)} as Record<string, unknown>))
    res.send(
      layout({
        title: 't4t provider',
        refreshSeconds: deps.statusRefreshSeconds,
        active: 'status', tabs: PROVIDER_TABS,
        body: statusPage(status, deps.statusRefreshSeconds),
      }),
    )
  })

  app.get('/status/panel', async (_req, res) => {
    const status = await collectStatus(deps).catch(err => ({err: String(err)} as Record<string, unknown>))
    res.send(statusPanels(status))
  })

  app.get('/models', async (_req, res) => {
    const bzzUsd = await getBzzUsd(deps.logger)
    res.send(
      layout({
        title: 't4t provider',
        refreshSeconds: 0,
        active: 'models', tabs: PROVIDER_TABS,
        body: modelsPage([...deps.offerings.values()], bzzUsd),
      }),
    )
  })

  const stampsCfg = {
    bee: deps.bee,
    postageBatchId: deps.postageBatchId,
    managed: deps.stampManaged,
    dryRun: deps.stampDryRun,
    defaultTopUpDays: deps.stampTtlDays,
    logger: deps.logger,
  }
  attachStampsAdmin(app, stampsCfg)

  app.get('/stamps', (_req, res) => {
    res.send(
      layout({
        title: 't4t provider',
        refreshSeconds: 0,
        active: 'stamps', tabs: PROVIDER_TABS,
        body: renderStampsPage(stampsCfg),
      }),
    )
  })

  app.get('/wallet', async (_req, res) => {
    res.send(
      layout({
        title: 't4t provider',
        refreshSeconds: deps.statusRefreshSeconds,
        active: 'wallet', tabs: PROVIDER_TABS,
        body: await walletPage(deps),
      }),
    )
  })

  app.post('/models/:modelId/price', express.urlencoded({extended: false}), async (req, res) => {
    const modelId = req.params.modelId
    const inRaw = String(req.body?.inputBzzPerMillion ?? '').trim()
    const outRaw = String(req.body?.outputBzzPerMillion ?? '').trim()
    const offering = deps.offerings.get(modelId)
    if (!offering) {
      res.status(404).send(`<p class="err">unknown model: ${escape(modelId)}</p>`)
      return
    }
    let inParsed: bigint
    let outParsed: bigint
    try {
      inParsed = parseBzzToPlur(inRaw)
      outParsed = parseBzzToPlur(outRaw)
    } catch (err) {
      res.status(400).send(`<p class="err">invalid price: ${escape((err as Error).message)}</p>`)
      return
    }
    deps.offerings.set(modelId, {
      ...offering,
      inputPricePerMillionTokens: inParsed,
      outputPricePerMillionTokens: outParsed,
    })
    try {
      await deps.publishOfferings()
    } catch (err) {
      deps.offerings.set(modelId, offering) // rollback
      deps.logger.error({err, modelId}, 'updateOfferings tx failed')
      res.status(500).send(`<p class="err">on-chain update failed: ${escape(String((err as Error)?.message ?? err))}</p>`)
      return
    }
    res.send(modelRow(deps.offerings.get(modelId)!))
  })

  app.listen(deps.port, deps.host, () =>
    deps.logger.info({host: deps.host, port: deps.port}, 'admin ui listening'),
  )
}

function modelsPage(offerings: ModelOffering[], bzzUsd: number | null): string {
  if (offerings.length === 0) {
    return `<section><h2>Models</h2><p class="muted">No models registered. Load a model in the backend and restart.</p></section>`
  }
  const usdBadge = bzzUsd
    ? `<span class="mono">1 BZZ ≈ ${bzzUsd.toFixed(4)} USD</span> <span class="muted">(<a href="https://www.coingecko.com/en/coins/swarm" target="_blank" rel="noopener">CoinGecko</a>, 5m cache)</span>`
    : `<span class="muted">USD price unavailable</span>`
  return `
<section>
  <h2>Models</h2>
  <p class="muted">
    Prices are <strong>BZZ per 1,000,000 AI tokens</strong>. Input = prompt AI tokens, output = completion AI tokens.
    Type a decimal BZZ amount; the calculator below shows the on-chain PLUR value and the USD
    equivalent at the current BZZ-USD rate. Edits push <code>updateOfferings</code> on-chain.
  </p>
  <p class="muted" style="margin-top:-6px">
    <span class="mono">1 BZZ = 10^16 PLUR</span> · ${usdBadge}
  </p>
  <table>
    <thead><tr>
      <th>Model</th>
      <th>Input price (BZZ / 1M AI tokens)</th>
      <th>Output price (BZZ / 1M AI tokens)</th>
      <th></th>
    </tr></thead>
    <tbody>
      ${offerings.map(modelRow).join('')}
    </tbody>
  </table>
  <script>
  (() => {
    if (window.__t4tPriceCalcInit) return; window.__t4tPriceCalcInit = true;
    const SCALE = 10n ** 16n;
    const BZZ_USD = ${bzzUsd ?? 'null'};
    function parse(s){
      s = String(s||'').trim();
      if (!/^\\d+(\\.\\d*)?$|^\\.\\d+$/.test(s)) return null;
      const [w='0', f=''] = s.split('.');
      if (f.length > 16) return null;
      return BigInt((w||'0') + (f + '0000000000000000').slice(0,16));
    }
    function formatBzz(plur){
      const w = plur / SCALE, f = plur % SCALE;
      if (f === 0n) return w.toString();
      const s = (f + SCALE).toString().slice(1).replace(/0+$/, '');
      return w.toString() + '.' + s.slice(0, 8);
    }
    function bzzToUsd(plur){
      if (BZZ_USD == null) return null;
      // bzz = plur / 1e16; usd = bzz * BZZ_USD. Use Number once we're down at
      // human magnitudes — losing precision below $1e-12 is fine for display.
      const bzz = Number(plur) / 1e16;
      return bzz * BZZ_USD;
    }
    function fmtUsd(u){
      if (u == null) return '';
      if (u >= 1) return u.toFixed(4) + ' USD';
      if (u >= 0.0001) return u.toFixed(6) + ' USD';
      return u.toExponential(2) + ' USD';
    }
    function updatePreview(input){
      const plur = parse(input.value);
      const hint = input.parentNode.querySelector('.price-hint');
      if (!hint) return;
      if (plur === null){
        hint.textContent = '— invalid';
        hint.className = 'price-hint err mono';
        return;
      }
      const usdPer1M = bzzToUsd(plur);
      const usdLine = usdPer1M != null ? ' · <span>' + fmtUsd(usdPer1M) + ' / 1M AI tokens</span>' : '';
      hint.innerHTML = '<span>' + plur.toString() + ' PLUR / 1M AI tokens</span>' + usdLine;
      hint.className = 'price-hint muted mono';
    }
    document.querySelectorAll('input[data-price]').forEach(el => {
      el.addEventListener('input', () => updatePreview(el));
      updatePreview(el);
    });
    document.body.addEventListener('htmx:afterSwap', () => {
      document.querySelectorAll('input[data-price]').forEach(el => updatePreview(el));
    });
  })();
  </script>
</section>`
}

function modelRow(o: ModelOffering): string {
  const formId = `price-${o.modelId.replace(/[^a-zA-Z0-9-_]/g, '-')}`
  const inputBzz = formatXBZZ(o.inputPricePerMillionTokens)
  const outputBzz = formatXBZZ(o.outputPricePerMillionTokens)
  return `<tr id="${escape(formId)}">
    <form hx-post="/models/${encodeURIComponent(o.modelId)}/price" hx-target="#${escape(formId)}" hx-swap="outerHTML">
      <td class="mono">${escape(o.modelId)}</td>
      <td>
        <input name="inputBzzPerMillion" type="text" inputmode="decimal" data-price="in"
               value="${escape(inputBzz)}" required>
        <div class="price-hint muted mono">${escape(o.inputPricePerMillionTokens.toString())} PLUR / 1M AI tokens</div>
      </td>
      <td>
        <input name="outputBzzPerMillion" type="text" inputmode="decimal" data-price="out"
               value="${escape(outputBzz)}" required>
        <div class="price-hint muted mono">${escape(o.outputPricePerMillionTokens.toString())} PLUR / 1M AI tokens</div>
      </td>
      <td><button type="submit">Save</button></td>
    </form>
  </tr>`
}

function jobsPage(
  rows: ProviderJobRow[],
  counts: Record<string, number>,
  earnedTotal: bigint,
  refreshSec: number,
): string {
  return `
<section>
  <h2>Summary</h2>
  <div class="kv">
    <dt>Total earned</dt><dd>${escape(formatXBZZ(earnedTotal))} xBZZ</dd>
    <dt>Jobs by status</dt><dd>${escape(Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')) || '—'}</dd>
    <dt>In flight (queue)</dt><dd>—</dd>
  </div>
</section>
<section>
  <h2>Jobs (last 7d)</h2>
  <table>
    <thead><tr>
      <th>Job</th><th>Client</th><th>Model</th><th>Status</th>
      <th>Received</th><th>Duration</th><th>AI Token (input/output)</th><th>Earned xBZZ</th><th>Error</th>
    </tr></thead>
    <tbody hx-get="/jobs/rows" hx-trigger="every ${refreshSec}s" hx-target="this" hx-swap="innerHTML">
      ${jobsTableBody(rows)}
    </tbody>
  </table>
</section>`
}

function jobsTableBody(rows: ProviderJobRow[]): string {
  if (rows.length === 0) return `<tr><td colspan="9" class="muted">No jobs yet.</td></tr>`
  return rows
    .map(
      r => `<tr>
      <td class="mono">${escape(shortHex(r.jobId))}</td>
      <td class="mono">${escape(shortHex(r.client))}</td>
      <td>${escape(r.modelId)}</td>
      <td>${statusPill(r.status)}</td>
      <td>${escape(formatTs(r.receivedAt))}</td>
      <td>${escape(formatDuration(r.ackedAt, r.completedAt))}</td>
      <td>${escape(r.promptTokens ?? '—')} / ${escape(r.completionTokens ?? '—')}</td>
      <td>${escape(formatXBZZ(r.earnedXBZZ))}</td>
      <td class="err">${escape(r.errorMessage ?? '')}</td>
    </tr>`,
    )
    .join('')
}

function statusPage(status: Record<string, unknown>, refreshSec: number): string {
  return `
<section>
  <h2>Live status (refreshes every ${refreshSec}s)</h2>
  <div hx-get="/status/panel" hx-trigger="every ${refreshSec}s" hx-target="this" hx-swap="innerHTML">
    ${statusPanels(status)}
  </div>
</section>`
}

function statusPanels(s: Record<string, unknown>): string {
  if (s.err) return `<p class="err">${escape(s.err)}</p>`
  const bee = s.bee as {url: string; ok: boolean; overlay?: string; postageBatchId?: string} | undefined
  const chain = s.chain as {url: string; chainId?: number; block?: bigint; gasBalance?: bigint; xbzzBalance?: bigint} | undefined
  const role = s.role as
    | {stake?: bigint; openJobs?: number; lastHeartbeat?: number; heartbeatStale?: boolean; active?: boolean; address?: string}
    | undefined
  const offerings = (s.offerings ?? []) as ModelOffering[]
  return `
<div class="grid2">
  <section>
    <h2>Bee</h2>
    <dl class="kv">
      <dt>API URL</dt><dd>${escape(bee?.url ?? '')}</dd>
      <dt>Reachable</dt><dd class="${bee?.ok ? 'ok' : 'err'}">${bee?.ok ? 'yes' : 'no'}</dd>
      <dt>Overlay</dt><dd>${escape(bee?.overlay ?? '—')}</dd>
      <dt>Postage batch</dt><dd class="mono">${
        bee?.postageBatchId
          ? `<a href="https://batch-explorer.github.io/batch/${escape(bee.postageBatchId)}" target="_blank" rel="noopener">${escape(bee.postageBatchId)}</a>`
          : '—'
      }</dd>
    </dl>
  </section>
  <section>
    <h2>Gnosis Chain</h2>
    <dl class="kv">
      <dt>RPC URL</dt><dd>${escape(chain?.url ?? '')}</dd>
      <dt>Chain id</dt><dd>${escape(chain?.chainId ?? '—')}</dd>
      <dt>Block</dt><dd>${escape(chain?.block?.toString() ?? '—')}</dd>
      <dt>xDAI (gas)</dt><dd>${escape(formatXBZZ(chain?.gasBalance ?? null))}</dd>
      <dt>xBZZ balance</dt><dd>${escape(formatXBZZ(chain?.xbzzBalance ?? null))}</dd>
    </dl>
  </section>
  <section>
    <h2>Provider role</h2>
    <dl class="kv">
      <dt>Active</dt><dd class="${role?.active ? 'ok' : 'warn'}">${role?.active ? 'yes' : 'no'}</dd>
      <dt>Stake</dt><dd>${escape(formatXBZZ(role?.stake ?? null))} xBZZ</dd>
      <dt>Open jobs</dt><dd>${escape(role?.openJobs ?? '—')}</dd>
      <dt>Last heartbeat</dt>
      <dd class="${role?.heartbeatStale ? 'warn' : 'ok'}">${escape(formatTs(role?.lastHeartbeat ?? null))}${role?.heartbeatStale ? ' (stale)' : ''}</dd>
    </dl>
  </section>
</div>
${clientViewSection(offerings, role?.address)}`
}

/** Read-only mirror of what the t4t client sees when it discovers this provider
 *  through `ProviderRegistry.listProviders` + `getOfferings`. Useful sanity
 *  check that pricing edits actually made it on-chain. */
function clientViewSection(offerings: ModelOffering[], address?: string): string {
  const intro = `<p class="muted">This is exactly what a client discovers when calling
    <span class="mono">getOfferings(${escape(address ?? 'this-provider')})</span> on
    <span class="mono">ProviderRegistry</span>. Prices are xBZZ wei per 1,000,000 tokens.
    Edit them on the <a href="/models">Models</a> page.</p>`
  if (offerings.length === 0) {
    return `<section>
      <h2>What clients see</h2>
      ${intro}
      <p class="warn">No offerings published. Load a model in the backend so the next heartbeat picks it up.</p>
    </section>`
  }
  const rows = offerings
    .map(o => `<tr>
      <td class="mono">${escape(o.modelId)}</td>
      <td><span class="mono">${escape(o.inputPricePerMillionTokens.toString())}</span><br>
          <span class="muted">${escape(formatXBZZ(o.inputPricePerMillionTokens))} xBZZ</span></td>
      <td><span class="mono">${escape(o.outputPricePerMillionTokens.toString())}</span><br>
          <span class="muted">${escape(formatXBZZ(o.outputPricePerMillionTokens))} xBZZ</span></td>
      <td>${escape(Number(o.maxLatencySeconds))}s</td>
      <td>${o.maxContextTokens === 0n ? '<span class="muted">—</span>' : escape(o.maxContextTokens.toString())}</td>
    </tr>`)
    .join('')
  return `
<section>
  <h2>What clients see</h2>
  ${intro}
  <table>
    <thead><tr>
      <th>Model</th>
      <th>Input / 1M AI tokens</th>
      <th>Output / 1M AI tokens</th>
      <th>SLA</th>
      <th>Max ctx</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`
}

async function collectStatus(deps: ProviderAdminDeps): Promise<Record<string, unknown>> {
  const beeUrl = (deps.bee as unknown as {url?: string}).url ?? ''
  const [beeOk, overlay, block, gasBalance, xbzzBalance, provider] = await Promise.all([
    deps.bee
      .getNodeAddresses()
      .then(() => true)
      .catch(() => false),
    deps.bee
      .getNodeAddresses()
      .then(a => a.overlay?.toString())
      .catch(() => undefined),
    deps.chain.pub.getBlockNumber().catch(() => undefined),
    deps.chain.pub.getBalance({address: deps.chain.address}).catch(() => undefined),
    deps.chain.pub
      .readContract({
        address: deps.chain.xbzz,
        abi: [
          {
            type: 'function',
            name: 'balanceOf',
            stateMutability: 'view',
            inputs: [{name: 'o', type: 'address'}],
            outputs: [{type: 'uint256'}],
          },
        ],
        functionName: 'balanceOf',
        args: [deps.chain.address],
      })
      .catch(() => undefined),
    getProvider(deps.chain, deps.chain.address).catch(() => null),
  ])
  const now = Math.floor(Date.now() / 1000)
  return {
    bee: {url: beeUrl, ok: beeOk, overlay, postageBatchId: deps.postageBatchId},
    chain: {
      url: '',
      chainId: deps.chain.pub.chain?.id,
      block,
      gasBalance,
      xbzzBalance,
    },
    role: provider && provider.owner !== '0x0000000000000000000000000000000000000000'
      ? {
          address: deps.chain.address,
          active: provider.active,
          stake: provider.stake,
          openJobs: Number(deps.queue.inFlight),
          lastHeartbeat: Number(provider.lastHeartbeat),
          heartbeatStale: Number(provider.lastHeartbeat) + HEARTBEAT_TTL < now,
        }
      : undefined,
    offerings: [...deps.offerings.values()],
  }
}

async function walletPage(deps: ProviderAdminDeps): Promise<string> {
  const address = deps.chain.address
  const [gas, xbzz] = await Promise.all([
    deps.chain.pub.getBalance({address}).catch(() => undefined),
    deps.chain.pub
      .readContract({
        address: deps.chain.xbzz,
        abi: [
          {
            type: 'function',
            name: 'balanceOf',
            stateMutability: 'view',
            inputs: [{name: 'o', type: 'address'}],
            outputs: [{type: 'uint256'}],
          },
        ],
        functionName: 'balanceOf',
        args: [address],
      })
      .catch(() => undefined),
  ])
  const txs = deps.db.listTransactions({limit: 100})
  return `
<section>
  <h2>Wallet</h2>
  <dl class="kv">
    <dt>Address</dt><dd class="mono">${escape(address)}</dd>
    <dt>xDAI (gas)</dt><dd>${escape(formatXBZZ(gas as bigint | undefined ?? null))}</dd>
    <dt>xBZZ</dt><dd>${escape(formatXBZZ(xbzz as bigint | undefined ?? null))}</dd>
  </dl>
  <p class="muted">Private key is stored at <span class="mono">/data/wallet.key</span> (bind-mounted from the host). To replace it, delete that file and restart — the onboarding UI will reappear.</p>
</section>
${transactionsSection(txs)}`
}

function transactionsSection(txs: import('../../lib/jobs-db').TxRow[]): string {
  if (txs.length === 0) {
    return `<section><h2>Transactions</h2><p class="muted">No on-chain transactions recorded yet.</p></section>`
  }
  const rows = txs.map(t => `<tr>
    <td>${escape(formatTs(t.submittedAt))}</td>
    <td>${escape(t.kind)}</td>
    <td class="mono"><a href="https://gnosisscan.io/tx/${escape(t.hash)}" target="_blank" rel="noopener">${escape(shortHex(t.hash))}</a></td>
    <td class="mono">${escape(shortHex(t.toAddress))}</td>
    <td class="muted">${escape(t.note ?? '')}</td>
  </tr>`).join('')
  return `
<section>
  <h2>Transactions <span class="muted" style="font-weight:normal">(last ${txs.length})</span></h2>
  <table>
    <thead><tr><th>Time (UTC)</th><th>Kind</th><th>Tx</th><th>To</th><th>Note</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`
}
