import type {ChainClient} from '../../lib/chain'
import {getOfferings, listProviders} from '../../lib/chain'
import type {ModelOffering, ProviderRow} from '../../lib/types'
import {isHeartbeatFresh} from './selector'

export interface ModelSummary {
  /** OpenAI-style model id (e.g. "llama3:8b-instruct"). */
  id: string
  /** Active, heartbeat-fresh providers advertising this model. */
  providerCount: number
  /** Min input price (xBZZ wei per 1M tokens) across providers. */
  minInputPrice: bigint
  /** Median input price. */
  medianInputPrice: bigint
  /** Min output price (xBZZ wei per 1M tokens) across providers. */
  minOutputPrice: bigint
  /** Median output price. */
  medianOutputPrice: bigint
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

/** A provider plus the model offerings it currently advertises. */
export interface ProviderListing {
  provider: ProviderRow
  offerings: ModelOffering[]
}

interface CacheEntry<T> {
  expiresAt: number
  data: T
}

export class ModelDiscovery {
  private modelsCache: CacheEntry<ModelSummary[]> | null = null
  private providersCache: CacheEntry<ProviderListing[]> | null = null

  constructor(private readonly deps: DiscoverDeps) {}

  async list(): Promise<ModelSummary[]> {
    const now = (this.deps.now ?? Date.now)()
    if (this.modelsCache && this.modelsCache.expiresAt > now) return this.modelsCache.data
    const {summaries} = await this.scan()
    this.modelsCache = {data: summaries, expiresAt: now + this.deps.cacheTtlSeconds * 1000}
    return summaries
  }

  async listProviders(): Promise<ProviderListing[]> {
    const now = (this.deps.now ?? Date.now)()
    if (this.providersCache && this.providersCache.expiresAt > now) return this.providersCache.data
    const {providers} = await this.scan()
    this.providersCache = {data: providers, expiresAt: now + this.deps.cacheTtlSeconds * 1000}
    return providers
  }

  invalidate(): void {
    this.modelsCache = null
    this.providersCache = null
  }

  private async scan(): Promise<{summaries: ModelSummary[]; providers: ProviderListing[]}> {
    const allow = this.deps.allowedModels
    const nowSec = Math.floor(((this.deps.now ?? Date.now)()) / 1000)
    const byModel = new Map<string, {inputPrices: bigint[]; outputPrices: bigint[]; slowest: number; count: number}>()
    const providers: ProviderListing[] = []

    let cursor = 0n
    for (let i = 0; i < 20; i++) {
      const {page, nextCursor} = await listProviders(this.deps.chain, cursor, 50n)
      for (const p of page) {
        if (!isUsable(p, nowSec)) continue
        const offerings = await getOfferings(this.deps.chain, p.owner)
        const visible = allow ? offerings.filter(o => allow.includes(o.modelId)) : offerings
        if (visible.length > 0) providers.push({provider: p, offerings: visible})
        for (const o of visible) mergeOffering(byModel, o)
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
        minInputPrice: agg.inputPrices.reduce((a, b) => (a < b ? a : b)),
        medianInputPrice: median(agg.inputPrices),
        minOutputPrice: agg.outputPrices.reduce((a, b) => (a < b ? a : b)),
        medianOutputPrice: median(agg.outputPrices),
        slowestSlaSeconds: agg.slowest,
      })
    }
    summaries.sort((a, b) => a.id.localeCompare(b.id))
    providers.sort((a, b) => a.provider.owner.localeCompare(b.provider.owner))
    return {summaries, providers}
  }
}

function isUsable(p: ProviderRow, nowSec: number): boolean {
  if (!p.active) return false
  return isHeartbeatFresh(p.lastHeartbeat, nowSec)
}

function mergeOffering(
  byModel: Map<string, {inputPrices: bigint[]; outputPrices: bigint[]; slowest: number; count: number}>,
  o: ModelOffering,
): void {
  const slot = byModel.get(o.modelId) ?? {inputPrices: [], outputPrices: [], slowest: 0, count: 0}
  slot.inputPrices.push(o.inputPricePerMillionTokens)
  slot.outputPrices.push(o.outputPricePerMillionTokens)
  slot.slowest = Math.max(slot.slowest, Number(o.maxLatencySeconds))
  slot.count += 1
  byModel.set(o.modelId, slot)
}

function median(values: bigint[]): bigint {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]!
  return (sorted[mid - 1]! + sorted[mid]!) / 2n
}
