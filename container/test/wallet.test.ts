import {describe, expect, it, afterEach} from 'vitest'
import {mkdtempSync, rmSync, readFileSync, statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {privateKeyToAccount} from 'viem/accounts'
import {
  isMnemonic,
  loadWalletKey,
  mnemonicToPrivateKey,
  newMnemonic,
  parseWalletInput,
  saveWalletKey,
  walletFileExists,
} from '../src/lib/wallet'

const tmpDirs: string[] = []
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 't4t-wallet-'))
  tmpDirs.push(d)
  return d
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, {recursive: true, force: true})
})

describe('wallet', () => {
  it('newMnemonic produces a valid BIP39 phrase', () => {
    const m = newMnemonic()
    expect(m.split(/\s+/)).toHaveLength(12)
    expect(isMnemonic(m)).toBe(true)
  })

  it('rejects non-mnemonic strings', () => {
    expect(isMnemonic('not a real mnemonic')).toBe(false)
    expect(isMnemonic('')).toBe(false)
    expect(isMnemonic('one two three four five six seven eight nine ten eleven not-a-word')).toBe(false)
  })

  it('mnemonicToPrivateKey derives a stable, valid key', () => {
    // Standard BIP39 test vector.
    const mnemonic = 'test test test test test test test test test test test junk'
    const key = mnemonicToPrivateKey(mnemonic)
    expect(key).toMatch(/^0x[a-f0-9]{64}$/)
    // m/44'/60'/0'/0/0 derivation of this mnemonic yields the well-known
    // Hardhat/Anvil default account #0.
    expect(privateKeyToAccount(key).address.toLowerCase()).toBe(
      '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
    )
  })

  it('parseWalletInput accepts both mnemonic and 0x hex', () => {
    const mnemonic = 'test test test test test test test test test test test junk'
    const fromMnem = parseWalletInput(mnemonic)
    const hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const
    expect(parseWalletInput(hex)).toBe(hex)
    expect(parseWalletInput('  ' + mnemonic + '  ')).toBe(fromMnem)
    expect(() => parseWalletInput('garbage')).toThrow(/mnemonic/)
  })

  it('save/load round-trip with 0600 perms', () => {
    const dir = mkTmp()
    const path = join(dir, 'wallet.key')
    expect(walletFileExists(path)).toBe(false)
    const key = '0x' + 'ab'.repeat(32)
    saveWalletKey(path, key as `0x${string}`)
    expect(walletFileExists(path)).toBe(true)
    expect(loadWalletKey(path)).toBe(key)
    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)
    // File ends with a trailing newline so editors don't complain.
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true)
  })

  it('save refuses non-private-key inputs', () => {
    const dir = mkTmp()
    expect(() => saveWalletKey(join(dir, 'w.key'), 'not-hex' as `0x${string}`)).toThrow()
    expect(() => saveWalletKey(join(dir, 'w.key'), '0xshort' as `0x${string}`)).toThrow()
  })
})
