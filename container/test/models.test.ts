import {describe, expect, it} from 'vitest'
import {ModelDiscovery} from '../src/modes/gateway/models'
import type {ChainClient} from '../src/lib/chain'
import type {ModelOffering, ProviderRow} from '../src/lib/types'

function mkProvider(over: Partial<ProviderRow> = {}): ProviderRow {
  const now = Math.floor(Date.now() / 1000)
  return {
    owner: '0x0000000000000000000000000000000000000001',
    pssPublicKey: '0x0',
    swarmOverlay: '0x0',
    metadataURI: '',
    stake: 0n,
    lastHeartbeat: now,
    totalJobs: 0,
    successfulJobs: 0,
    active: true,
    maxConcurrentJobs: 0,
    ...over,
  }
}

function mkChain(
  providers: ProviderRow[],
  offerings: Map<string, ModelOffering[]>,
): ChainClient {
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
    registry: '0x0' as never,
    escrow: '0x0' as never,
    xbzz: '0x0' as never,
    address: '0x0' as never,
    wallet: {} as never,
  } as unknown as ChainClient
}

const ALICE = '0x0000000000000000000000000000000000000001' as const
const BOB = '0x0000000000000000000000000000000000000002' as const

describe('ModelDiscovery', () => {
  it('summarises models across active, fresh providers', async () => {
    const providers = [
      mkProvider({owner: ALICE}),
      mkProvider({owner: BOB}),
    ]
    const offerings = new Map<string, ModelOffering[]>([
      [
        ALICE.toLowerCase(),
        [{modelId: 'llama3:8b', inputPricePerMillionTokens: 50n, outputPricePerMillionTokens: 100n, maxContextTokens: 0n, maxLatencySeconds: 60}],
      ],
      [
        BOB.toLowerCase(),
        [{modelId: 'llama3:8b', inputPricePerMillionTokens: 80n, outputPricePerMillionTokens: 200n, maxContextTokens: 0n, maxLatencySeconds: 120}],
      ],
    ])
    const d = new ModelDiscovery({
      chain: mkChain(providers, offerings),
      minProvidersPerModel: 1,
      cacheTtlSeconds: 60,
    })
    const summaries = await d.list()
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      id: 'llama3:8b',
      providerCount: 2,
      minInputPrice: 50n,
      minOutputPrice: 100n,
      slowestSlaSeconds: 120,
    })
  })

  it('drops models below T4T_MIN_PROVIDERS_PER_MODEL', async () => {
    const providers = [mkProvider({owner: ALICE})]
    const offerings = new Map<string, ModelOffering[]>([
      [ALICE.toLowerCase(), [{modelId: 'rare', inputPricePerMillionTokens: 1n, outputPricePerMillionTokens: 1n, maxContextTokens: 0n, maxLatencySeconds: 1}]],
    ])
    const d = new ModelDiscovery({
      chain: mkChain(providers, offerings),
      minProvidersPerModel: 2,
      cacheTtlSeconds: 60,
    })
    expect(await d.list()).toEqual([])
  })

  it('filters by T4T_ALLOWED_MODELS', async () => {
    const providers = [mkProvider({owner: ALICE})]
    const offerings = new Map<string, ModelOffering[]>([
      [
        ALICE.toLowerCase(),
        [
          {modelId: 'allowed', inputPricePerMillionTokens: 1n, outputPricePerMillionTokens: 1n, maxContextTokens: 0n, maxLatencySeconds: 1},
          {modelId: 'blocked', inputPricePerMillionTokens: 1n, outputPricePerMillionTokens: 2n, maxContextTokens: 0n, maxLatencySeconds: 2},
        ],
      ],
    ])
    const d = new ModelDiscovery({
      chain: mkChain(providers, offerings),
      allowedModels: ['allowed'],
      minProvidersPerModel: 1,
      cacheTtlSeconds: 60,
    })
    const summaries = await d.list()
    expect(summaries.map(s => s.id)).toEqual(['allowed'])
  })

  it('skips inactive and stale providers', async () => {
    const stale = Math.floor(Date.now() / 1000) - 10_000
    const providers = [
      mkProvider({owner: ALICE, active: false}),
      mkProvider({owner: BOB, lastHeartbeat: stale}),
    ]
    const offerings = new Map<string, ModelOffering[]>([
      [ALICE.toLowerCase(), [{modelId: 'm', inputPricePerMillionTokens: 1n, outputPricePerMillionTokens: 1n, maxContextTokens: 0n, maxLatencySeconds: 1}]],
      [BOB.toLowerCase(), [{modelId: 'm', inputPricePerMillionTokens: 1n, outputPricePerMillionTokens: 1n, maxContextTokens: 0n, maxLatencySeconds: 1}]],
    ])
    const d = new ModelDiscovery({
      chain: mkChain(providers, offerings),
      minProvidersPerModel: 1,
      cacheTtlSeconds: 60,
    })
    expect(await d.list()).toEqual([])
  })

  it('serves repeat calls from cache until TTL expires', async () => {
    let scanCount = 0
    const providers = [mkProvider({owner: ALICE})]
    const offerings = new Map<string, ModelOffering[]>([
      [ALICE.toLowerCase(), [{modelId: 'm', inputPricePerMillionTokens: 1n, outputPricePerMillionTokens: 1n, maxContextTokens: 0n, maxLatencySeconds: 1}]],
    ])
    const baseChain = mkChain(providers, offerings)
    const chain = {
      ...baseChain,
      pub: {
        readContract: async (call: {functionName: string; args: unknown[]}) => {
          if (call.functionName === 'listProviders' && (call.args[0] as bigint) === 0n) {
            scanCount += 1
          }
          return baseChain.pub.readContract(call as never)
        },
      },
    } as unknown as ChainClient

    let nowMs = 1_000_000
    const d = new ModelDiscovery({
      chain,
      minProvidersPerModel: 1,
      cacheTtlSeconds: 60,
      now: () => nowMs,
    })
    await d.list()
    await d.list()
    expect(scanCount).toBe(1)
    nowMs += 61_000
    await d.list()
    expect(scanCount).toBe(2)
  })
})
