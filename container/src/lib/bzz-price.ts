/**
 * BZZ → USD price lookup via CoinGecko's free tier. Cached 5 min so the
 * admin UI can show a USD-equivalent alongside PLUR/BZZ without hammering
 * the API. Failures fall back to the last good value (or null if we've
 * never had one) — the calling page just hides the USD column.
 */
import type {Logger} from './logger'

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=swarm-bzz&vs_currencies=usd'
const CACHE_TTL_MS = 5 * 60 * 1000

interface Cached {
  usd: number
  fetchedAt: number
}

let cached: Cached | null = null
let inflight: Promise<number | null> | null = null

export async function getBzzUsd(logger?: Logger): Promise<number | null> {
  const now = Date.now()
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.usd
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const r = await fetch(COINGECKO_URL, {headers: {accept: 'application/json'}})
      if (!r.ok) {
        logger?.warn({status: r.status}, 'CoinGecko BZZ price fetch returned non-2xx')
        return cached?.usd ?? null
      }
      const data = (await r.json()) as Record<string, {usd?: number}>
      const usd = data['swarm-bzz']?.usd
      if (typeof usd !== 'number' || !isFinite(usd) || usd <= 0) {
        logger?.warn({data}, 'CoinGecko BZZ price missing or invalid')
        return cached?.usd ?? null
      }
      cached = {usd, fetchedAt: now}
      return usd
    } catch (err) {
      logger?.warn({err}, 'CoinGecko BZZ price fetch failed')
      return cached?.usd ?? null
    } finally {
      inflight = null
    }
  })()
  return inflight
}
