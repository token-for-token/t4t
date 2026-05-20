import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {persistedBatchPath, readPersistedBatch, writePersistedBatch} from '../src/lib/postage-state'

describe('postage-state', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 't4t-postage-'))
  })
  afterEach(() => {
    rmSync(dir, {recursive: true, force: true})
  })

  it('returns null when no file exists', () => {
    expect(readPersistedBatch(dir)).toBeNull()
  })

  it('round-trips a valid record', () => {
    writePersistedBatch(dir, {
      batchId: 'a'.repeat(64),
      label: 't4t',
      source: 'bought',
    })
    const got = readPersistedBatch(dir)
    expect(got?.batchId).toBe('a'.repeat(64))
    expect(got?.label).toBe('t4t')
    expect(got?.source).toBe('bought')
    expect(got?.persistedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('rejects records with malformed batchId', () => {
    writeFileSync(persistedBatchPath(dir), JSON.stringify({batchId: 'not-hex', label: 't4t'}))
    expect(readPersistedBatch(dir)).toBeNull()
  })

  it('rejects records with missing label', () => {
    writeFileSync(persistedBatchPath(dir), JSON.stringify({batchId: 'b'.repeat(64)}))
    expect(readPersistedBatch(dir)).toBeNull()
  })

  it('returns null on malformed JSON without throwing', () => {
    writeFileSync(persistedBatchPath(dir), '{not json')
    expect(readPersistedBatch(dir)).toBeNull()
  })

  it('overwrites an existing record atomically', () => {
    writePersistedBatch(dir, {batchId: 'a'.repeat(64), label: 'old', source: 'discover'})
    writePersistedBatch(dir, {batchId: 'b'.repeat(64), label: 'new', source: 'bought'})
    const got = readPersistedBatch(dir)
    expect(got?.batchId).toBe('b'.repeat(64))
    expect(got?.label).toBe('new')
  })
})
