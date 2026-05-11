import {describe, expect, it} from 'vitest'
import {privateKeyToAccount} from 'viem/accounts'
import {
  DedupCache,
  canonicalize,
  clientTopic,
  envelopeKey,
  providerTopic,
  signEnvelope,
  verifyEnvelope,
} from '../src/lib/envelope'

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const
const account = privateKeyToAccount(KEY)
const signMessage = (m: string) => account.signMessage({message: m})

describe('canonicalize', () => {
  it('sorts keys at every level', () => {
    const a = canonicalize({b: 2, a: {y: 1, x: 2}})
    const b = canonicalize({a: {x: 2, y: 1}, b: 2})
    expect(a).toBe(b)
    expect(a).toBe('{"a":{"x":2,"y":1},"b":2}')
  })

  it('rejects non-finite numbers', () => {
    expect(() => canonicalize({n: NaN})).toThrow()
  })
})

describe('envelope sign/verify', () => {
  it('round-trips for a job_notify envelope', async () => {
    const env = await signEnvelope(
      {
        from: account.address,
        to: '0x0000000000000000000000000000000000000001',
        type: 'job_notify',
        body: {jobId: '0xabc', requestHash: 'deadbeef', modelId: 'm', maxPayment: '1', deliveryDeadline: 10},
      },
      signMessage,
    )
    expect(await verifyEnvelope(env)).toBe(true)
  })

  it('fails verification when the body is mutated', async () => {
    const env = await signEnvelope(
      {
        from: account.address,
        to: '0x0000000000000000000000000000000000000001',
        type: 'job_ack',
        body: {jobId: '0xabc', estimatedCompletion: 10},
      },
      signMessage,
    )
    const tampered = {...env, body: {...(env.body as object), estimatedCompletion: 999}}
    expect(await verifyEnvelope(tampered as typeof env)).toBe(false)
  })
})

describe('topics', () => {
  it('lowercases the wallet', () => {
    expect(providerTopic('0xABCDEF0000000000000000000000000000000001'))
      .toBe('t4t:provider:0xabcdef0000000000000000000000000000000001')
    expect(clientTopic('0xABCDEF0000000000000000000000000000000001'))
      .toBe('t4t:client:0xabcdef0000000000000000000000000000000001')
  })
})

describe('DedupCache', () => {
  it('marks-and-detects', () => {
    const c = new DedupCache(3)
    c.mark('a')
    expect(c.has('a')).toBe(true)
    expect(c.has('b')).toBe(false)
  })

  it('evicts oldest at capacity', () => {
    const c = new DedupCache(2)
    c.mark('a')
    c.mark('b')
    c.mark('c')
    expect(c.has('a')).toBe(false)
    expect(c.has('b')).toBe(true)
    expect(c.has('c')).toBe(true)
  })

  it('envelopeKey is stable across casing', () => {
    expect(envelopeKey({from: '0xABCD', nonce: '0xDEAD'}))
      .toBe(envelopeKey({from: '0xabcd', nonce: '0xdead'}))
  })
})
