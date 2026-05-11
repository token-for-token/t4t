import type {ChainClient} from '../../lib/chain'
import {getOfferings, listProviders} from '../../lib/chain'
import type {ModelOffering, ProviderRow} from '../../lib/types'
import {isHeartbeatFresh} from './selector'

export interface ModelSummary {
  /** OpenAI-style model id (e.g. "llama3:8b-instruct"). */
  id: string
  /** Active, heartbeat-fresh providers advertising this model. */
  providerCount: number
  /** xBZZ wei per 1k tokens, across providers. */
  minPricePerKToken: bigint
  /** Median price per 1k tokens — useful for the admin UI. */
  medianPricePerKToken: bigint
  /** Worst declared SLA across the offering set, in seconds. */
  slowestSlaSeconds: number
}

export interface DiscoverDeps {
  chain: ChainClient
  allowedModels?: string[]
  minProvidersPerModel: number
  cacheTtlSeconds: number
  now?: () => number
}

interface CacheEntry {
  expiresAt: number
  data: ModelSummary[]
}

export class ModelDiscovery {
  private cache: CacheEntry | null = null

  constructor(private readonly deps: DiscoverDeps) {}

  async list(): Promise<ModelSummary[]> {
    const now = (this.deps.now ?? Date.now)()
    if (this.cache && this.cache.expiresAt > now) return this.cache.data
    const data = await this.scan()
    this.cache = {data, expiresAt: now + this.deps.cacheTtlSeconds * 1000}
    return data
  }

  invalidate(): void {
    this.cache = null
  }

  private async scan(): Promise<ModelSummary[]> {
    const allow = this.deps.allowedModels
    const nowSec = Math.floor(((this.deps.now ?? Date.now)()) / 1000)
    const byModel = new Map<string, {prices: bigint[]; slowest: number; count: number}>()

    let cursor = 0n
    for (let i = 0; i < 20; i++) {
      const {page, nextCursor} = await listProviders(this.deps.chain, cursor, 50n)
      for (const p of page) {
        if (!isUsable(p, nowSec)) continue
        const offerings = await getOfferings(this.deps.chain, p.owner)
        for (const o of offerings) {
          if (allow && !allow.includes(o.modelId)) continue
          mergeOffering(byModel, o)
        }
      }
      if (nextCursor === cursor || page.length === 0) break
      cursor = nextCursor
    }

    const summaries: ModelSummary[] = []
    for (const [id, agg] of byModel) {
      if (agg.count < this.deps.minProvidersPerModel) continue
      summaries.push({
        id,
        providerCount: agg.count,
        minPricePerKToken: agg.prices.reduce((a, b) => (a < b ? a : b)),
        medianPricePerKToken: median(agg.prices),
        slowestSlaSeconds: agg.slowest,
      })
    }
    summaries.sort((a, b) => a.id.localeCompare(b.id))
    return summaries
  }
}

function isUsable(p: ProviderRow, nowSec: number): boolean {
  if (!p.active) return false
  return isHeartbeatFresh(p.lastHeartbeat, nowSec)
}

function mergeOffering(
  byModel: Map<string, {prices: bigint[]; slowest: number; count: number}>,
  o: ModelOffering,
): void {
  const slot = byModel.get(o.modelId) ?? {prices: [], slowest: 0, count: 0}
  slot.prices.push(o.pricePerKToken)
  slot.slowest = Math.max(slot.slowest, o.maxLatencySeconds)
  slot.count += 1
  byModel.set(o.modelId, slot)
}

function median(values: bigint[]): bigint {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]!
  return (sorted[mid - 1]! + sorted[mid]!) / 2n
}
