import {secp256k1} from '@noble/curves/secp256k1'
import {hkdf} from '@noble/hashes/hkdf'
import {sha256} from '@noble/hashes/sha2'
import {bytesToHex, hexToBytes, randomBytes} from '@noble/hashes/utils'
import {chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {dirname} from 'node:path'
import type {Hex} from './types'

/**
 * The on-chain registry stores `pssPublicKey` as `bytes32` (spec §4 / contract).
 * A real secp256k1 compressed public key is 33 bytes (1-byte Y-parity prefix +
 * 32-byte X). We resolve the mismatch by only minting keys with even-Y parity
 * — the X coordinate alone is then enough; senders prepend 0x02 to rebuild
 * the compressed form. Rejection-sampling reaches even-Y in ~2 tries on
 * average without leaking entropy.
 */
const PSS_INFO = new TextEncoder().encode('t4t-pss-v1')

export interface PssKeypair {
  /** 32-byte secp256k1 private scalar. */
  privateKey: Hex
  /** 32-byte X coordinate of the compressed pub key (Y is even by construction). */
  publicKeyX: Hex
}

/**
 * Generate a fresh random PSS keypair with even-Y parity. Used at first
 * startup; the result is persisted via {@link loadOrCreatePssKey}.
 */
export function generatePssKeypair(): PssKeypair {
  for (let i = 0; i < 256; i++) {
    const candidate = randomBytes(32)
    if (!secp256k1.utils.isValidPrivateKey(candidate)) continue
    const pub = secp256k1.getPublicKey(candidate, true)
    if (pub[0] === 0x02) return pubFromPriv(candidate, pub)
  }
  throw new Error('failed to generate an even-Y PSS keypair')
}

/**
 * Deterministically derive a PSS keypair from the wallet's private key.
 *
 * Retained for tests and as a one-shot migration helper for operators who
 * registered with the wallet-derived key in the previous container version.
 * **Not used in production startup** — see `loadOrCreatePssKey`.
 */
export function derivePssKeypair(walletKey: Hex): PssKeypair {
  const ikm = hexToBytes(walletKey.replace(/^0x/, ''))
  for (let counter = 0; counter < 256; counter++) {
    const salt = new Uint8Array([counter])
    const candidate = hkdf(sha256, ikm, salt, PSS_INFO, 32)
    if (!secp256k1.utils.isValidPrivateKey(candidate)) continue
    const pub = secp256k1.getPublicKey(candidate, true)
    if (pub[0] === 0x02) return pubFromPriv(candidate, pub)
  }
  throw new Error('failed to derive an even-Y PSS keypair')
}

/** Public-key-only accessor for code paths that don't need the secret. */
export function pssPubKeyFromWallet(walletKey: Hex): Hex {
  return derivePssKeypair(walletKey).publicKeyX
}

/** Reconstruct the 33-byte compressed pubkey from the on-chain 32-byte X. */
export function pssPubKeyXToCompressed(pubKeyX: Hex): Uint8Array {
  const x = hexToBytes(pubKeyX.replace(/^0x/, ''))
  if (x.length !== 32) throw new Error(`expected 32-byte X coord, got ${x.length}`)
  const out = new Uint8Array(33)
  out[0] = 0x02 // even-Y by convention
  out.set(x, 1)
  return out
}

/**
 * Load the PSS keypair from `path`, or generate + persist one if absent.
 *
 * The on-disk format is a single line of 64 hex chars (the 32-byte private
 * scalar). The file is created mode 0600 and its parent directory is created
 * recursively if missing. The PSS pubkey is derived on load and validated to
 * have even-Y parity — files written by older versions that picked a key
 * with odd Y will be rejected so the operator can re-issue rather than
 * silently producing keys incompatible with the bytes32 registry slot.
 */
export function loadOrCreatePssKey(path: string): PssKeypair {
  if (existsSync(path)) return parsePssKeyFile(readFileSync(path, 'utf8'))
  const fresh = generatePssKeypair()
  mkdirSync(dirname(path), {recursive: true})
  const hex = fresh.privateKey.replace(/^0x/, '')
  writeFileSync(path, hex + '\n', {mode: 0o600})
  try { chmodSync(path, 0o600) } catch { /* best-effort on platforms without chmod */ }
  return fresh
}

function parsePssKeyFile(contents: string): PssKeypair {
  const hex = contents.trim().replace(/^0x/, '')
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('PSS key file must contain a 64-hex-char (32-byte) private scalar')
  }
  const priv = hexToBytes(hex)
  if (!secp256k1.utils.isValidPrivateKey(priv)) throw new Error('invalid secp256k1 private key')
  const pub = secp256k1.getPublicKey(priv, true)
  if (pub[0] !== 0x02) {
    throw new Error('PSS key has odd-Y public point; registry expects even-Y. Regenerate the key.')
  }
  return pubFromPriv(priv, pub)
}

function pubFromPriv(priv: Uint8Array, pub: Uint8Array): PssKeypair {
  return {
    privateKey: ('0x' + bytesToHex(priv)) as Hex,
    publicKeyX: ('0x' + bytesToHex(pub.subarray(1))) as Hex,
  }
}
