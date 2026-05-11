import Database, {type Database as Db} from 'better-sqlite3'
import {mkdirSync} from 'node:fs'
import {dirname} from 'node:path'

/**
 * Embedded SQLite store backing both admin UIs (US-2, US-3). One file per
 * container, two role-specific tables — opening the same path in both modes
 * is a misconfiguration but doesn't corrupt anything since the schemas don't
 * overlap.
 *
 * Design notes:
 * - bigint columns (`maxPayment`, `actualPayment`, `earnedXBZZ`) are stored
 *   as TEXT to avoid SQLite's 64-bit signed cap. Convert at the boundary.
 * - `prompt` / `response` are NULL unless T4T_PERSIST_PAYLOADS=true (client
 *   mode only). The provider side never persists decrypted bodies.
 */

export type JobStatus =
  | 'queued'
  | 'running'
  | 'delivered'
  | 'claimed'
  | 'failed'
  | 'posted'
  | 'acked'

export interface ProviderJobRow {
  jobId: string
  client: string
  modelId: string
  status: JobStatus
  receivedAt: number
  ackedAt: number | null
  completedAt: number | null
  claimedAt: number | null
  promptTokens: number | null
  completionTokens: number | null
  /** xBZZ wei as a base-10 string; NULL until claim. */
  earnedXBZZ: string | null
  errorMessage: string | null
}

export interface ClientJobRow {
  jobId: string
  provider: string
  modelId: string
  status: JobStatus
  maxPayment: string
  actualPayment: string | null
  postedAt: number
  ackedAt: number | null
  deliveredAt: number | null
  claimedAt: number | null
  prompt: string | null
  response: string | null
  promptTokens: number | null
  completionTokens: number | null
  errorMessage: string | null
}

const PROVIDER_SCHEMA = `
CREATE TABLE IF NOT EXISTS provider_jobs (
  jobId            TEXT PRIMARY KEY,
  client           TEXT NOT NULL,
  modelId          TEXT NOT NULL,
  status           TEXT NOT NULL,
  receivedAt       INTEGER NOT NULL,
  ackedAt          INTEGER,
  completedAt      INTEGER,
  claimedAt        INTEGER,
  promptTokens     INTEGER,
  completionTokens INTEGER,
  earnedXBZZ       TEXT,
  errorMessage     TEXT
);
CREATE INDEX IF NOT EXISTS provider_jobs_received ON provider_jobs(receivedAt);
CREATE INDEX IF NOT EXISTS provider_jobs_status ON provider_jobs(status);
`

const CLIENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS client_jobs (
  jobId            TEXT PRIMARY KEY,
  provider         TEXT NOT NULL,
  modelId          TEXT NOT NULL,
  status           TEXT NOT NULL,
  maxPayment       TEXT NOT NULL,
  actualPayment    TEXT,
  postedAt         INTEGER NOT NULL,
  ackedAt          INTEGER,
  deliveredAt      INTEGER,
  claimedAt        INTEGER,
  prompt           TEXT,
  response         TEXT,
  promptTokens     INTEGER,
  completionTokens INTEGER,
  errorMessage     TEXT
);
CREATE INDEX IF NOT EXISTS client_jobs_posted ON client_jobs(postedAt);
CREATE INDEX IF NOT EXISTS client_jobs_status ON client_jobs(status);
`

export interface JobsDbOpts {
  /** ":memory:" for tests, absolute path otherwise. */
  path: string
  /** Open both schemas — handy in tests so we don't need a second DB. */
  bothRoles?: boolean
}

export class JobsDb {
  readonly db: Db
  constructor(opts: JobsDbOpts) {
    if (opts.path !== ':memory:') mkdirSync(dirname(opts.path), {recursive: true})
    this.db = new Database(opts.path)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(PROVIDER_SCHEMA)
    this.db.exec(CLIENT_SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  // ---------- provider ----------

  recordProviderJob(row: ProviderJobRow): void {
    this.db
      .prepare(
        `INSERT INTO provider_jobs(jobId, client, modelId, status, receivedAt, ackedAt, completedAt, claimedAt, promptTokens, completionTokens, earnedXBZZ, errorMessage)
         VALUES (@jobId, @client, @modelId, @status, @receivedAt, @ackedAt, @completedAt, @claimedAt, @promptTokens, @completionTokens, @earnedXBZZ, @errorMessage)
         ON CONFLICT(jobId) DO UPDATE SET
           status           = excluded.status,
           ackedAt          = COALESCE(excluded.ackedAt, provider_jobs.ackedAt),
           completedAt      = COALESCE(excluded.completedAt, provider_jobs.completedAt),
           claimedAt        = COALESCE(excluded.claimedAt, provider_jobs.claimedAt),
           promptTokens     = COALESCE(excluded.promptTokens, provider_jobs.promptTokens),
           completionTokens = COALESCE(excluded.completionTokens, provider_jobs.completionTokens),
           earnedXBZZ       = COALESCE(excluded.earnedXBZZ, provider_jobs.earnedXBZZ),
           errorMessage     = COALESCE(excluded.errorMessage, provider_jobs.errorMessage)`,
      )
      .run(row)
  }

  listProviderJobs(opts: {sinceSeconds?: number; limit?: number} = {}): ProviderJobRow[] {
    const since = opts.sinceSeconds ?? Math.floor(Date.now() / 1000) - 7 * 86400
    const limit = opts.limit ?? 500
    return this.db
      .prepare(
        `SELECT * FROM provider_jobs WHERE receivedAt >= ? ORDER BY receivedAt DESC LIMIT ?`,
      )
      .all(since, limit) as ProviderJobRow[]
  }

  countProviderByStatus(): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) as n FROM provider_jobs GROUP BY status`)
      .all() as {status: string; n: number}[]
    return Object.fromEntries(rows.map(r => [r.status, r.n]))
  }

  // ---------- client ----------

  recordClientJob(row: ClientJobRow): void {
    this.db
      .prepare(
        `INSERT INTO client_jobs(jobId, provider, modelId, status, maxPayment, actualPayment, postedAt, ackedAt, deliveredAt, claimedAt, prompt, response, promptTokens, completionTokens, errorMessage)
         VALUES (@jobId, @provider, @modelId, @status, @maxPayment, @actualPayment, @postedAt, @ackedAt, @deliveredAt, @claimedAt, @prompt, @response, @promptTokens, @completionTokens, @errorMessage)
         ON CONFLICT(jobId) DO UPDATE SET
           status           = excluded.status,
           actualPayment    = COALESCE(excluded.actualPayment, client_jobs.actualPayment),
           ackedAt          = COALESCE(excluded.ackedAt, client_jobs.ackedAt),
           deliveredAt      = COALESCE(excluded.deliveredAt, client_jobs.deliveredAt),
           claimedAt        = COALESCE(excluded.claimedAt, client_jobs.claimedAt),
           prompt           = COALESCE(excluded.prompt, client_jobs.prompt),
           response         = COALESCE(excluded.response, client_jobs.response),
           promptTokens     = COALESCE(excluded.promptTokens, client_jobs.promptTokens),
           completionTokens = COALESCE(excluded.completionTokens, client_jobs.completionTokens),
           errorMessage     = COALESCE(excluded.errorMessage, client_jobs.errorMessage)`,
      )
      .run(row)
  }

  listClientJobs(opts: {sinceSeconds?: number; limit?: number} = {}): ClientJobRow[] {
    const since = opts.sinceSeconds ?? Math.floor(Date.now() / 1000) - 7 * 86400
    const limit = opts.limit ?? 500
    return this.db
      .prepare(`SELECT * FROM client_jobs WHERE postedAt >= ? ORDER BY postedAt DESC LIMIT ?`)
      .all(since, limit) as ClientJobRow[]
  }

  countClientByStatus(): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) as n FROM client_jobs GROUP BY status`)
      .all() as {status: string; n: number}[]
    return Object.fromEntries(rows.map(r => [r.status, r.n]))
  }

  /** Total xBZZ spent across claimed client jobs. Sums actualPayment as bigint. */
  totalSpentXBZZ(): bigint {
    const rows = this.db
      .prepare(`SELECT actualPayment FROM client_jobs WHERE actualPayment IS NOT NULL`)
      .all() as {actualPayment: string}[]
    return rows.reduce((acc, r) => acc + BigInt(r.actualPayment), 0n)
  }

  /** Total xBZZ earned across claimed provider jobs. */
  totalEarnedXBZZ(): bigint {
    const rows = this.db
      .prepare(`SELECT earnedXBZZ FROM provider_jobs WHERE earnedXBZZ IS NOT NULL`)
      .all() as {earnedXBZZ: string}[]
    return rows.reduce((acc, r) => acc + BigInt(r.earnedXBZZ), 0n)
  }

  /** Wipe stored prompts/responses older than `cutoffSeconds`. */
  redactClientPayloadsBefore(cutoffSeconds: number): number {
    const res = this.db
      .prepare(
        `UPDATE client_jobs SET prompt = '[expired]', response = '[expired]' WHERE postedAt < ? AND (prompt IS NOT NULL OR response IS NOT NULL)`,
      )
      .run(cutoffSeconds)
    return res.changes
  }
}
