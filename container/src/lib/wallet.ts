import {existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync} from 'node:fs'
import {dirname} from 'node:path'
import {validateMnemonic, mnemonicToSeedSync} from '@scure/bip39'
import {wordlist} from '@scure/bip39/wordlists/english'
import {HDKey} from '@scure/bip32'
import {generateMnemonic, english} from 'viem/accounts'
import {toHex} from 'viem'
import type {Hex} from './types'

/** Standard Ethereum derivation path — first account, first address. */
const ETH_PATH = "m/44'/60'/0'/0/0"

export function newMnemonic(): string {
  return generateMnemonic(english)
}

export function isMnemonic(input: string): boolean {
  const words = input.trim().split(/\s+/)
  if (![12, 15, 18, 21, 24].includes(words.length)) return false
  return validateMnemonic(words.join(' '), wordlist)
}

export function mnemonicToPrivateKey(mnemonic: string): Hex {
  if (!isMnemonic(mnemonic)) throw new Error('invalid BIP39 mnemonic')
  const seed = mnemonicToSeedSync(mnemonic.trim().replace(/\s+/g, ' '))
  const derived = HDKey.fromMasterSeed(seed).derive(ETH_PATH)
  if (!derived.privateKey) throw new Error('mnemonic derived no private key')
  return toHex(derived.privateKey) as Hex
}

/** Accepts a BIP39 mnemonic OR a 0x-prefixed 32-byte private key. */
export function parseWalletInput(input: string): Hex {
  const trimmed = input.trim()
  if (/^0x[a-fA-F0-9]{64}$/.test(trimmed)) return trimmed as Hex
  return mnemonicToPrivateKey(trimmed)
}

export function walletFileExists(path: string): boolean {
  return existsSync(path)
}

export function loadWalletKey(path: string): Hex {
  const raw = readFileSync(path, 'utf8').trim()
  if (!/^0x[a-fA-F0-9]{64}$/.test(raw)) throw new Error(`wallet file at ${path} is not a valid private key`)
  return raw as Hex
}

export function saveWalletKey(path: string, key: Hex): void {
  if (!/^0x[a-fA-F0-9]{64}$/.test(key)) throw new Error('refusing to save: not a 0x-prefixed 32-byte private key')
  mkdirSync(dirname(path), {recursive: true})
  writeFileSync(path, key + '\n', {mode: 0o600})
  // writeFileSync's mode is only respected on file creation; tighten existing files too.
  chmodSync(path, 0o600)
}
