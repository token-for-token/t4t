import {Bee, Topic, type PssSubscription} from '@ethersphere/bee-js'
import type {Envelope, Hex} from './types'
import {decodeEnvelope, encodeEnvelope, envelopeKey, DedupCache, verifyEnvelope} from './envelope'
import type {Logger} from './logger'

export interface SwarmClientOpts {
  bee: Bee
  postageBatchId: string
  logger: Logger
}

/** Upload a single chunk and return its Swarm reference (hex). */
export async function uploadChunk(
  opts: SwarmClientOpts,
  bytes: Uint8Array,
): Promise<string> {
  const {reference} = await opts.bee.uploadData(opts.postageBatchId, bytes)
  return reference.toString()
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
    const pubKey = args.recipientPssKey.startsWith('0x')
      ? args.recipientPssKey.slice(2)
      : args.recipientPssKey
    await this.opts.bee.pssSend(
      this.opts.postageBatchId,
      topic,
      target,
      encodeEnvelope(args.envelope),
      pubKey,
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
