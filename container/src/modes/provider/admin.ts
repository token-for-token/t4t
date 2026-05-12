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
  shortHex,
  statusPill,
} from '../../lib/admin-html'

const HEARTBEAT_TTL = 600

export interface ProviderAdminDeps {
  host: string
  port: number
  statusRefreshSeconds: number
  db: JobsDb
  chain: ChainClient
  bee: Bee
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

  app.get('/admin', (_req, res) => {
    const rows = deps.db.listProviderJobs({limit: 200})
    res.send(
      layout({
        title: 't4t provider',
        refreshSeconds: 3,
        active: 'jobs',
        body: jobsPage(rows, deps.db.countProviderByStatus(), deps.db.totalEarnedXBZZ(), deps.statusRefreshSeconds),
      }),
    )
  })

  app.get('/admin/jobs/rows', (_req, res) => {
    const rows = deps.db.listProviderJobs({limit: 200})
    res.send(jobsTableBody(rows))
  })

  app.get('/admin/status', async (_req, res) => {
    const status = await collectStatus(deps).catch(err => ({err: String(err)} as Record<string, unknown>))
    res.send(
      layout({
        title: 't4t provider',
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

  app.get('/admin/models', (_req, res) => {
    res.send(
      layout({
        title: 't4t provider',
        refreshSeconds: 0,
        active: 'models',
        body: modelsPage([...deps.offerings.values()]),
      }),
    )
  })

  app.post('/admin/models/:modelId/price', express.urlencoded({extended: false}), async (req, res) => {
    const modelId = req.params.modelId
    const inRaw = String(req.body?.inputPricePerMillionTokens ?? '').trim()
    const outRaw = String(req.body?.outputPricePerMillionTokens ?? '').trim()
    const offering = deps.offerings.get(modelId)
    if (!offering) {
      res.status(404).send(`<p class="err">unknown model: ${escape(modelId)}</p>`)
      return
    }
    let inParsed: bigint
    let outParsed: bigint
    try {
      inParsed = BigInt(inRaw)
      outParsed = BigInt(outRaw)
      if (inParsed < 0n || outParsed < 0n) throw new Error('negative')
    } catch {
      res.status(400).send(`<p class="err">invalid price (in=${escape(inRaw)} out=${escape(outRaw)})</p>`)
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

function modelsPage(offerings: ModelOffering[]): string {
  if (offerings.length === 0) {
    return `<section><h2>Models</h2><p class="muted">No models registered. Load a model in the backend and restart.</p></section>`
  }
  return `
<section>
  <h2>Models</h2>
  <p class="muted">Prices are xBZZ wei per 1,000,000 tokens. Input = prompt tokens, output = completion tokens. Edits push <code>updateOfferings</code> on-chain.</p>
  <table>
    <thead><tr>
      <th>Model</th>
      <th>Input price (wei / 1M)</th>
      <th>Input (xBZZ)</th>
      <th>Output price (wei / 1M)</th>
      <th>Output (xBZZ)</th>
      <th></th>
    </tr></thead>
    <tbody>
      ${offerings.map(modelRow).join('')}
    </tbody>
  </table>
</section>`
}

function modelRow(o: ModelOffering): string {
  const formId = `price-${o.modelId.replace(/[^a-zA-Z0-9-_]/g, '-')}`
  return `<tr id="${escape(formId)}">
    <form hx-post="/admin/models/${encodeURIComponent(o.modelId)}/price" hx-target="#${escape(formId)}" hx-swap="outerHTML">
      <td class="mono">${escape(o.modelId)}</td>
      <td><input name="inputPricePerMillionTokens" type="text" inputmode="numeric" value="${escape(o.inputPricePerMillionTokens.toString())}" required></td>
      <td class="mono">${escape(formatXBZZ(o.inputPricePerMillionTokens))}</td>
      <td><input name="outputPricePerMillionTokens" type="text" inputmode="numeric" value="${escape(o.outputPricePerMillionTokens.toString())}" required></td>
      <td class="mono">${escape(formatXBZZ(o.outputPricePerMillionTokens))}</td>
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
      <th>Received</th><th>Duration</th><th>Tokens (p/c)</th><th>Earned</th><th>Error</th>
    </tr></thead>
    <tbody hx-get="/admin/jobs/rows" hx-trigger="every ${refreshSec}s" hx-swap="innerHTML">
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
  <div hx-get="/admin/status/panel" hx-trigger="every ${refreshSec}s" hx-swap="innerHTML">
    ${statusPanels(status)}
  </div>
</section>`
}

function statusPanels(s: Record<string, unknown>): string {
  if (s.err) return `<p class="err">${escape(s.err)}</p>`
  const bee = s.bee as {url: string; ok: boolean; overlay?: string} | undefined
  const chain = s.chain as {url: string; chainId?: number; block?: bigint; gasBalance?: bigint; xbzzBalance?: bigint} | undefined
  const role = s.role as
    | {stake?: bigint; openJobs?: number; lastHeartbeat?: number; heartbeatStale?: boolean; active?: boolean}
    | undefined
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
</div>`
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
    bee: {url: beeUrl, ok: beeOk, overlay},
    chain: {
      url: '',
      chainId: deps.chain.pub.chain?.id,
      block,
      gasBalance,
      xbzzBalance,
    },
    role: provider && provider.owner !== '0x0000000000000000000000000000000000000000'
      ? {
          active: provider.active,
          stake: provider.stake,
          openJobs: Number(deps.queue.inFlight),
          lastHeartbeat: Number(provider.lastHeartbeat),
          heartbeatStale: Number(provider.lastHeartbeat) + HEARTBEAT_TTL < now,
        }
      : undefined,
  }
}
