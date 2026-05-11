import type {Envelope, JobNotifyBody} from '../../lib/types'

/**
 * Bounded queue gating concurrent jobs. Drops new notifies once the active
 * count hits the configured ceiling — the client will see no ACK and either
 * retry against another provider or cancel for slash. That's the correct
 * behavior per spec §3 (no ACK within ACK_WINDOW → cancel).
 */
export class JobQueue {
  private active = 0
  constructor(private readonly limit: number) {}

  tryAcquire(): boolean {
    if (this.active >= this.limit) return false
    this.active += 1
    return true
  }

  release(): void {
    if (this.active > 0) this.active -= 1
  }

  get inFlight(): number {
    return this.active
  }
}

export function isJobNotify(env: Envelope): env is Envelope<JobNotifyBody> {
  return env.type === 'job_notify'
}
