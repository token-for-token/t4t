import {isAddressEqual, recoverMessageAddress, toHex} from 'viem'
import {
  type Envelope,
  type EnvelopeType,
  type Hex,
  PROTOCOL_VERSION,
  type SignMessage,
  type UnsignedEnvelope,
} from './types'

/** PSS topics, spec §5.1. */
export function providerTopic(wallet: Hex): string {
  return `t4t:provider:${wallet.toLowerCase()}`
}
export function clientTopic(wallet: Hex): string {
  return `t4t:client:${wallet.toLowerCase()}`
}

export function randomNonce(): Hex {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return toHex(bytes)
}

/**
 * Deterministic JSON encoding so signatures are stable across implementations.
 * Sorts keys at every level and emits no whitespace.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number')
    return JSON.stringify(value)
  }
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']'
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}'
  }
  throw new Error(`unserializable: ${typeof value}`)
}

export interface BuildEnvelopeArgs<TBody> {
  from: Hex
  to: Hex
  type: EnvelopeType
  body: TBody
  ts?: number
  nonce?: Hex
}

export async function signEnvelope<TBody>(
  args: BuildEnvelopeArgs<TBody>,
  signMessage: SignMessage,
): Promise<Envelope<TBody>> {
  const unsigned: UnsignedEnvelope<TBody> = {
    v: PROTOCOL_VERSION,
    type: args.type,
    from: args.from,
    to: args.to,
    ts: args.ts ?? Math.floor(Date.now() / 1000),
    nonce: args.nonce ?? randomNonce(),
    body: args.body,
  }
  const sig = await signMessage(canonicalize(unsigned))
  return {...unsigned, sig}
}

/** True iff the signature recovers to `env.from` and the version matches. */
export async function verifyEnvelope(env: Envelope): Promise<boolean> {
  if (env.v !== PROTOCOL_VERSION) return false
  const {sig, ...unsigned} = env
  try {
    const recovered = await recoverMessageAddress({
      message: canonicalize(unsigned),
      signature: sig,
    })
    return isAddressEqual(recovered, env.from)
  } catch {
    return false
  }
}

export function encodeEnvelope(env: Envelope): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(env))
}

export function decodeEnvelope<TBody = unknown>(bytes: Uint8Array | string): Envelope<TBody> {
  const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes)
  return JSON.parse(text) as Envelope<TBody>
}

/**
 * LRU-ish dedup cache for incoming envelopes. Per spec §9, hold the last 10k
 * nonces and drop on repeat.
 */
export class DedupCache {
  private readonly seen = new Set<string>()
  constructor(private readonly capacity = 10_000) {}

  has(key: string): boolean {
    return this.seen.has(key)
  }

  mark(key: string): void {
    if (this.seen.size >= this.capacity) {
      const oldest = this.seen.values().next().value
      if (oldest) this.seen.delete(oldest)
    }
    this.seen.add(key)
  }
}

/** Stable per-envelope dedup key: `from:nonce`. */
export function envelopeKey(env: Pick<Envelope, 'from' | 'nonce'>): string {
  return `${env.from.toLowerCase()}:${env.nonce.toLowerCase()}`
}
