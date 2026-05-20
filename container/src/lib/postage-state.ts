/**
 * Persists the resolved postage batchId to `${T4T_DATA_DIR}/postage-batch.json`
 * so the container sticks to the same batch across restarts. Without this, a
 * Bee node with multiple usable batches lets the resolver drift to a different
 * batch each time — surprising for an operator who only set `T4T_STAMP_LABEL`.
 *
 * Read path: if the persisted label matches the configured label and the
 * batch is still usable on Bee, the resolver short-circuits. A label change is
 * treated as an explicit re-resolve signal.
 */

import {existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

const FILE_NAME = 'postage-batch.json'

export interface PersistedBatch {
  batchId: string
  label: string
  source: string
  persistedAt: string
}

export function persistedBatchPath(dataDir: string): string {
  return join(dataDir, FILE_NAME)
}

export function readPersistedBatch(dataDir: string): PersistedBatch | null {
  const p = persistedBatchPath(dataDir)
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<PersistedBatch>
    if (typeof raw.batchId !== 'string' || !/^[0-9a-fA-F]{64}$/.test(raw.batchId)) return null
    if (typeof raw.label !== 'string') return null
    return {
      batchId: raw.batchId,
      label: raw.label,
      source: typeof raw.source === 'string' ? raw.source : 'unknown',
      persistedAt: typeof raw.persistedAt === 'string' ? raw.persistedAt : '',
    }
  } catch {
    return null
  }
}

export function writePersistedBatch(
  dataDir: string,
  value: Omit<PersistedBatch, 'persistedAt'>,
): void {
  const p = persistedBatchPath(dataDir)
  const body = JSON.stringify({...value, persistedAt: new Date().toISOString()}, null, 2)
  // Atomic write: temp file + rename, so a crash mid-write can't truncate
  // the file and leave the next boot unable to parse it.
  const tmp = `${p}.tmp`
  writeFileSync(tmp, body)
  renameSync(tmp, p)
}
