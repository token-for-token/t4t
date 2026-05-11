import {afterEach, describe, expect, it} from 'vitest'
import {mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {secp256k1} from '@noble/curves/secp256k1'
import {bytesToHex} from '@noble/hashes/utils'
import {generatePssKeypair, loadOrCreatePssKey} from '../src/lib/keys'

const dirs: string[] = []
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 't4t-keys-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!
    rmSync(d, {recursive: true, force: true})
  }
})

describe('generatePssKeypair', () => {
  it('produces a 32-byte even-Y key', () => {
    const k = generatePssKeypair()
    expect(k.privateKey.length).toBe(2 + 64)
    expect(k.publicKeyX.length).toBe(2 + 64)
  })

  it('returns distinct keys on each call', () => {
    const a = generatePssKeypair()
    const b = generatePssKeypair()
    expect(a.privateKey).not.toBe(b.privateKey)
  })
})

describe('loadOrCreatePssKey', () => {
  it('creates the file on first call and reloads the same key on the second', () => {
    const path = join(freshDir(), 'pss.key')
    const first = loadOrCreatePssKey(path)
    const second = loadOrCreatePssKey(path)
    expect(second.privateKey).toBe(first.privateKey)
    expect(second.publicKeyX).toBe(first.publicKeyX)
  })

  it('creates the parent directory if missing', () => {
    const path = join(freshDir(), 'nested', 'sub', 'pss.key')
    const k = loadOrCreatePssKey(path)
    expect(k.privateKey).toMatch(/^0x[0-9a-f]{64}$/)
    expect(readFileSync(path, 'utf8').trim()).toBe(k.privateKey.replace(/^0x/, ''))
  })

  it('writes the key file with mode 0600', () => {
    const path = join(freshDir(), 'pss.key')
    loadOrCreatePssKey(path)
    // Mask off file-type bits; we only care about permission bits.
    const perms = statSync(path).mode & 0o777
    expect(perms).toBe(0o600)
  })

  it('rejects files containing garbage', () => {
    const path = join(freshDir(), 'pss.key')
    writeFileSync(path, 'not hex\n')
    expect(() => loadOrCreatePssKey(path)).toThrow(/64-hex-char/)
  })

  it('rejects keys whose public point has odd Y', () => {
    // Find the smallest positive scalar with odd-Y pubkey by enumeration.
    let oddScalar: Uint8Array | null = null
    for (let i = 1; i < 32; i++) {
      const s = new Uint8Array(32)
      s[31] = i
      if (secp256k1.getPublicKey(s, true)[0] === 0x03) {
        oddScalar = s
        break
      }
    }
    if (!oddScalar) throw new Error('no odd-Y scalar found in [1, 32)')
    const path = join(freshDir(), 'pss.key')
    writeFileSync(path, bytesToHex(oddScalar) + '\n')
    expect(() => loadOrCreatePssKey(path)).toThrow(/odd-Y/)
  })

  it('accepts a 0x-prefixed hex on disk', () => {
    const path = join(freshDir(), 'pss.key')
    const first = loadOrCreatePssKey(path)
    // Rewrite with explicit 0x prefix to confirm the parser strips it.
    writeFileSync(path, first.privateKey + '\n')
    const second = loadOrCreatePssKey(path)
    expect(second.privateKey).toBe(first.privateKey)
  })
})
