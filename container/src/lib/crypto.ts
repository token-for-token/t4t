/**
 * Payload encryption for Swarm chunks. v1 wraps a stub around the
 * recipient's PSS public key — production should use ECIES (secp256k1 +
 * AES-256-GCM, HKDF-derived key) per spec §6.
 *
 * The PSS public key in the registry is a 33-byte compressed secp256k1
 * point. Implementations that want a quick start can use `@noble/secp256k1`
 * + Web Crypto for AES-GCM; we leave the concrete cipher pluggable.
 */
import type {Hex} from './types'

export interface PayloadCipher {
  encrypt(plaintext: Uint8Array, recipientPubKey: Hex): Promise<Uint8Array>
  decrypt(ciphertext: Uint8Array, selfPrivKey: Hex): Promise<Uint8Array>
}

/**
 * No-op cipher used until ECIES is wired. Passes bytes through unchanged so
 * the rest of the stack can be exercised end-to-end on Anvil + a single Bee.
 * Replace before any non-local deployment.
 */
export class PassthroughCipher implements PayloadCipher {
  async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    return plaintext
  }
  async decrypt(ciphertext: Uint8Array): Promise<Uint8Array> {
    return ciphertext
  }
}

export function jsonEncrypt(cipher: PayloadCipher, recipient: Hex, value: unknown): Promise<Uint8Array> {
  return cipher.encrypt(new TextEncoder().encode(JSON.stringify(value)), recipient)
}

export async function jsonDecrypt<T>(cipher: PayloadCipher, self: Hex, ct: Uint8Array): Promise<T> {
  const pt = await cipher.decrypt(ct, self)
  return JSON.parse(new TextDecoder().decode(pt)) as T
}
