/**
 * Shared admin UI for container-managed postage stamps.
 *
 * Mounted by both provider and gateway admin servers. Exposes:
 *   GET  /stamps           — page with current batch summary + buttons.
 *   GET  /stamps/panel     — htmx-polled inner panel (used by /status too).
 *   POST /stamps/topup     — extend TTL by N days (confirmation required).
 *   POST /stamps/dilute    — grow capacity by raising depth (confirmation).
 */

import express from 'express'
import type {Bee} from '@ethersphere/bee-js'
import type {Logger} from './logger'
import {escape, formatXBZZ} from './admin-html'
import {manualDilute, manualTopUp, stampWalletCostWei, amountForTtl} from './stamps'

interface BatchLike {
  batchID: {toString(): string}
  label: string
  usable: boolean
  depth: number
  amount: string
  utilization: number
  usage: number
  usageText: string
  duration: {toDays(): number; toSeconds(): number}
}

export interface StampsAdminConfig {
  bee: Bee
  /** The batch resolved at boot. UI calls /stamps/topup / /stamps/dilute on this one. */
  postageBatchId: string
  /** Whether the container is in `T4T_STAMP_MANAGE=true` mode. Affects copy
   *  (auto-top-up note) but the manual buttons work regardless. */
  managed: boolean
  /** Whether T4T_STAMP_DRY_RUN is on — if so, mutation buttons no-op + warn. */
  dryRun: boolean
  /** Operator's intended TTL — used as the default "extend by N days" input. */
  defaultTopUpDays: number
  logger: Logger
}

/** Mount /stamps routes on the given Express app. */
export function attachStampsAdmin(app: express.Express, cfg: StampsAdminConfig): void {
  app.get('/stamps/panel', async (_req, res) => {
    const html = await renderStampsPanel(cfg).catch(err => `<p class="err">${escape(String(err))}</p>`)
    res.send(html)
  })

  app.post('/stamps/topup', express.urlencoded({extended: false}), async (req, res) => {
    if (cfg.dryRun) {
      res.status(400).send(`<p class="err">T4T_STAMP_DRY_RUN=true — refusing to submit top-up tx.</p>`)
      return
    }
    const days = Number(req.body?.days ?? cfg.defaultTopUpDays)
    if (!Number.isFinite(days) || days <= 0) {
      res.status(400).send(`<p class="err">Invalid "days" value.</p>`)
      return
    }
    try {
      const amount = await manualTopUp(cfg.bee, cfg.postageBatchId, days)
      cfg.logger.info({batchId: cfg.postageBatchId, days, amount: amount.toString()}, 'manual top-up submitted')
      res.send(await renderStampsPanel(cfg))
    } catch (err) {
      cfg.logger.error({err, batchId: cfg.postageBatchId}, 'manual top-up failed')
      res.status(500).send(`<p class="err">Top-up failed: ${escape(String((err as Error)?.message ?? err))}</p>`)
    }
  })

  app.post('/stamps/dilute', express.urlencoded({extended: false}), async (req, res) => {
    if (cfg.dryRun) {
      res.status(400).send(`<p class="err">T4T_STAMP_DRY_RUN=true — refusing to submit dilute tx.</p>`)
      return
    }
    const newDepth = Number(req.body?.depth)
    if (!Number.isInteger(newDepth) || newDepth < 17 || newDepth > 255) {
      res.status(400).send(`<p class="err">Invalid depth (must be 17..255).</p>`)
      return
    }
    try {
      await manualDilute(cfg.bee, cfg.postageBatchId, newDepth)
      cfg.logger.info({batchId: cfg.postageBatchId, newDepth}, 'manual dilute submitted')
      res.send(await renderStampsPanel(cfg))
    } catch (err) {
      cfg.logger.error({err, batchId: cfg.postageBatchId}, 'manual dilute failed')
      res.status(500).send(`<p class="err">Dilute failed: ${escape(String((err as Error)?.message ?? err))}</p>`)
    }
  })
}

async function fetchBatch(cfg: StampsAdminConfig): Promise<BatchLike | null> {
  try {
    return (await cfg.bee.getPostageBatch(cfg.postageBatchId)) as unknown as BatchLike
  } catch (err) {
    cfg.logger.warn({err, batchId: cfg.postageBatchId}, 'getPostageBatch failed in admin UI')
    return null
  }
}

export function renderStampsPage(cfg: StampsAdminConfig): string {
  return `
<section>
  <h2>Postage stamp</h2>
  <p class="muted">
    ${cfg.managed
      ? `This container manages the postage batch automatically — it auto-tops-up below the TTL threshold.`
      : `This container is using a non-managed batch — buy / top-up via the Bee dashboard or set <span class="mono">T4T_STAMP_MANAGE=true</span> to let the container handle it.`}
    Top-up extends TTL (xBZZ from the Bee node's wallet). Dilute grows capacity by raising depth — it's free but halves remaining TTL per +1 depth.
  </p>
  <div hx-get="/stamps/panel" hx-trigger="load, every 15s" hx-swap="innerHTML">
    <p class="muted">Loading…</p>
  </div>
</section>`
}

export async function renderStampsPanel(cfg: StampsAdminConfig): Promise<string> {
  const batch = await fetchBatch(cfg)
  if (!batch) {
    return `<p class="err">Batch <span class="mono">${escape(cfg.postageBatchId)}</span> not found on Bee.</p>`
  }
  const remainingDays = batch.duration.toDays()
  const ttlPill = remainingDays < 1
    ? `<span class="err">${escape(remainingDays.toFixed(2))}d (expired)</span>`
    : remainingDays < 7
      ? `<span class="warn">${escape(remainingDays.toFixed(1))}d</span>`
      : `<span class="ok">${escape(remainingDays.toFixed(1))}d</span>`

  // Estimate the next top-up cost so the operator sees the xBZZ impact
  // before clicking Top up. Fails open — if Bee's chainstate is unreachable
  // we just hide the preview row.
  let costPreview = ''
  try {
    const amt = await amountForTtl(cfg.bee, cfg.defaultTopUpDays)
    const walletCost = stampWalletCostWei(amt, batch.depth)
    costPreview = `<dt>Next top-up cost (${cfg.defaultTopUpDays}d)</dt><dd>${escape(formatXBZZ(walletCost))} xBZZ</dd>`
  } catch {
    // no-op
  }

  const dryRunBanner = cfg.dryRun
    ? `<p class="warn">T4T_STAMP_DRY_RUN is on — top-up and dilute buttons are disabled.</p>`
    : ''

  return `
${dryRunBanner}
<dl class="kv">
  <dt>Batch ID</dt><dd class="mono"><a href="https://batch-explorer.github.io/batch/${escape(batch.batchID.toString())}" target="_blank" rel="noopener">${escape(batch.batchID.toString())}</a></dd>
  <dt>Label</dt><dd>${escape(batch.label || '(unlabelled)')}</dd>
  <dt>Usable</dt><dd class="${batch.usable ? 'ok' : 'err'}">${batch.usable ? 'yes' : 'no'}</dd>
  <dt>Depth</dt><dd>${escape(batch.depth)} (2^${escape(batch.depth)} chunks)</dd>
  <dt>Remaining TTL</dt><dd>${ttlPill}</dd>
  <dt>Utilization</dt><dd>${escape(batch.usageText ?? Math.round(batch.usage * 100) + '%')}</dd>
  ${costPreview}
</dl>
<div class="grid2">
  <section>
    <h3>Top up</h3>
    <p class="muted">Extend remaining TTL. Cost scales with depth (2^depth chunks × amount).</p>
    <form hx-post="/stamps/topup" hx-target="closest div[hx-get='/stamps/panel']" hx-swap="innerHTML"
          hx-confirm="Submit top-up tx? xBZZ will be spent from the Bee node's wallet.">
      <label class="inline">Extend by
        <input type="text" inputmode="numeric" name="days" value="${escape(cfg.defaultTopUpDays)}" required style="width:6em">
        days
      </label>
      <button type="submit"${cfg.dryRun ? ' disabled' : ''}>Top up</button>
    </form>
  </section>
  <section>
    <h3>Dilute (grow capacity)</h3>
    <p class="muted">Raise depth to double capacity. Free, but halves remaining TTL per +1 depth — top up first if TTL is tight.</p>
    <form hx-post="/stamps/dilute" hx-target="closest div[hx-get='/stamps/panel']" hx-swap="innerHTML"
          hx-confirm="Submit dilute tx? Remaining TTL will halve per +1 depth.">
      <label class="inline">New depth
        <input type="text" inputmode="numeric" name="depth" value="${escape(batch.depth + 1)}" required style="width:6em">
      </label>
      <button type="submit"${cfg.dryRun ? ' disabled' : ''}>Dilute</button>
    </form>
  </section>
</div>`
}
