import {describe, expect, it} from 'vitest'
import {isHeartbeatFresh, selectProvider} from '../src/modes/gateway/selector'
import type {ChainClient} from '../src/lib/chain'
import type {ModelOffering, ProviderRow} from '../src/lib/types'

describe('isHeartbeatFresh', () => {
  const NOW = 1_700_000_000
  const TTL = 600

  it('treats a zero heartbeat as never alive', () => {
    expect(isHeartbeatFresh(0, NOW)).toBe(false)
  })

  it('accepts a recent heartbeat', () => {
    expect(isHeartbeatFresh(NOW - 5, NOW)).toBe(true)
  })

  it('accepts the boundary heartbeat exactly at TTL', () => {
    expect(isHeartbeatFresh(NOW - TTL, NOW)).toBe(true)
  })

  it('rejects a heartbeat older than TTL', () => {
    expect(isHeartbeatFresh(NOW - TTL - 1, NOW)).toBe(false)
  })

  it('accepts bigint heartbeats (registry returns uint64)', () => {
    expect(isHeartbeatFresh(BigInt(NOW - 10), NOW)).toBe(true)
  })
})

const ALICE = '0x0000000000000000000000000000000000000001' as const
const BOB = '0x0000000000000000000000000000000000000002' as const
const CAROL = '0x0000000000000000000000000000000000000003' as const

function mkProvider(over: Partial<ProviderRow> = {}): ProviderRow {
  return {
    owner: ALICE,
    pssPublicKey: '0x0',
    swarmOverlay: '0x0',
    metadataURI: '',
    stake: 0n,
    lastHeartbeat: Math.floor(Date.now() / 1000),
    totalJobs: 0,
    successfulJobs: 0,
    active: true,
    ...over,
  }
}

function mkChain(providers: ProviderRow[], offerings: Map<string, ModelOffering[]>): ChainClient {
  return {
    pub: {
      readContract: async ({functionName, args}: {functionName: string; args: unknown[]}) => {
        if (functionName === 'listProviders') {
          const cursor = Number(args[0] as bigint)
          const limit = Number(args[1] as bigint)
          if (cursor >= providers.length) return [[], BigInt(providers.length)]
          const end = Math.min(cursor + limit, providers.length)
          return [providers.slice(cursor, end), BigInt(end)]
        }
        if (functionName === 'getOfferings') {
          const owner = (args[0] as string).toLowerCase()
          return offerings.get(owner) ?? []
        }
        throw new Error(`unexpected ${functionName}`)
      },
    },
  } as unknown as ChainClient
}

describe('selectProvider context-window filter', () => {
  it("skips providers whose maxContextTokens is below the request's minimum", async () => {
    const providers = [mkProvider({owner: ALICE}), mkProvider({owner: BOB})]
    const offerings = new Map<string, ModelOffering[]>([
      [
        ALICE.toLowerCase(),
        [{modelId: 'm', inputPricePerMillionTokens: 1n, outputPricePerMillionTokens: 1n, maxContextTokens: 4000n, maxLatencySeconds: 60n}],
      ],
      [
        BOB.toLowerCase(),
        [{modelId: 'm', inputPricePerMillionTokens: 5n, outputPricePerMillionTokens: 5n, maxContextTokens: 200000n, maxLatencySeconds: 60n}],
      ],
    ])
    const sel = await selectProvider(mkChain(providers, offerings), 'cheapest', {
      modelId: 'm',
      minContextTokens: 8000n,
    })
    expect(sel?.provider.owner).toBe(BOB)
  })

  it('treats maxContextTokens=0 as "unspecified" and accepts the provider', async () => {
    const providers = [mkProvider({owner: ALICE})]
    const offerings = new Map<string, ModelOffering[]>([
      [
        ALICE.toLowerCase(),
        [{modelId: 'm', inputPricePerMillionTokens: 1n, outputPricePerMillionTokens: 1n, maxContextTokens: 0n, maxLatencySeconds: 60n}],
      ],
    ])
    const sel = await selectProvider(mkChain(providers, offerings), 'cheapest', {
      modelId: 'm',
      minContextTokens: 1_000_000n,
    })
    expect(sel?.provider.owner).toBe(ALICE)
  })

  it('returns null when every candidate has a too-small declared window', async () => {
    const providers = [mkProvider({owner: ALICE}), mkProvider({owner: CAROL})]
    const offerings = new Map<string, ModelOffering[]>([
      [
        ALICE.toLowerCase(),
        [{modelId: 'm', inputPricePerMillionTokens: 1n, outputPricePerMillionTokens: 1n, maxContextTokens: 2000n, maxLatencySeconds: 60n}],
      ],
      [
        CAROL.toLowerCase(),
        [{modelId: 'm', inputPricePerMillionTokens: 1n, outputPricePerMillionTokens: 1n, maxContextTokens: 4000n, maxLatencySeconds: 60n}],
      ],
    ])
    const sel = await selectProvider(mkChain(providers, offerings), 'cheapest', {
      modelId: 'm',
      minContextTokens: 8000n,
    })
    expect(sel).toBeNull()
  })

  it('still enforces maxPrice alongside the context-window filter', async () => {
    const providers = [mkProvider({owner: ALICE}), mkProvider({owner: BOB})]
    const offerings = new Map<string, ModelOffering[]>([
      [
        ALICE.toLowerCase(),
        [{modelId: 'm', inputPricePerMillionTokens: 50n, outputPricePerMillionTokens: 50n, maxContextTokens: 100_000n, maxLatencySeconds: 60n}],
      ],
      [
        BOB.toLowerCase(),
        [{modelId: 'm', inputPricePerMillionTokens: 5n, outputPricePerMillionTokens: 5n, maxContextTokens: 100_000n, maxLatencySeconds: 60n}],
      ],
    ])
    const sel = await selectProvider(mkChain(providers, offerings), 'cheapest', {
      modelId: 'm',
      maxPrice: 20n,
      minContextTokens: 8000n,
    })
    expect(sel?.provider.owner).toBe(BOB)
  })
})

describe('selectProvider manual strategy', () => {
  it('honours the context-window filter in manual mode too', async () => {
    const providers = [mkProvider({owner: ALICE})]
    const offerings = new Map<string, ModelOffering[]>([
      [
        ALICE.toLowerCase(),
        [{modelId: 'm', inputPricePerMillionTokens: 1n, outputPricePerMillionTokens: 1n, maxContextTokens: 2000n, maxLatencySeconds: 60n}],
      ],
    ])
    const sel = await selectProvider(mkChain(providers, offerings), 'manual', {
      modelId: 'm',
      manualProvider: ALICE,
      minContextTokens: 8000n,
    })
    expect(sel).toBeNull()
  })
})
