import {Bee, Topic, type PssSubscription} from '@ethersphere/bee-js'
import type {Envelope, Hex} from './types'
import {decodeEnvelope, encodeEnvelope, envelopeKey, DedupCache, verifyEnvelope} from './envelope'
import type {Logger} from './logger'

export interface SwarmClientOpts {
  bee: Bee
  postageBatchId: string
  logger: Logger
}

/** Returns true if the Bee error means "the postage batch ran out of bucket
 *  capacity" (HTTP 402 with `code:402, message:"batch is overissued"`). */
function isBatchOverissued(err: unknown): boolean {
  const e = err as {status?: number; responseBody?: {message?: string; code?: number}} | null
  if (!e || e.status !== 402) return false
  const msg = e.responseBody?.message ?? ''
  return /overissued|insufficient/i.test(msg) || e.responseBody?.code === 402
}

/** Emergency self-heal: when a Bee call fails because the batch is full,
 *  dilute it by +1 depth (doubles bucket capacity, halves remaining TTL) and
 *  retry the call exactly once. Logged so the operator sees the recovery.
 *  Bee handles the dilute tx from its own wallet — we don't pay xBZZ here. */
const EMERGENCY_DILUTE_MAX_DEPTH = 28
async function withBatchRecovery<T>(opts: SwarmClientOpts, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (!isBatchOverissued(err)) throw err
    const batches = await opts.bee.getAllPostageBatch().catch(() => [])
    const batch = batches.find(b => b.batchID.toString() === opts.postageBatchId)
    if (!batch) throw err
    if (batch.depth >= EMERGENCY_DILUTE_MAX_DEPTH) {
      opts.logger.error({batchId: opts.postageBatchId, depth: batch.depth}, 'batch overissued and at depth cap — cannot self-heal')
      throw err
    }
    const newDepth = batch.depth + 1
    opts.logger.warn(
      {batchId: opts.postageBatchId, from: batch.depth, to: newDepth},
      'batch overissued — emergency dilute then retry',
    )
    await opts.bee.diluteBatch(opts.postageBatchId, newDepth)
    // Bee's diluteBatch returns when the tx is SUBMITTED, not mined. The local
    // node won't accept writes at the new depth until the tx confirms on
    // Gnosis (~5-15s). Poll until the batch's depth actually reflects the
    // dilute, with a 30s ceiling. Without this, the retry races the chain and
    // hits the same 402.
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const refreshed = await opts.bee.getAllPostageBatch().catch(() => [])
      const b = refreshed.find(x => x.batchID.toString() === opts.postageBatchId)
      if (b && b.depth >= newDepth) {
        opts.logger.info({batchId: opts.postageBatchId, depth: b.depth}, 'dilute confirmed')
        break
      }
      await new Promise(r => setTimeout(r, 1500))
    }
    return await fn()
  }
}

/** Upload a single chunk and return its Swarm reference (hex). */
export async function uploadChunk(
  opts: SwarmClientOpts,
  bytes: Uint8Array,
): Promise<string> {
  return withBatchRecovery(opts, async () => {
    const {reference} = await opts.bee.uploadData(opts.postageBatchId, bytes)
    return reference.toString()
  })
}

export async function downloadChunk(opts: SwarmClientOpts, reference: string): Promise<Uint8Array> {
  const data = await opts.bee.downloadData(reference)
  return data.toUint8Array()
}

/** Pick the most usable postage batch the Bee node already owns. We prefer
 *  batches that Bee marks as `usable: true` (i.e. enough block confirmations
 *  and not expired), with the largest remaining capacity as a tiebreaker.
 *  Returns null when the node has no usable batch — the caller should surface
 *  this so the operator can buy or top-up one. */
export async function discoverUsableBatchId(bee: Bee): Promise<string | null> {
  const all = await bee.getAllPostageBatch().catch(() => [])
  const usable = all.filter(b => b.usable)
  if (usable.length === 0) return null
  // Pick the longest-lived as a proxy for "still valid for the next while".
  usable.sort((a, b) => b.duration.toSeconds() - a.duration.toSeconds())
  return usable[0]!.batchID.toString()
}

export interface PssTransportOpts extends SwarmClientOpts {
  selfAddress: Hex
  dedupCapacity?: number
}

export interface PssSendArgs {
  topic: string
  /** Target's Swarm overlay address (hex, 0x-prefixed). */
  recipientOverlay: Hex
  /** Recipient's PSS public key (hex, 0x-prefixed compressed pubkey). */
  recipientPssKey: Hex
  envelope: Envelope
}

export interface PssSubscribeArgs {
  topic: string
  onEnvelope: (env: Envelope) => void | Promise<void>
  onError?: (err: unknown) => void
}

/**
 * Thin wrapper over bee-js PSS that signs nothing and verifies everything.
 * Envelope signing happens upstream in `envelope.ts`; this layer only routes.
 */
export class PssTransport {
  private readonly dedup: DedupCache

  constructor(private readonly opts: PssTransportOpts) {
    this.dedup = new DedupCache(opts.dedupCapacity ?? 10_000)
  }

  async send(args: PssSendArgs): Promise<void> {
    const topic = Topic.fromString(args.topic)
    // First 2 bytes of the overlay narrow PSS forwarding without doxxing
    // the full target address (Bee convention).
    const target = args.recipientOverlay.slice(2, 6)
    // The on-chain registry stores `pssPublicKey` as bytes32 (X coord only)
    // and our keygen guarantees even-Y parity (see lib/keys.ts), so prepend
    // 0x02 to rebuild the 33-byte compressed pubkey form bee-js' PublicKey
    // class accepts. Passing bare 32 bytes throws
    //   "Bytes#checkByteLength: bytes length is 32 but expected 64".
    const x = args.recipientPssKey.replace(/^0x/, '')
    if (x.length !== 64) {
      throw new Error(`recipient PSS pubkey must be 32-byte X coord (got ${x.length / 2} bytes)`)
    }
    const pubKey = '02' + x
    await withBatchRecovery(this.opts, () =>
      this.opts.bee.pssSend(
        this.opts.postageBatchId,
        topic,
        target,
        encodeEnvelope(args.envelope),
        pubKey,
      ),
    )
  }

  subscribe(args: PssSubscribeArgs): PssSubscription {
    const topic = Topic.fromString(args.topic)
    return this.opts.bee.pssSubscribe(topic, {
      onMessage: async msg => {
        try {
          const env = decodeEnvelope(msg.toUtf8())
          const key = envelopeKey(env)
          if (this.dedup.has(key)) return
          if (!(await verifyEnvelope(env))) {
            this.opts.logger.warn({from: env.from}, 'envelope signature verification failed')
            return
          }
          this.dedup.mark(key)
          await args.onEnvelope(env)
        } catch (err) {
          args.onError?.(err)
          this.opts.logger.error({err}, 'pss decode failure')
        }
      },
      onError: err => {
        args.onError?.(err)
        this.opts.logger.error({err}, 'pss subscription error')
      },
      onClose: () => {
        this.opts.logger.warn({topic: args.topic}, 'pss subscription closed')
      },
    })
  }
}
