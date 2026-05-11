import {secp256k1} from '@noble/curves/secp256k1'
import {hkdf} from '@noble/hashes/hkdf'
import {sha256} from '@noble/hashes/sha2'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils'
import type {Hex} from './types'

/**
 * The on-chain registry stores `pssPublicKey` as `bytes32` (spec §4 / contract).
 * A real secp256k1 compressed public key is 33 bytes (1-byte Y-parity prefix +
 * 32-byte X). We resolve the mismatch by deriving keys with even-Y parity only
 * — the X coordinate alone is then enough; senders prepend 0x02 to rebuild the
 * compressed form. Rejection-sampling the derived seed lets us reach an
 * even-Y key in ~2 tries on average without leaking entropy.
 */
const PSS_INFO = new TextEncoder().encode('t4t-pss-v1')

export interface PssKeypair {
  /** 32-byte secp256k1 private scalar (deterministic w.r.t. the wallet key). */
  privateKey: Hex
  /** 32-byte X coordinate of the compressed pub key (Y is even by construction). */
  publicKeyX: Hex
}

/**
 * Deterministically derive a PSS keypair from the wallet's private key.
 *
 * The wallet key is the HKDF input; we expand into 32 bytes per attempt and
 * try counters 0..255 until the resulting public key has even Y. The same
 * wallet always yields the same PSS key so existing on-chain registrations
 * keep working across restarts.
 *
 * NB: this binds the PSS key to the wallet for now. The "Separate PSS keypair
 * from wallet" task in docs/architecture.md is what removes this coupling.
 */
export function derivePssKeypair(walletKey: Hex): PssKeypair {
  const ikm = hexToBytes(walletKey.replace(/^0x/, ''))
  for (let counter = 0; counter < 256; counter++) {
    const salt = new Uint8Array([counter])
    const candidate = hkdf(sha256, ikm, salt, PSS_INFO, 32)
    if (!secp256k1.utils.isValidPrivateKey(candidate)) continue
    const pub = secp256k1.getPublicKey(candidate, true)
    // pub[0] === 0x02 means even Y. We require even Y so the on-chain X alone
    // is sufficient to reconstruct the full point.
    if (pub[0] === 0x02) {
      return {
        privateKey: ('0x' + bytesToHex(candidate)) as Hex,
        publicKeyX: ('0x' + bytesToHex(pub.subarray(1))) as Hex,
      }
    }
  }
  // 256 consecutive odd-Y outcomes has probability 2^-256.
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

