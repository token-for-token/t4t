import {keccak256, type Address} from 'viem'
import {jobEscrowAbi} from './abi'
import type {ChainClient} from './chain'
import {readJob} from './chain'
import type {Logger} from './logger'
import type {Hex} from './types'

/**
 * Maps the routing id (`keccak256(requestHash)`) to the on-chain jobId emitted
 * by `JobEscrow.JobPosted`. The provider needs this map to call `claimJob` —
 * the PSS notify carries the requestHash, but the contract addresses jobs by
 * `keccak256(chainid, escrow, client, counter)`.
 *
 * Implementation: watch `JobPosted(provider=self)`, then read `jobs[jobId]` to
 * extract the requestHash and store the reverse lookup. Bounded LRU so a
 * long-running provider doesn't leak memory.
 */
export class JobPostedIndex {
  private readonly byRouting = new Map<Hex, Hex>()
  private readonly order: Hex[] = []
  private unwatch?: () => void

  constructor(
    private readonly chain: ChainClient,
    private readonly provider: Address,
    private readonly log: Logger,
    private readonly capacity = 4096,
  ) {}

  start(): void {
    this.unwatch = this.chain.pub.watchContractEvent({
      address: this.chain.escrow,
      abi: jobEscrowAbi,
      eventName: 'JobPosted',
      args: {provider: this.provider},
      onLogs: logs => {
        for (const ev of logs) {
          const jobId = ev.args.jobId as Hex | undefined
          if (!jobId) continue
          this.ingest(jobId).catch(err =>
            this.log.warn({err, jobId}, 'failed to ingest JobPosted'),
          )
        }
      },
      onError: err => this.log.warn({err}, 'JobPosted watcher errored'),
    })
  }

  stop(): void {
    this.unwatch?.()
    this.unwatch = undefined
  }

  /** Resolve a routing id (from the PSS notify) to its on-chain jobId. */
  get(routingId: Hex): Hex | undefined {
    return this.byRouting.get(routingId.toLowerCase() as Hex)
  }

  /** Manual seed — used when the worker computes routing ahead of the event. */
  async ingest(jobId: Hex): Promise<Hex | null> {
    const job = await readJob(this.chain, jobId)
    if (!job.requestHash) return null
    const routing = keccak256(job.requestHash)
    this.set(routing, jobId)
    return routing
  }

  private set(routing: Hex, jobId: Hex): void {
    const key = routing.toLowerCase() as Hex
    if (this.byRouting.has(key)) return
    this.byRouting.set(key, jobId)
    this.order.push(key)
    while (this.order.length > this.capacity) {
      const oldest = this.order.shift()
      if (oldest) this.byRouting.delete(oldest)
    }
  }

  get size(): number {
    return this.byRouting.size
  }
}
