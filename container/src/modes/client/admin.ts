import express from 'express'
import type {Bee} from '@ethersphere/bee-js'
import type {ChainClient} from '../../lib/chain'
import type {ClientJobRow, JobsDb} from '../../lib/jobs-db'
import type {Logger} from '../../lib/logger'
import type {ModelDiscovery} from './models'
import {
  escape,
  formatTs,
  formatXBZZ,
  layout,
  shortHex,
  statusPill,
} from '../../lib/admin-html'

export interface ClientAdminDeps {
  host: string
  port: number
  statusRefreshSeconds: number
  payloadsPersisted: boolean
  db: JobsDb
  chain: ChainClient
  bee: Bee
  discovery: ModelDiscovery
  pendingCount: () => number
  logger: Logger
}

export function startAdminServer(deps: ClientAdminDeps): void {
  const app = express()

  app.get('/healthz', (_req, res) => res.json({ok: true}))

  app.get('/admin', (_req, res) => {
    const rows = deps.db.listClientJobs({limit: 200})
    res.send(
      layout({
        title: 't4t client',
        refreshSeconds: 3,
        active: 'jobs',
        body: jobsPage(rows, deps.db.totalSpentXBZZ(), deps.pendingCount(), deps.payloadsPersisted),
      }),
    )
  })

  app.get('/admin/jobs/rows', (_req, res) => {
    const rows = deps.db.listClientJobs({limit: 200})
    res.send(jobsTableBody(rows, deps.payloadsPersisted))
  })

  app.get('/admin/status', async (_req, res) => {
    const status = await collectStatus(deps).catch(err => ({err: String(err)} as Record<string, unknown>))
    res.send(
      layout({
        title: 't4t client',
        refreshSeconds: deps.statusRefreshSeconds,
        active: 'status',
        body: statusPage(status, deps.statusRefreshSeconds),
      }),
    )
  })

  app.get('/admin/status/panel', async (_req, res) => {
    const status = await collectStatus(deps).catch(err => ({err: String(err)} as Record<string, unknown>))
    res.send(statusPanels(status))
  })

  app.get('/admin/models', async (_req, res) => {
    const models = await deps.discovery.list().catch(() => [])
    res.send(
      layout({
        title: 't4t client',
        refreshSeconds: deps.statusRefreshSeconds,
        active: 'models',
        body: modelsPage(models),
      }),
    )
  })

  app.listen(deps.port, deps.host, () =>
    deps.logger.info({host: deps.host, port: deps.port}, 'admin ui listening'),
  )
}

function jobsPage(rows: ClientJobRow[], spent: bigint, pending: number, payloads: boolean): string {
  const success = rows.filter(r => r.status === 'delivered' || r.status === 'claimed').length
  const rate = rows.length === 0 ? '—' : `${Math.round((success * 100) / rows.length)}%`
  return `
<section>
  <h2>Summary</h2>
  <dl class="kv">
    <dt>Total spent</dt><dd>${escape(formatXBZZ(spent))} xBZZ</dd>
    <dt>In-flight</dt><dd>${escape(pending)}</dd>
    <dt>Success rate (7d)</dt><dd>${escape(rate)}</dd>
    <dt>Payload persistence</dt><dd class="${payloads ? 'warn' : 'muted'}">${payloads ? 'on' : 'off (default)'}</dd>
  </dl>
</section>
<section>
  <h2>Jobs (last 7d)</h2>
  <table>
    <thead><tr>
      <th>Job</th><th>Provider</th><th>Model</th><th>Status</th>
      <th>Posted</th><th>Max payment</th><th>Actual</th><th>Tokens (p/c)</th>
      <th>Prompt</th><th>Error</th>
    </tr></thead>
    <tbody hx-get="/admin/jobs/rows" hx-trigger="every 3s" hx-swap="innerHTML">
      ${jobsTableBody(rows, payloads)}
    </tbody>
  </table>
</section>`
}

function jobsTableBody(rows: ClientJobRow[], payloads: boolean): string {
  if (rows.length === 0) return `<tr><td colspan="10" class="muted">No jobs yet.</td></tr>`
  return rows
    .map(
      r => `<tr>
      <td class="mono">${escape(shortHex(r.jobId))}</td>
      <td class="mono">${escape(shortHex(r.provider))}</td>
      <td>${escape(r.modelId)}</td>
      <td>${statusPill(r.status)}</td>
      <td>${escape(formatTs(r.postedAt))}</td>
      <td>${escape(formatXBZZ(r.maxPayment))}</td>
      <td>${escape(formatXBZZ(r.actualPayment))}</td>
      <td>${escape(r.promptTokens ?? '—')} / ${escape(r.completionTokens ?? '—')}</td>
      <td>${escape((payloads && r.prompt ? r.prompt.slice(0, 80) : r.prompt) ?? '')}</td>
      <td class="err">${escape(r.errorMessage ?? '')}</td>
    </tr>`,
    )
    .join('')
}

function statusPage(status: Record<string, unknown>, refreshSec: number): string {
  return `
<section>
  <h2>Live status (refreshes every ${refreshSec}s)</h2>
  <div hx-get="/admin/status/panel" hx-trigger="every ${refreshSec}s" hx-swap="innerHTML">
    ${statusPanels(status)}
  </div>
</section>`
}

function statusPanels(s: Record<string, unknown>): string {
  if (s.err) return `<p class="err">${escape(s.err)}</p>`
  const bee = s.bee as {url: string; ok: boolean; overlay?: string} | undefined
  const chain = s.chain as {chainId?: number; block?: bigint; gasBalance?: bigint; xbzzBalance?: bigint} | undefined
  const role = s.role as {pending?: number; lastSuccess?: number} | undefined
  return `
<div class="grid2">
  <section>
    <h2>Bee</h2>
    <dl class="kv">
      <dt>API URL</dt><dd>${escape(bee?.url ?? '')}</dd>
      <dt>Reachable</dt><dd class="${bee?.ok ? 'ok' : 'err'}">${bee?.ok ? 'yes' : 'no'}</dd>
      <dt>Overlay</dt><dd>${escape(bee?.overlay ?? '—')}</dd>
    </dl>
  </section>
  <section>
    <h2>Gnosis Chain</h2>
    <dl class="kv">
      <dt>Chain id</dt><dd>${escape(chain?.chainId ?? '—')}</dd>
      <dt>Block</dt><dd>${escape(chain?.block?.toString() ?? '—')}</dd>
      <dt>xDAI (gas)</dt><dd>${escape(formatXBZZ(chain?.gasBalance ?? null))}</dd>
      <dt>xBZZ balance</dt><dd>${escape(formatXBZZ(chain?.xbzzBalance ?? null))}</dd>
    </dl>
  </section>
  <section>
    <h2>Client role</h2>
    <dl class="kv">
      <dt>Pending jobs</dt><dd>${escape(role?.pending ?? '—')}</dd>
      <dt>Last success</dt><dd>${escape(formatTs(role?.lastSuccess ?? null))}</dd>
    </dl>
  </section>
</div>`
}

function modelsPage(models: import('./models').ModelSummary[]): string {
  const body = models.length === 0
    ? `<tr><td colspan="5" class="muted">No models discovered yet.</td></tr>`
    : models
        .map(
          m => `<tr>
        <td>${escape(m.id)}</td>
        <td>${escape(m.providerCount)}</td>
        <td>${escape(formatXBZZ(m.minPricePerKToken))}</td>
        <td>${escape(formatXBZZ(m.medianPricePerKToken))}</td>
        <td>${escape(m.slowestSlaSeconds)}s</td>
      </tr>`,
        )
        .join('')
  return `
<section>
  <h2>Discovered models</h2>
  <table>
    <thead><tr>
      <th>Model</th><th>Providers</th><th>Min price / 1k</th><th>Median price / 1k</th><th>Slowest SLA</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>
</section>`
}

async function collectStatus(deps: ClientAdminDeps): Promise<Record<string, unknown>> {
  const beeUrl = (deps.bee as unknown as {url?: string}).url ?? ''
  const [beeOk, overlay, block, gasBalance, xbzzBalance] = await Promise.all([
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
  ])
  const lastSuccess = deps.db
    .listClientJobs({limit: 1})
    .find(r => r.status === 'delivered' || r.status === 'claimed')?.deliveredAt
  return {
    bee: {url: beeUrl, ok: beeOk, overlay},
    chain: {chainId: deps.chain.pub.chain?.id, block, gasBalance, xbzzBalance},
    role: {pending: deps.pendingCount(), lastSuccess},
  }
}
