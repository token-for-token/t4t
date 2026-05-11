/**
 * ECIES payload encryption for Swarm chunks (spec §6).
 *
 * Hybrid scheme: secp256k1 ECDH → HKDF-SHA256 → AES-256-GCM.
 *
 *   ciphertext = ephPubCompressed(33) || iv(12) || aesGcm(plaintext)
 *
 * The recipient's on-chain `pssPublicKey` is a 32-byte X coordinate (Y-even
 * by convention; see lib/keys.ts), so we prepend 0x02 to reconstruct the
 * compressed point. The ephemeral pub key is emitted compressed (33 bytes)
 * since both Y parities can occur for ephemerals.
 */
import {gcm} from '@noble/ciphers/aes'
import {secp256k1} from '@noble/curves/secp256k1'
import {hkdf} from '@noble/hashes/hkdf'
import {sha256} from '@noble/hashes/sha2'
import {hexToBytes, randomBytes} from '@noble/hashes/utils'
import {pssPubKeyXToCompressed} from './keys'
import type {Hex} from './types'

const EPH_PUB_LEN = 33
const IV_LEN = 12
const AES_KEY_LEN = 32
const HKDF_INFO = new TextEncoder().encode('t4t-ecies-v1')

export interface PayloadCipher {
  encrypt(plaintext: Uint8Array, recipientPubKeyX: Hex): Promise<Uint8Array>
  decrypt(ciphertext: Uint8Array): Promise<Uint8Array>
}

export class EciesCipher implements PayloadCipher {
  private readonly selfPriv: Uint8Array

  constructor(selfPssPrivateKey: Hex) {
    const priv = hexToBytes(selfPssPrivateKey.replace(/^0x/, ''))
    if (priv.length !== 32) throw new Error(`PSS private key must be 32 bytes, got ${priv.length}`)
    if (!secp256k1.utils.isValidPrivateKey(priv)) throw new Error('invalid secp256k1 private key')
    this.selfPriv = priv
  }

  async encrypt(plaintext: Uint8Array, recipientPubKeyX: Hex): Promise<Uint8Array> {
    const recipientPub = pssPubKeyXToCompressed(recipientPubKeyX)
    const ephPriv = secp256k1.utils.randomPrivateKey()
    const ephPub = secp256k1.getPublicKey(ephPriv, true) // 33 bytes
    const shared = secp256k1.getSharedSecret(ephPriv, recipientPub, true) // [parity || X]
    const key = hkdf(sha256, shared.subarray(1), undefined, HKDF_INFO, AES_KEY_LEN)
    const iv = randomBytes(IV_LEN)
    const ct = gcm(key, iv).encrypt(plaintext)
    const out = new Uint8Array(EPH_PUB_LEN + IV_LEN + ct.length)
    out.set(ephPub, 0)
    out.set(iv, EPH_PUB_LEN)
    out.set(ct, EPH_PUB_LEN + IV_LEN)
    return out
  }

  async decrypt(ciphertext: Uint8Array): Promise<Uint8Array> {
    if (ciphertext.length < EPH_PUB_LEN + IV_LEN + 16) {
      throw new Error('ciphertext too short for ECIES envelope')
    }
    const ephPub = ciphertext.subarray(0, EPH_PUB_LEN)
    const iv = ciphertext.subarray(EPH_PUB_LEN, EPH_PUB_LEN + IV_LEN)
    const ct = ciphertext.subarray(EPH_PUB_LEN + IV_LEN)
    const shared = secp256k1.getSharedSecret(this.selfPriv, ephPub, true)
    const key = hkdf(sha256, shared.subarray(1), undefined, HKDF_INFO, AES_KEY_LEN)
    return gcm(key, iv).decrypt(ct)
  }
}

/**
 * No-op cipher kept around for tests where you don't want to deal with key
 * material. Production code paths construct EciesCipher.
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

export async function jsonDecrypt<T>(cipher: PayloadCipher, ct: Uint8Array): Promise<T> {
  const pt = await cipher.decrypt(ct)
  return JSON.parse(new TextDecoder().decode(pt)) as T
}
