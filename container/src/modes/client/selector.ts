import type {Address} from 'viem'
import type {ChainClient} from '../../lib/chain'
import {getOfferings, listProviders} from '../../lib/chain'
import type {ModelOffering, ProviderRow} from '../../lib/types'

export type SelectionStrategy = 'cheapest' | 'top_rep_cheapest' | 'manual'

export interface SelectionContext {
  modelId: string
  /** Optional cap (xBZZ wei per 1k tokens). */
  maxPrice?: bigint
  /** Required when strategy = 'manual'. */
  manualProvider?: Address
}

export interface CandidateProvider {
  provider: ProviderRow
  offering: ModelOffering
}

const MIN_TOTAL_JOBS = 20
const MIN_SUCCESS_RATE = 0.95
/** Share of routes given to new providers so they can build reputation. */
const EXPLORATION_SHARE = 0.05
/** Matches `ProviderRegistry.HEARTBEAT_TTL`. Providers stale past this drop
 *  from the selectable set, even if `active` is still true on-chain. */
const HEARTBEAT_TTL_SECONDS = 600

/**
 * Pull the active provider set, filter to those that offer the requested model
 * within budget, then rank per the selected strategy. See spec §8.
 */
export async function selectProvider(
  chain: ChainClient,
  strategy: SelectionStrategy,
  ctx: SelectionContext,
): Promise<CandidateProvider | null> {
  if (strategy === 'manual') {
    if (!ctx.manualProvider) throw new Error('manual strategy requires T4T_MANUAL_PROVIDER')
    return matchOffering(chain, ctx.manualProvider, ctx)
  }

  const candidates: CandidateProvider[] = []
  const now = Math.floor(Date.now() / 1000)
  let cursor = 0n
  for (let i = 0; i < 20; i++) {
    const {page, nextCursor} = await listProviders(chain, cursor, 50n)
    for (const provider of page) {
      if (!provider.active) continue
      if (!isHeartbeatFresh(provider.lastHeartbeat, now)) continue
      const offerings = await getOfferings(chain, provider.owner)
      const offering = offerings.find(
        o =>
          o.modelId === ctx.modelId &&
          (ctx.maxPrice === undefined || o.pricePerKToken <= ctx.maxPrice),
      )
      if (offering) candidates.push({provider, offering})
    }
    if (nextCursor === cursor || page.length === 0) break
    cursor = nextCursor
  }
  return rank(candidates, strategy)
}

export function isHeartbeatFresh(lastHeartbeat: number | bigint, nowSeconds: number): boolean {
  const last = typeof lastHeartbeat === 'bigint' ? Number(lastHeartbeat) : lastHeartbeat
  if (last === 0) return false
  return last + HEARTBEAT_TTL_SECONDS >= nowSeconds
}

async function matchOffering(
  chain: ChainClient,
  owner: Address,
  ctx: SelectionContext,
): Promise<CandidateProvider | null> {
  const offerings = await getOfferings(chain, owner)
  const offering = offerings.find(
    o => o.modelId === ctx.modelId && (ctx.maxPrice === undefined || o.pricePerKToken <= ctx.maxPrice),
  )
  if (!offering) return null
  const {page} = await listProviders(chain, 0n, 1n)
  // We don't strictly need the row for manual mode, so synthesize the parts
  // the caller cares about from the offerings call.
  const provider = (page.find(p => p.owner === owner) ?? {owner}) as ProviderRow
  return {provider, offering}
}

function rank(candidates: CandidateProvider[], strategy: SelectionStrategy): CandidateProvider | null {
  if (candidates.length === 0) return null

  if (strategy === 'cheapest') {
    return [...candidates].sort((a, b) => Number(a.offering.pricePerKToken - b.offering.pricePerKToken))[0]!
  }

  // top_rep_cheapest
  const newcomers = candidates.filter(c => c.provider.totalJobs < MIN_TOTAL_JOBS)
  const seasoned = candidates
    .filter(c => c.provider.totalJobs >= MIN_TOTAL_JOBS)
    .filter(c => successRate(c.provider) >= MIN_SUCCESS_RATE)

  if (seasoned.length > 0 && newcomers.length > 0 && Math.random() < EXPLORATION_SHARE) {
    return newcomers[Math.floor(Math.random() * newcomers.length)]!
  }
  const pool = seasoned.length > 0 ? seasoned : candidates
  return [...pool].sort((a, b) => Number(a.offering.pricePerKToken - b.offering.pricePerKToken))[0]!
}

function successRate(p: ProviderRow): number {
  return p.totalJobs === 0 ? 0 : p.successfulJobs / p.totalJobs
}
