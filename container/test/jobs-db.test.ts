import {describe, expect, it} from 'vitest'
import {JobsDb} from '../src/lib/jobs-db'

function mkDb() {
  return new JobsDb({path: ':memory:'})
}

describe('JobsDb provider lifecycle', () => {
  it('records and upserts a job through queued → running → claimed', () => {
    const db = mkDb()
    db.recordProviderJob({
      jobId: '0x1',
      client: '0xaaa',
      modelId: 'm',
      status: 'queued',
      receivedAt: 100,
      ackedAt: null,
      completedAt: null,
      claimedAt: null,
      promptTokens: null,
      completionTokens: null,
      earnedXBZZ: null,
      errorMessage: null,
    })
    db.recordProviderJob({
      jobId: '0x1',
      client: '0xaaa',
      modelId: 'm',
      status: 'running',
      receivedAt: 0,
      ackedAt: 110,
      completedAt: null,
      claimedAt: null,
      promptTokens: 10,
      completionTokens: null,
      earnedXBZZ: null,
      errorMessage: null,
    })
    db.recordProviderJob({
      jobId: '0x1',
      client: '0xaaa',
      modelId: 'm',
      status: 'claimed',
      receivedAt: 0,
      ackedAt: null,
      completedAt: 200,
      claimedAt: 210,
      promptTokens: null,
      completionTokens: 50,
      earnedXBZZ: '5000000000000000000',
      errorMessage: null,
    })
    const rows = db.listProviderJobs({sinceSeconds: 0})
    expect(rows).toHaveLength(1)
    const r = rows[0]!
    expect(r.status).toBe('claimed')
    expect(r.receivedAt).toBe(100)
    expect(r.ackedAt).toBe(110)
    expect(r.completedAt).toBe(200)
    expect(r.claimedAt).toBe(210)
    expect(r.promptTokens).toBe(10)
    expect(r.completionTokens).toBe(50)
    expect(r.earnedXBZZ).toBe('5000000000000000000')
  })

  it('sums earned xBZZ across jobs as bigint', () => {
    const db = mkDb()
    for (let i = 0; i < 3; i++) {
      db.recordProviderJob({
        jobId: `0x${i}`,
        client: '0xa',
        modelId: 'm',
        status: 'claimed',
        receivedAt: 1,
        ackedAt: null,
        completedAt: null,
        claimedAt: null,
        promptTokens: null,
        completionTokens: null,
        earnedXBZZ: '1000000000000000000',
        errorMessage: null,
      })
    }
    expect(db.totalEarnedXBZZ()).toBe(3n * 10n ** 18n)
  })

  it('groups by status', () => {
    const db = mkDb()
    db.recordProviderJob({
      jobId: '0x1', client: 'c', modelId: 'm', status: 'queued', receivedAt: 1,
      ackedAt: null, completedAt: null, claimedAt: null, promptTokens: null,
      completionTokens: null, earnedXBZZ: null, errorMessage: null,
    })
    db.recordProviderJob({
      jobId: '0x2', client: 'c', modelId: 'm', status: 'failed', receivedAt: 1,
      ackedAt: null, completedAt: null, claimedAt: null, promptTokens: null,
      completionTokens: null, earnedXBZZ: null, errorMessage: 'boom',
    })
    expect(db.countProviderByStatus()).toEqual({queued: 1, failed: 1})
  })
})

describe('JobsDb client lifecycle', () => {
  it('persists prompts only when explicitly stored', () => {
    const db = mkDb()
    db.recordClientJob({
      jobId: '0xa',
      provider: '0xprov',
      modelId: 'm',
      status: 'posted',
      maxPayment: '1000',
      actualPayment: null,
      postedAt: 100,
      ackedAt: null,
      deliveredAt: null,
      claimedAt: null,
      prompt: '[redacted]',
      response: null,
      promptTokens: null,
      completionTokens: null,
      errorMessage: null,
    })
    const r = db.listClientJobs({sinceSeconds: 0})[0]!
    expect(r.prompt).toBe('[redacted]')
    expect(r.response).toBeNull()
  })

  it('redactClientPayloadsBefore replaces prompts past cutoff', () => {
    const db = mkDb()
    db.recordClientJob({
      jobId: '0xa', provider: 'p', modelId: 'm', status: 'delivered',
      maxPayment: '1', actualPayment: null,
      postedAt: 100, ackedAt: null, deliveredAt: null, claimedAt: null,
      prompt: 'hi', response: 'hello',
      promptTokens: null, completionTokens: null, errorMessage: null,
    })
    db.recordClientJob({
      jobId: '0xb', provider: 'p', modelId: 'm', status: 'delivered',
      maxPayment: '1', actualPayment: null,
      postedAt: 1000, ackedAt: null, deliveredAt: null, claimedAt: null,
      prompt: 'keep', response: 'me',
      promptTokens: null, completionTokens: null, errorMessage: null,
    })
    const changed = db.redactClientPayloadsBefore(500)
    expect(changed).toBe(1)
    const rows = db.listClientJobs({sinceSeconds: 0})
    const old = rows.find(r => r.jobId === '0xa')!
    const fresh = rows.find(r => r.jobId === '0xb')!
    expect(old.prompt).toBe('[expired]')
    expect(fresh.prompt).toBe('keep')
  })

  it('sums total spent xBZZ', () => {
    const db = mkDb()
    db.recordClientJob({
      jobId: '0x1', provider: 'p', modelId: 'm', status: 'claimed',
      maxPayment: '10', actualPayment: '7',
      postedAt: 1, ackedAt: null, deliveredAt: null, claimedAt: null,
      prompt: null, response: null,
      promptTokens: null, completionTokens: null, errorMessage: null,
    })
    db.recordClientJob({
      jobId: '0x2', provider: 'p', modelId: 'm', status: 'claimed',
      maxPayment: '10', actualPayment: '5',
      postedAt: 1, ackedAt: null, deliveredAt: null, claimedAt: null,
      prompt: null, response: null,
      promptTokens: null, completionTokens: null, errorMessage: null,
    })
    expect(db.totalSpentXBZZ()).toBe(12n)
  })
})
