/**
 * Container-managed Swarm postage stamps.
 *
 * Pure, mode-agnostic helpers wrapping the Bee `/stamps` and `/chainstate`
 * endpoints. The provider and gateway modes both call `ensureManagedStamp()`
 * on boot and `topUpIfBelow()` on a background tick.
 *
 * Operator intent (depth + TTL) is configured via the `T4T_STAMP_*` env vars
 * in `config.ts`; the raw `amount` (per-chunk wei budget) is derived from
 * `getChainState().currentPrice × blocksPerDay × ttlDays`.
 *
 * If `POSTAGE_BATCH_ID` is set, that escape hatch wins and this module is
 * never consulted — the operator owns the batch lifecycle.
 */

import type {Bee} from '@ethersphere/bee-js'
import type {Logger} from './logger'

// Gnosis Chain block time is ~5s; 86400/5 = 17280.
export const BLOCKS_PER_DAY_GNOSIS = 17280n

export interface StampManageOpts {
  depth: number
  ttlDays: number
  minTtlDays: number
  label: string
  dryRun: boolean
}

export interface ManagedStamp {
  batchID: string
  /** Source of the resolved id, for log/UI display. */
  source: 'env' | 'reused' | 'bought' | 'discovered'
  depth: number
  remainingDays: number
  usable: boolean
  utilization: number
  usage: number
  usageText: string
  label: string
}

/** xBZZ cost to buy/top-up a stamp = amount × 2^depth (Bee charges the node
 *  wallet, not the container's wallet). Used for log/UI cost preview only. */
export function stampWalletCostWei(amount: bigint, depth: number): bigint {
  return amount * (1n << BigInt(depth))
}

/** Wei budget per chunk per block, multiplied across the TTL window — the
 *  value Bee expects as `amount` in POST /stamps/{amount}/{depth}. */
export async function amountForTtl(bee: Bee, ttlDays: number): Promise<bigint> {
  const state = await bee.getChainState()
  const price = BigInt(state.currentPrice)
  if (price <= 0n) throw new Error(`Bee returned non-positive chainstate.currentPrice (${state.currentPrice})`)
  return price * BLOCKS_PER_DAY_GNOSIS * BigInt(Math.max(1, Math.trunc(ttlDays)))
}

interface BatchLike {
  batchID: {toString(): string}
  label: string
  usable: boolean
  depth: number
  utilization: number
  usage: number
  usageText: string
  duration: {toDays(): number}
}

export function summariseBatch(b: BatchLike, source: ManagedStamp['source']): ManagedStamp {
  return {
    batchID: b.batchID.toString(),
    source,
    depth: b.depth,
    remainingDays: b.duration.toDays(),
    usable: b.usable,
    utilization: b.utilization,
    usage: b.usage,
    usageText: b.usageText,
    label: b.label,
  }
}

/** Pick the best batch with the configured label the node already owns: must
 *  be usable and have remaining TTL ≥ minTtlDays. Tiebreak by longest
 *  remaining TTL so we converge on the youngest batch when an old one is
 *  about to expire. */
export function pickReusable<T extends BatchLike>(
  all: T[],
  label: string,
  minTtlDays: number,
): T | null {
  const candidates = all
    .filter(b => b.label === label && b.usable && b.duration.toDays() >= minTtlDays)
    .sort((a, b) => b.duration.toDays() - a.duration.toDays())
  return candidates[0] ?? null
}

/** Same label but TTL too short — caller can top up rather than buy fresh. */
export function pickToppable<T extends BatchLike>(
  all: T[],
  label: string,
): T | null {
  const candidates = all
    .filter(b => b.label === label && b.usable)
    .sort((a, b) => b.duration.toDays() - a.duration.toDays())
  return candidates[0] ?? null
}

/** List all batches via Bee — typed loosely so it adapts to bee-js shape
 *  changes (the module only cares about a handful of fields). */
async function listAllBatches(bee: Bee): Promise<BatchLike[]> {
  return (await bee.getAllPostageBatch()) as unknown as BatchLike[]
}

/** Read-only probe: does the Bee node already own a usable batch labelled
 *  `label` with TTL ≥ `minTtlDays`? Used by the onboarding recheck so we don't
 *  trigger expensive buy attempts every 10s while the operator funds the node. */
export async function hasReusableLabeledBatch(
  bee: Bee,
  label: string,
  minTtlDays: number,
): Promise<boolean> {
  const all = await listAllBatches(bee).catch(() => [] as BatchLike[])
  return pickReusable(all, label, minTtlDays) !== null
}

export interface EnsureStampDeps {
  bee: Bee
  logger: Logger
  opts: StampManageOpts
}

/**
 * Resolve a managed batch — list, reuse, top-up-then-reuse, or buy.
 * Idempotent: safe to call from many container instances against the same Bee
 * node; they converge on the longest-lived `label` batch.
 */
export async function ensureManagedStamp(deps: EnsureStampDeps): Promise<ManagedStamp> {
  const {bee, logger, opts} = deps
  const log = logger.child({stamps: true})

  const all = await listAllBatches(bee)

  const reusable = pickReusable(all, opts.label, opts.minTtlDays)
  if (reusable) {
    log.info(
      {batchID: reusable.batchID.toString(), label: opts.label, remainingDays: reusable.duration.toDays(), depth: reusable.depth},
      'reusing existing labelled batch',
    )
    return summariseBatch(reusable, 'reused')
  }

  const toppable = pickToppable(all, opts.label)
  if (toppable) {
    if (opts.dryRun) {
      log.warn({batchID: toppable.batchID.toString()}, 'dry-run: would top up existing batch instead of buying')
      return summariseBatch(toppable, 'reused')
    }
    const amount = await amountForTtl(bee, opts.ttlDays)
    log.info(
      {
        batchID: toppable.batchID.toString(),
        label: opts.label,
        amount: amount.toString(),
        walletCost: stampWalletCostWei(amount, toppable.depth).toString(),
      },
      'topping up under-TTL labelled batch instead of buying new',
    )
    await bee.topUpBatch(toppable.batchID.toString(), amount)
    const refreshed = (await listAllBatches(bee)).find(
      b => b.batchID.toString() === toppable.batchID.toString(),
    )
    return summariseBatch(refreshed ?? toppable, 'reused')
  }

  // No reusable batch — buy fresh.
  const amount = await amountForTtl(bee, opts.ttlDays)
  const walletCost = stampWalletCostWei(amount, opts.depth)
  log.info(
    {
      depth: opts.depth,
      ttlDays: opts.ttlDays,
      amount: amount.toString(),
      walletCost: walletCost.toString(),
      label: opts.label,
      dryRun: opts.dryRun,
    },
    opts.dryRun ? 'dry-run: would buy postage batch' : 'buying new postage batch',
  )
  if (opts.dryRun) {
    throw new Error(
      'T4T_STAMP_DRY_RUN=true and no reusable batch exists — refusing to buy. ' +
      'Disable dry-run or pre-purchase a batch labelled "' + opts.label + '".',
    )
  }
  const batchId = await bee.createPostageBatch(amount, opts.depth, {
    label: opts.label,
    waitForUsable: true,
  })
  const idStr = batchId.toString()
  log.info({batchID: idStr}, 'postage batch bought and usable')
  const refreshed = (await listAllBatches(bee)).find(b => b.batchID.toString() === idStr)
  if (!refreshed) {
    // Bee returned the id but list missed it — return a minimal stub.
    return {
      batchID: idStr,
      source: 'bought',
      depth: opts.depth,
      remainingDays: opts.ttlDays,
      usable: true,
      utilization: 0,
      usage: 0,
      usageText: '0%',
      label: opts.label,
    }
  }
  return summariseBatch(refreshed, 'bought')
}

export interface TopUpIfBelowDeps {
  bee: Bee
  logger: Logger
  batchId: string
  ttlDays: number
  minTtlDays: number
  /** Auto-dilute (raise depth by +1) when utilization crosses this fraction.
   *  Doubles bucket capacity but halves remaining TTL, so we top up first when
   *  TTL is also under threshold. Set to 1.0 to disable. */
  maxUtilization: number
  /** Hard cap so an unexpected utilization spike can't run depth to infinity. */
  maxDepth: number
  dryRun: boolean
}

/** Background tick: top up if remaining TTL falls below `minTtlDays`, and
 *  dilute if utilization crosses `maxUtilization`. Returns the post-tick
 *  remaining-days for the admin UI to surface. */
export async function topUpIfBelow(deps: TopUpIfBelowDeps): Promise<{toppedUp: boolean; diluted: boolean; remainingDays: number}> {
  const all = await listAllBatches(deps.bee)
  let batch = all.find(b => b.batchID.toString() === deps.batchId)
  if (!batch) {
    deps.logger.warn({batchId: deps.batchId}, 'managed batch not found on Bee — skipping top-up tick')
    return {toppedUp: false, diluted: false, remainingDays: 0}
  }
  let toppedUp = false
  let diluted = false

  // Top-up first — diluting halves remaining TTL, so if we're already short
  // we'd push the batch below the floor.
  const remaining = batch.duration.toDays()
  if (remaining < deps.minTtlDays) {
    if (deps.dryRun) {
      deps.logger.warn({batchId: deps.batchId, remaining, threshold: deps.minTtlDays}, 'dry-run: would auto-top-up')
    } else {
      const amount = await amountForTtl(deps.bee, deps.ttlDays)
      deps.logger.info(
        {
          batchId: deps.batchId,
          remaining,
          threshold: deps.minTtlDays,
          amount: amount.toString(),
          walletCost: stampWalletCostWei(amount, batch.depth).toString(),
        },
        'auto-topping up managed batch',
      )
      await deps.bee.topUpBatch(deps.batchId, amount)
      toppedUp = true
      batch = (await listAllBatches(deps.bee)).find(b => b.batchID.toString() === deps.batchId) ?? batch
    }
  }

  // Auto-dilute on high utilization. Bee tracks the most-loaded bucket; one
  // hot bucket can spike utilization long before "total bytes" is anywhere
  // near full, so this kicks in earlier than the operator expects.
  if (batch.usage >= deps.maxUtilization && batch.depth < deps.maxDepth) {
    const newDepth = batch.depth + 1
    if (deps.dryRun) {
      deps.logger.warn({batchId: deps.batchId, usage: batch.usage, from: batch.depth, to: newDepth}, 'dry-run: would auto-dilute')
    } else {
      deps.logger.info({batchId: deps.batchId, usage: batch.usage, from: batch.depth, to: newDepth}, 'auto-diluting managed batch')
      await deps.bee.diluteBatch(deps.batchId, newDepth)
      diluted = true
      batch = (await listAllBatches(deps.bee)).find(b => b.batchID.toString() === deps.batchId) ?? batch
    }
  }

  return {toppedUp, diluted, remainingDays: batch.duration.toDays()}
}

/** Manual top-up triggered from the admin UI. Amount is derived from the
 *  same TTL math so the UI just asks for "days" and the math stays one place. */
export async function manualTopUp(
  bee: Bee,
  batchId: string,
  ttlDays: number,
): Promise<bigint> {
  const amount = await amountForTtl(bee, ttlDays)
  await bee.topUpBatch(batchId, amount)
  return amount
}

/** Manual dilute (grow capacity) triggered from the admin UI. Halves
 *  remaining TTL per +1 depth — caller should confirm in UI. */
export async function manualDilute(bee: Bee, batchId: string, newDepth: number): Promise<void> {
  await bee.diluteBatch(batchId, newDepth)
}
