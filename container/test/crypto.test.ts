import {describe, expect, it} from 'vitest'
import {EciesCipher, jsonDecrypt, jsonEncrypt} from '../src/lib/crypto'
import {derivePssKeypair} from '../src/lib/keys'

const ALICE_WALLET = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const
const BOB_WALLET = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba' as const

describe('derivePssKeypair', () => {
  it('is deterministic for a given wallet key', () => {
    const a = derivePssKeypair(ALICE_WALLET)
    const b = derivePssKeypair(ALICE_WALLET)
    expect(a.privateKey).toBe(b.privateKey)
    expect(a.publicKeyX).toBe(b.publicKeyX)
  })

  it('produces a 32-byte X coordinate', () => {
    const k = derivePssKeypair(ALICE_WALLET)
    expect(k.publicKeyX.length).toBe(2 + 64) // '0x' + 64 hex chars = 32 bytes
  })

  it('produces different keys for different wallets', () => {
    const a = derivePssKeypair(ALICE_WALLET)
    const b = derivePssKeypair(BOB_WALLET)
    expect(a.privateKey).not.toBe(b.privateKey)
    expect(a.publicKeyX).not.toBe(b.publicKeyX)
  })
})

describe('EciesCipher', () => {
  const aliceKeys = derivePssKeypair(ALICE_WALLET)
  const bobKeys = derivePssKeypair(BOB_WALLET)

  it('round-trips an arbitrary payload from sender to recipient', async () => {
    const aliceCipher = new EciesCipher(aliceKeys.privateKey)
    const bobCipher = new EciesCipher(bobKeys.privateKey)
    const plaintext = new TextEncoder().encode('the quick brown fox jumps over the lazy dog')
    const ct = await aliceCipher.encrypt(plaintext, bobKeys.publicKeyX)
    const pt = await bobCipher.decrypt(ct)
    expect(new TextDecoder().decode(pt)).toBe('the quick brown fox jumps over the lazy dog')
  })

  it('produces different ciphertexts for the same plaintext (fresh ephemeral key)', async () => {
    const cipher = new EciesCipher(aliceKeys.privateKey)
    const pt = new TextEncoder().encode('hello')
    const a = await cipher.encrypt(pt, bobKeys.publicKeyX)
    const b = await cipher.encrypt(pt, bobKeys.publicKeyX)
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'))
  })

  it('fails to decrypt with the wrong private key', async () => {
    const aliceCipher = new EciesCipher(aliceKeys.privateKey)
    const ct = await aliceCipher.encrypt(new TextEncoder().encode('secret'), bobKeys.publicKeyX)
    // Decrypt with Alice's key — she's the sender, not the recipient, so GCM auth fails.
    await expect(aliceCipher.decrypt(ct)).rejects.toThrow()
  })

  it('detects tampering with the ciphertext', async () => {
    const aliceCipher = new EciesCipher(aliceKeys.privateKey)
    const bobCipher = new EciesCipher(bobKeys.privateKey)
    const ct = await aliceCipher.encrypt(new TextEncoder().encode('integrity'), bobKeys.publicKeyX)
    // Flip a byte in the ciphertext body (past the 33-byte ephPub + 12-byte iv prefix).
    ct[60] ^= 0x01
    await expect(bobCipher.decrypt(ct)).rejects.toThrow()
  })

  it('rejects truncated envelopes', async () => {
    const bobCipher = new EciesCipher(bobKeys.privateKey)
    await expect(bobCipher.decrypt(new Uint8Array(10))).rejects.toThrow(/too short/)
  })

  it('round-trips JSON via jsonEncrypt/jsonDecrypt', async () => {
    const aliceCipher = new EciesCipher(aliceKeys.privateKey)
    const bobCipher = new EciesCipher(bobKeys.privateKey)
    const payload = {hello: 'world', n: 42, nested: {ok: true}}
    const ct = await jsonEncrypt(aliceCipher, bobKeys.publicKeyX, payload)
    const out = await jsonDecrypt<typeof payload>(bobCipher, ct)
    expect(out).toEqual(payload)
  })
})
