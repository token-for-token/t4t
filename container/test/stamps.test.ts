import {describe, expect, it, vi} from 'vitest'
import {
  amountForTtl,
  BLOCKS_PER_DAY_GNOSIS,
  ensureManagedStamp,
  pickReusable,
  pickToppable,
  stampWalletCostWei,
  summariseBatch,
  topUpIfBelow,
} from '../src/lib/stamps'

const silentLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  debug: () => {},
  trace: () => {},
} as unknown as import('../src/lib/logger').Logger

function batch(opts: Partial<{
  id: string
  label: string
  usable: boolean
  depth: number
  remainingDays: number
  utilization: number
  usage: number
  usageText: string
}> = {}) {
  return {
    batchID: {toString: () => opts.id ?? 'a'.repeat(64)},
    label: opts.label ?? 't4t',
    usable: opts.usable ?? true,
    depth: opts.depth ?? 22,
    amount: '0',
    utilization: opts.utilization ?? 0,
    usage: opts.usage ?? 0,
    usageText: opts.usageText ?? '0%',
    duration: {
      toDays: () => opts.remainingDays ?? 30,
      toSeconds: () => (opts.remainingDays ?? 30) * 86400,
    },
  }
}

describe('amountForTtl', () => {
  it('multiplies currentPrice × blocks/day × ttl', async () => {
    const bee = {getChainState: async () => ({currentPrice: 24000, block: 0, chainTip: 0, totalAmount: '0'})}
    const amount = await amountForTtl(bee as never, 30)
    expect(amount).toBe(24000n * BLOCKS_PER_DAY_GNOSIS * 30n)
  })

  it('rejects zero or negative currentPrice', async () => {
    const bee = {getChainState: async () => ({currentPrice: 0, block: 0, chainTip: 0, totalAmount: '0'})}
    await expect(amountForTtl(bee as never, 30)).rejects.toThrow(/currentPrice/)
  })

  it('clamps non-integer or non-positive ttl to 1 day', async () => {
    const bee = {getChainState: async () => ({currentPrice: 100, block: 0, chainTip: 0, totalAmount: '0'})}
    expect(await amountForTtl(bee as never, 0)).toBe(100n * BLOCKS_PER_DAY_GNOSIS * 1n)
    expect(await amountForTtl(bee as never, -3)).toBe(100n * BLOCKS_PER_DAY_GNOSIS * 1n)
  })
})

describe('stampWalletCostWei', () => {
  it('multiplies amount by 2^depth', () => {
    expect(stampWalletCostWei(100n, 17)).toBe(100n * (1n << 17n))
    expect(stampWalletCostWei(1n, 22)).toBe(1n << 22n)
  })
})

describe('pickReusable', () => {
  it('returns null when no batch matches the label', () => {
    const batches = [batch({label: 'other'}), batch({label: 'foo'})]
    expect(pickReusable(batches, 't4t', 7)).toBeNull()
  })

  it('skips batches below the min-TTL threshold', () => {
    const batches = [batch({remainingDays: 3, id: 'b'.repeat(64)})]
    expect(pickReusable(batches, 't4t', 7)).toBeNull()
  })

  it('skips unusable batches', () => {
    const batches = [batch({usable: false, remainingDays: 60})]
    expect(pickReusable(batches, 't4t', 7)).toBeNull()
  })

  it('picks the longest-TTL batch when multiple match', () => {
    const batches = [
      batch({id: 'a'.repeat(64), remainingDays: 10}),
      batch({id: 'b'.repeat(64), remainingDays: 60}),
      batch({id: 'c'.repeat(64), remainingDays: 30}),
    ]
    expect(pickReusable(batches, 't4t', 7)?.batchID.toString()).toBe('b'.repeat(64))
  })
})

describe('pickToppable', () => {
  it('returns the longest-TTL usable batch regardless of min-TTL', () => {
    const batches = [
      batch({id: 'a'.repeat(64), remainingDays: 1}),
      batch({id: 'b'.repeat(64), remainingDays: 3}),
    ]
    expect(pickToppable(batches, 't4t')?.batchID.toString()).toBe('b'.repeat(64))
  })

  it('still skips unusable batches', () => {
    const batches = [batch({usable: false, remainingDays: 60})]
    expect(pickToppable(batches, 't4t')).toBeNull()
  })
})

describe('ensureManagedStamp', () => {
  const opts = {depth: 22, ttlDays: 30, minTtlDays: 7, label: 't4t', dryRun: false}

  it('reuses a healthy batch without buying', async () => {
    const id = 'a'.repeat(64)
    const bee = {
      getAllPostageBatch: vi.fn(async () => [batch({id, remainingDays: 60})]),
      createPostageBatch: vi.fn(),
      topUpBatch: vi.fn(),
      getChainState: vi.fn(),
    }
    const res = await ensureManagedStamp({bee: bee as never, logger: silentLogger, opts})
    expect(res.source).toBe('reused')
    expect(res.batchID).toBe(id)
    expect(bee.createPostageBatch).not.toHaveBeenCalled()
    expect(bee.topUpBatch).not.toHaveBeenCalled()
  })

  it('tops up an existing too-short batch instead of buying fresh', async () => {
    const id = 'a'.repeat(64)
    const bee = {
      getAllPostageBatch: vi.fn(async () => [batch({id, remainingDays: 2})]),
      getChainState: vi.fn(async () => ({currentPrice: 100, block: 0, chainTip: 0, totalAmount: '0'})),
      topUpBatch: vi.fn(async () => id),
      createPostageBatch: vi.fn(),
    }
    const res = await ensureManagedStamp({bee: bee as never, logger: silentLogger, opts})
    expect(res.source).toBe('reused')
    expect(res.batchID).toBe(id)
    expect(bee.topUpBatch).toHaveBeenCalledOnce()
    expect(bee.createPostageBatch).not.toHaveBeenCalled()
  })

  it('buys a new batch when none exist', async () => {
    const id = 'a'.repeat(64)
    let calls = 0
    const bee = {
      getAllPostageBatch: vi.fn(async () => {
        calls++
        return calls === 1 ? [] : [batch({id, remainingDays: 30})]
      }),
      getChainState: vi.fn(async () => ({currentPrice: 100, block: 0, chainTip: 0, totalAmount: '0'})),
      createPostageBatch: vi.fn(async () => ({toString: () => id})),
      topUpBatch: vi.fn(),
    }
    const res = await ensureManagedStamp({bee: bee as never, logger: silentLogger, opts})
    expect(res.source).toBe('bought')
    expect(bee.createPostageBatch).toHaveBeenCalledOnce()
    const [amount, depth, options] = bee.createPostageBatch.mock.calls[0]!
    expect(amount).toBe(100n * BLOCKS_PER_DAY_GNOSIS * 30n)
    expect(depth).toBe(22)
    expect((options as {label?: string}).label).toBe('t4t')
  })

  it('dry-run refuses to buy and throws', async () => {
    const bee = {
      getAllPostageBatch: vi.fn(async () => []),
      getChainState: vi.fn(async () => ({currentPrice: 100, block: 0, chainTip: 0, totalAmount: '0'})),
      createPostageBatch: vi.fn(),
      topUpBatch: vi.fn(),
    }
    await expect(
      ensureManagedStamp({bee: bee as never, logger: silentLogger, opts: {...opts, dryRun: true}}),
    ).rejects.toThrow(/dry-run|refusing/i)
    expect(bee.createPostageBatch).not.toHaveBeenCalled()
  })
})

describe('topUpIfBelow', () => {
  it('no-ops when remaining TTL is healthy', async () => {
    const id = 'a'.repeat(64)
    const bee = {
      getAllPostageBatch: vi.fn(async () => [batch({id, remainingDays: 30})]),
      topUpBatch: vi.fn(),
      getChainState: vi.fn(),
    }
    const res = await topUpIfBelow({
      bee: bee as never, logger: silentLogger, batchId: id, ttlDays: 30, minTtlDays: 7, dryRun: false,
    })
    expect(res.toppedUp).toBe(false)
    expect(bee.topUpBatch).not.toHaveBeenCalled()
  })

  it('tops up when remaining TTL falls below threshold', async () => {
    const id = 'a'.repeat(64)
    const bee = {
      getAllPostageBatch: vi.fn(async () => [batch({id, remainingDays: 3})]),
      getChainState: vi.fn(async () => ({currentPrice: 100, block: 0, chainTip: 0, totalAmount: '0'})),
      topUpBatch: vi.fn(async () => id),
    }
    const res = await topUpIfBelow({
      bee: bee as never, logger: silentLogger, batchId: id, ttlDays: 30, minTtlDays: 7, dryRun: false,
    })
    expect(res.toppedUp).toBe(true)
    expect(bee.topUpBatch).toHaveBeenCalledOnce()
    const [batchArg, amountArg] = bee.topUpBatch.mock.calls[0]!
    expect(batchArg).toBe(id)
    expect(amountArg).toBe(100n * BLOCKS_PER_DAY_GNOSIS * 30n)
  })

  it('dry-run skips the top-up call', async () => {
    const id = 'a'.repeat(64)
    const bee = {
      getAllPostageBatch: vi.fn(async () => [batch({id, remainingDays: 3})]),
      topUpBatch: vi.fn(),
      getChainState: vi.fn(),
    }
    const res = await topUpIfBelow({
      bee: bee as never, logger: silentLogger, batchId: id, ttlDays: 30, minTtlDays: 7, dryRun: true,
    })
    expect(res.toppedUp).toBe(false)
    expect(bee.topUpBatch).not.toHaveBeenCalled()
  })

  it('handles missing batch gracefully', async () => {
    const bee = {
      getAllPostageBatch: vi.fn(async () => []),
      topUpBatch: vi.fn(),
      getChainState: vi.fn(),
    }
    const res = await topUpIfBelow({
      bee: bee as never, logger: silentLogger, batchId: 'a'.repeat(64), ttlDays: 30, minTtlDays: 7, dryRun: false,
    })
    expect(res.toppedUp).toBe(false)
    expect(bee.topUpBatch).not.toHaveBeenCalled()
  })
})

describe('summariseBatch', () => {
  it('flattens duration and tags source', () => {
    const summary = summariseBatch(batch({remainingDays: 12, depth: 20}), 'reused')
    expect(summary.source).toBe('reused')
    expect(summary.remainingDays).toBe(12)
    expect(summary.depth).toBe(20)
  })
})
