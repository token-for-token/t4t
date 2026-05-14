import {describe, expect, it} from 'vitest'
import {escape, formatDuration, formatTs, formatXBZZ, shortHex} from '../src/lib/admin-html'

describe('admin-html helpers', () => {
  it('escapes HTML metacharacters', () => {
    expect(escape(`<script>alert("x")</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    )
  })

  it('formats xBZZ wei to human-friendly decimal (16 decimals on Gnosis)', () => {
    expect(formatXBZZ(1n * 10n ** 16n)).toBe('1')
    expect(formatXBZZ(15_000_000_000_000_000n)).toBe('1.5')
    expect(formatXBZZ(0n)).toBe('0')
    expect(formatXBZZ(null)).toBe('—')
  })

  it('shortens long hex', () => {
    expect(shortHex('0x1234567890abcdef1234567890abcdef')).toBe('0x1234…cdef')
    expect(shortHex('0xabc')).toBe('0xabc')
  })

  it('formats durations relative to acked → completed', () => {
    expect(formatDuration(100, 145)).toBe('45s')
    expect(formatDuration(100, 220)).toBe('2m0s')
    expect(formatDuration(null, 220)).toBe('—')
  })

  it('formats unix timestamps', () => {
    expect(formatTs(0)).toBe('—')
    expect(formatTs(1_700_000_000)).toMatch(/^2023-11-14/)
  })
})
