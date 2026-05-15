import {describe, expect, it} from 'vitest'
import {isHeartbeatFresh} from '../src/modes/gateway/selector'

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
