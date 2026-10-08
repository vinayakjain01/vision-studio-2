import { describe, it, expect, beforeEach } from 'vitest'
import { createTestTenant } from '../helpers/tenancy-fixture'
import * as queue from '@/jobs/queue'
import { getControlDb } from '@/db/client'
import { migrateControl } from '@/db/migrate'
import { tenantQueueState } from '@/db/control-repositories'

describe('queue: enqueue/claim/lifecycle against control.db', () => {
  // claim() deliberately scans ACROSS every tenant — exactly the property
  // under test — so leftover jobs/tenants from an earlier test in this file
  // would otherwise bleed into the next one's claim() calls. Each test gets
  // a genuinely empty queue and tenant set, same as it would against a
  // freshly-provisioned control.db, not just a fresh temp directory (which
  // `tenant-env.ts` only gives once per FILE, not per test).
  beforeEach(() => {
    const db = getControlDb()
    migrateControl(db)
    db.exec('DELETE FROM jobs')
    db.exec('DELETE FROM tenant_queue_state')
    db.exec('DELETE FROM ai_extend_tenant_state')
    db.exec('DELETE FROM usage_counters')
    db.exec('DELETE FROM quotas')
    db.exec('DELETE FROM memberships')
    db.exec('DELETE FROM sessions')
    db.exec('DELETE FROM users')
    db.exec('DELETE FROM tenants')
  })


  it('enqueue scopes dedupe to (tenant_id, dedupe_key) — two tenants with the same key both get a job', () => {
    const a = createTestTenant('A')
    const b = createTestTenant('B')

    const resA = queue.enqueue(a.tenantId, [
      { kind: 'vision', payload: { imageId: 'img1', sourceHash: 'h1', storageKey: 'k1' }, dedupeKey: 'vision:h1' },
    ])
    const resB = queue.enqueue(b.tenantId, [
      { kind: 'vision', payload: { imageId: 'img1', sourceHash: 'h1', storageKey: 'k1' }, dedupeKey: 'vision:h1' },
    ])

    expect(resA.inserted).toBe(1)
    expect(resB.inserted).toBe(1)

    // But a SECOND enqueue for the SAME tenant with the same key is suppressed.
    const resADup = queue.enqueue(a.tenantId, [
      { kind: 'vision', payload: { imageId: 'img1', sourceHash: 'h1', storageKey: 'k1' }, dedupeKey: 'vision:h1' },
    ])
    expect(resADup.inserted).toBe(0)
    expect(resADup.deduplicated).toBe(1)
  })

  it('claim() never returns another tenant\'s job, and only ever opens one row per claim', () => {
    const a = createTestTenant('A')
    const b = createTestTenant('B')
    queue.enqueue(a.tenantId, [{ kind: 'vision', payload: { imageId: 'a1', sourceHash: 'ha', storageKey: 'ka' } }])
    queue.enqueue(b.tenantId, [{ kind: 'vision', payload: { imageId: 'b1', sourceHash: 'hb', storageKey: 'kb' } }])

    const first = queue.claim('vision', 'worker-1')
    const second = queue.claim('vision', 'worker-1')
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(new Set([first!.tenantId, second!.tenantId])).toEqual(new Set([a.tenantId, b.tenantId]))

    // Nothing left to claim.
    expect(queue.claim('vision', 'worker-1')).toBeNull()
  })

  it('interactive jobs are claimed before bulk, across tenants', () => {
    const a = createTestTenant('A')
    const b = createTestTenant('B')
    queue.enqueue(a.tenantId, [
      { kind: 'render', priorityClass: 'bulk', payload: { imageId: 'a1', productId: 'p', templateId: 't', sourceHash: 'h' } },
    ])
    queue.enqueue(b.tenantId, [
      { kind: 'render', priorityClass: 'interactive', payload: { imageId: 'b1', productId: 'p', templateId: 't', sourceHash: 'h' } },
    ])

    const claimed = queue.claim('render', 'worker-1')
    expect(claimed?.tenantId).toBe(b.tenantId)
    expect(claimed?.priorityClass).toBe('interactive')
  })

  it('fair-share: a tenant with 0 running jobs is claimed ahead of one already running jobs', () => {
    const busy = createTestTenant('Busy')
    const idle = createTestTenant('Idle')

    queue.enqueue(busy.tenantId, [
      { kind: 'vision', payload: { imageId: 'x1', sourceHash: 'hx1', storageKey: 'k' } },
      { kind: 'vision', payload: { imageId: 'x2', sourceHash: 'hx2', storageKey: 'k' } },
    ])
    queue.enqueue(idle.tenantId, [
      { kind: 'vision', payload: { imageId: 'y1', sourceHash: 'hy1', storageKey: 'k' } },
    ])

    // Claim one from `busy` first, so its running_jobs goes to 1.
    const busyJob = queue.claim('vision', 'w1')
    expect(busyJob?.tenantId).toBe(busy.tenantId)

    // Next claim: busy has running_jobs=1 (ratio 1/1), idle has running_jobs=0 (ratio 0/1) — idle wins.
    const next = queue.claim('vision', 'w2')
    expect(next?.tenantId).toBe(idle.tenantId)
  })

  it('respects admin-set weight — a higher-weight tenant gets more of the fair share', () => {
    const heavy = createTestTenant('Heavy')
    const light = createTestTenant('Light')
    tenantQueueState.setWeight(heavy.tenantId, 4)
    tenantQueueState.setWeight(light.tenantId, 1)

    for (let i = 0; i < 4; i++) {
      queue.enqueue(heavy.tenantId, [{ kind: 'vision', payload: { imageId: `h${i}`, sourceHash: `hh${i}`, storageKey: 'k' } }])
    }
    queue.enqueue(light.tenantId, [{ kind: 'vision', payload: { imageId: 'l0', sourceHash: 'hl0', storageKey: 'k' } }])

    // heavy (weight 4) should win 3 of the first 4 claims before light (weight 1) gets its turn,
    // since fairness compares running_jobs/weight: heavy can reach running_jobs=3 (ratio 0.75)
    // before exceeding light's ratio at running_jobs=1 (ratio 1.0).
    const winners: string[] = []
    for (let i = 0; i < 4; i++) {
      const job = queue.claim('vision', `w${i}`)
      winners.push(job!.tenantId)
    }
    const lightWins = winners.filter(t => t === light.tenantId).length
    const heavyWins = winners.filter(t => t === heavy.tenantId).length
    expect(heavyWins).toBeGreaterThan(lightWins)
  })

  it('complete()/fail() decrement running_jobs; a stale complete (wrong worker) is a no-op', () => {
    const t = createTestTenant('T')
    queue.enqueue(t.tenantId, [{ kind: 'vision', payload: { imageId: 'i1', sourceHash: 'h1', storageKey: 'k' } }])
    const job = queue.claim('vision', 'worker-A')!
    queue.markRunning(job.id, 'worker-A')

    expect(tenantQueueState.get(t.tenantId)?.runningJobs).toBe(1)

    // A different worker (e.g. reclaimed-but-still-alive) tries to complete it — rejected.
    const staleResult = queue.complete(job.id, 'worker-B', { ok: true })
    expect(staleResult.ok).toBe(false)
    expect(tenantQueueState.get(t.tenantId)?.runningJobs).toBe(1) // unchanged

    // The real owner completes it.
    const realResult = queue.complete(job.id, 'worker-A', { ok: true })
    expect(realResult.ok).toBe(true)
    expect(tenantQueueState.get(t.tenantId)?.runningJobs).toBe(0)

    const final = queue.get(t.tenantId, job.id)
    expect(final?.status).toBe('completed')
  })

  it('fail() retries with backoff (available_at in the future) until max_attempts, then parks as failed', () => {
    const t = createTestTenant('T')
    queue.enqueue(t.tenantId, [
      { kind: 'vision', payload: { imageId: 'i1', sourceHash: 'h1', storageKey: 'k' }, maxAttempts: 2 },
    ])

    // Attempt 1: claim, fail, should retry.
    const job1 = queue.claim('vision', 'w1')!
    const result1 = queue.fail(job1.id, 'w1', 'transient error')
    expect(result1.retrying).toBe(true)

    const afterFail1 = queue.get(t.tenantId, job1.id)!
    expect(afterFail1.status).toBe('pending')
    expect(afterFail1.availableAt).not.toBeNull()
    expect(new Date(afterFail1.availableAt!).getTime()).toBeGreaterThan(Date.now())

    // Not claimable yet (backoff hasn't elapsed) — claim() should skip it.
    expect(queue.claim('vision', 'w2')).toBeNull()
  })

  it('reclaimStale() requeues a job whose lease expired, and decrements running_jobs', () => {
    const t = createTestTenant('T')
    queue.enqueue(t.tenantId, [{ kind: 'vision', payload: { imageId: 'i1', sourceHash: 'h1', storageKey: 'k' } }])
    const job = queue.claim('vision', 'dead-worker')!
    expect(tenantQueueState.get(t.tenantId)?.runningJobs).toBe(1)

    // Force the lease to have already expired.
    getControlDb().prepare(`UPDATE jobs SET lease_expires_at = ? WHERE id = ?`).run(
      new Date(Date.now() - 1000).toISOString(),
      job.id
    )

    const reclaimed = queue.reclaimStale()
    expect(reclaimed).toBe(1)
    expect(tenantQueueState.get(t.tenantId)?.runningJobs).toBe(0)

    const after = queue.get(t.tenantId, job.id)!
    expect(after.status).toBe('pending')
    expect(after.workerId).toBeNull()
  })

  it('reclaimStale() fails a job outright once max_attempts is exhausted, rather than requeuing forever', () => {
    const t = createTestTenant('T')
    queue.enqueue(t.tenantId, [
      { kind: 'vision', payload: { imageId: 'i1', sourceHash: 'h1', storageKey: 'k' }, maxAttempts: 1 },
    ])
    const job = queue.claim('vision', 'dead-worker')! // attempts is now 1 (== maxAttempts)

    getControlDb().prepare(`UPDATE jobs SET lease_expires_at = ? WHERE id = ?`).run(
      new Date(Date.now() - 1000).toISOString(),
      job.id
    )

    queue.reclaimStale()
    const after = queue.get(t.tenantId, job.id)!
    expect(after.status).toBe('failed')
  })

  it('cancelBatch cancels pending/claimed jobs and decrements running_jobs for claimed ones only', () => {
    const t = createTestTenant('T')
    queue.enqueue(t.tenantId, [
      { kind: 'render', batchId: 'bat1', payload: { imageId: 'i1', productId: 'p', templateId: 'tm', sourceHash: 'h1' } },
      { kind: 'render', batchId: 'bat1', payload: { imageId: 'i2', productId: 'p', templateId: 'tm', sourceHash: 'h2' } },
    ])
    queue.claim('render', 'w1') // claims one of them
    expect(tenantQueueState.get(t.tenantId)?.runningJobs).toBe(1)

    const cancelled = queue.cancelBatch(t.tenantId, 'bat1')
    expect(cancelled).toBe(2)
    expect(tenantQueueState.get(t.tenantId)?.runningJobs).toBe(0)
  })

  it('batchJobCounts reflects status transitions accurately', () => {
    const t = createTestTenant('T')
    queue.enqueue(t.tenantId, [
      { kind: 'render', batchId: 'bat1', payload: { imageId: 'i1', productId: 'p', templateId: 'tm', sourceHash: 'h1' } },
      { kind: 'render', batchId: 'bat1', payload: { imageId: 'i2', productId: 'p', templateId: 'tm', sourceHash: 'h2' } },
    ])
    const job1 = queue.claim('render', 'w1')!
    queue.complete(job1.id, 'w1', {})

    const counts = queue.batchJobCounts(t.tenantId, 'bat1')
    expect(counts).toEqual({ total: 2, completed: 1, failed: 0, cancelled: 0, active: 1 })
  })

  it('promoteAgedBulkJobs promotes only bulk jobs older than the cutoff', () => {
    const t = createTestTenant('T')
    queue.enqueue(t.tenantId, [
      { kind: 'vision', priorityClass: 'bulk', payload: { imageId: 'old', sourceHash: 'ho', storageKey: 'k' } },
    ])
    // Backdate created_at so it's definitely "aged".
    getControlDb().prepare(`UPDATE jobs SET created_at = ? WHERE tenant_id = ?`).run(
      new Date(Date.now() - 10_000).toISOString(),
      t.tenantId
    )
    queue.enqueue(t.tenantId, [
      { kind: 'vision', priorityClass: 'bulk', payload: { imageId: 'fresh', sourceHash: 'hf', storageKey: 'k' } },
    ])

    const promoted = queue.promoteAgedBulkJobs(5) // 5 seconds
    expect(promoted).toBe(1)

    const job = queue.claim('vision', 'w1')!
    expect(job.priorityClass).toBe('interactive') // the aged one jumps ahead
    expect((job.payload as any).imageId).toBe('old')
  })
})

/**
 * P3 moves `jobs` into ONE physical table shared by every tenant — unlike
 * batches, products, etc., which stay in separate per-tenant DB FILES where
 * cross-tenant access is structurally impossible. These tests prove the
 * every tenant-scoped read/write in queue.ts enforces that boundary itself
 * (a WHERE tenant_id = ? clause, not an accident of file layout), directly
 * at the data layer — independent of (and in addition to) the HTTP-route
 * isolation suite in tests/isolation/, which already proves the SAME thing
 * end-to-end through routes like /api/batches/[batchId] (whose own 404
 * check against the caller's tenant-scoped `batches` table happens to catch
 * a cross-tenant batchId before any queue.ts call is ever reached — this
 * suite is what proves queue.ts would ALSO refuse it even if that outer
 * check were ever bypassed or a new call site forgot it).
 */
describe('queue: cross-tenant ID scoping (shared physical table)', () => {
  beforeEach(() => {
    const db = getControlDb()
    migrateControl(db)
    db.exec('DELETE FROM jobs')
    db.exec('DELETE FROM tenant_queue_state')
    db.exec('DELETE FROM memberships')
    db.exec('DELETE FROM sessions')
    db.exec('DELETE FROM users')
    db.exec('DELETE FROM tenants')
  })

  it('get() returns null for another tenant\'s real job id, never the row', () => {
    const a = createTestTenant('A')
    const b = createTestTenant('B')
    const { ids } = queue.enqueue(a.tenantId, [
      { kind: 'vision', payload: { imageId: 'i1', sourceHash: 'h1', storageKey: 'k' } },
    ])
    expect(queue.get(b.tenantId, ids[0])).toBeNull()
    expect(queue.get(a.tenantId, ids[0])).not.toBeNull()
  })

  it('listByBatch() never returns another tenant\'s jobs even for the same batchId string', () => {
    const a = createTestTenant('A')
    const b = createTestTenant('B')
    // Deliberately the SAME batchId value for both tenants — batchId is only
    // ever looked up scoped by (tenant_id, batch_id) together, never alone.
    queue.enqueue(a.tenantId, [
      { kind: 'render', batchId: 'shared-id', payload: { imageId: 'i1', productId: 'p', templateId: 't', sourceHash: 'h1' } },
    ])
    queue.enqueue(b.tenantId, [
      { kind: 'render', batchId: 'shared-id', payload: { imageId: 'i2', productId: 'p', templateId: 't', sourceHash: 'h2' } },
    ])

    const aJobs = queue.listByBatch(a.tenantId, 'shared-id')
    const bJobs = queue.listByBatch(b.tenantId, 'shared-id')
    expect(aJobs).toHaveLength(1)
    expect(bJobs).toHaveLength(1)
    expect(aJobs[0].id).not.toBe(bJobs[0].id)
    expect((aJobs[0].payload as any).imageId).toBe('i1')
    expect((bJobs[0].payload as any).imageId).toBe('i2')
  })

  it('cancelBatch() scoped to the wrong tenant cancels nothing, even with the right batchId', () => {
    const a = createTestTenant('A')
    const b = createTestTenant('B')
    queue.enqueue(a.tenantId, [
      { kind: 'render', batchId: 'bat1', payload: { imageId: 'i1', productId: 'p', templateId: 't', sourceHash: 'h1' } },
    ])

    const cancelledByB = queue.cancelBatch(b.tenantId, 'bat1')
    expect(cancelledByB).toBe(0)

    const stillPending = queue.get(a.tenantId, queue.listByBatch(a.tenantId, 'bat1')[0].id)!
    expect(stillPending.status).toBe('pending') // untouched by B's call
  })

  it('retryBatch() scoped to the wrong tenant retries nothing', () => {
    const a = createTestTenant('A')
    const b = createTestTenant('B')
    queue.enqueue(a.tenantId, [
      { kind: 'render', batchId: 'bat1', payload: { imageId: 'i1', productId: 'p', templateId: 't', sourceHash: 'h1' } },
    ])
    const job = queue.claim('render', 'w1')!
    // Force it to 'failed' directly — a deterministic starting point,
    // independent of how many attempts fail() would need to get there.
    getControlDb().prepare(`UPDATE jobs SET status = 'failed' WHERE id = ?`).run(job.id)

    const retriedByB = queue.retryBatch(b.tenantId, 'bat1')
    expect(retriedByB).toBe(0)
    expect(queue.get(a.tenantId, job.id)!.status).toBe('failed') // untouched
  })

  it('retry() (single job) scoped to the wrong tenant does nothing and returns false', () => {
    const a = createTestTenant('A')
    const b = createTestTenant('B')
    const { ids } = queue.enqueue(a.tenantId, [
      { kind: 'vision', payload: { imageId: 'i1', sourceHash: 'h1', storageKey: 'k' } },
    ])
    const job = queue.claim('vision', 'w1')!
    getControlDb().prepare(`UPDATE jobs SET status = 'failed' WHERE id = ?`).run(job.id)

    expect(queue.retry(b.tenantId, ids[0])).toBe(false)
    expect(queue.get(a.tenantId, ids[0])!.status).toBe('failed') // untouched

    expect(queue.retry(a.tenantId, ids[0])).toBe(true)
    expect(queue.get(a.tenantId, ids[0])!.status).toBe('pending')
  })

  it('findLatestByDedupeKey()/findRecent() never cross tenants, even with the identical dedupe key string', () => {
    const a = createTestTenant('A')
    const b = createTestTenant('B')
    queue.enqueue(a.tenantId, [
      { kind: 'vision', payload: { imageId: 'i1', sourceHash: 'h1', storageKey: 'k' }, dedupeKey: 'same-key' },
    ])

    expect(queue.findLatestByDedupeKey(b.tenantId, 'same-key')).toBeNull()
    expect(queue.findLatestByDedupeKey(a.tenantId, 'same-key')).not.toBeNull()
    expect(queue.findRecent(b.tenantId, 'same-key', 60_000)).toBeNull()
    expect(queue.findRecent(a.tenantId, 'same-key', 60_000)).not.toBeNull()
  })

  it('deleteJobsForBatch() removes only the target tenant+batch\'s rows and decrements running_jobs for active ones', () => {
    const a = createTestTenant('A')
    const b = createTestTenant('B')
    queue.enqueue(a.tenantId, [
      { kind: 'render', batchId: 'bat1', payload: { imageId: 'i1', productId: 'p', templateId: 't', sourceHash: 'h1' } },
      { kind: 'render', batchId: 'bat1', payload: { imageId: 'i2', productId: 'p', templateId: 't', sourceHash: 'h2' } },
    ])
    queue.enqueue(b.tenantId, [
      { kind: 'render', batchId: 'bat1', payload: { imageId: 'i3', productId: 'p', templateId: 't', sourceHash: 'h3' } },
    ])
    queue.claim('render', 'w1') // claims one of A's two jobs
    expect(tenantQueueState.get(a.tenantId)?.runningJobs).toBe(1)

    const deleted = queue.deleteJobsForBatch(a.tenantId, 'bat1')
    expect(deleted).toBe(2) // both of A's jobs, not B's

    expect(queue.listByBatch(a.tenantId, 'bat1')).toHaveLength(0)
    expect(queue.listByBatch(b.tenantId, 'bat1')).toHaveLength(1) // B's untouched
    expect(tenantQueueState.get(a.tenantId)?.runningJobs).toBe(0)
  })

  it('stats() scoped to one tenant never counts another tenant\'s jobs', () => {
    const a = createTestTenant('A')
    const b = createTestTenant('B')
    queue.enqueue(a.tenantId, [
      { kind: 'vision', payload: { imageId: 'i1', sourceHash: 'h1', storageKey: 'k' } },
      { kind: 'vision', payload: { imageId: 'i2', sourceHash: 'h2', storageKey: 'k' } },
    ])
    queue.enqueue(b.tenantId, [{ kind: 'vision', payload: { imageId: 'j1', sourceHash: 'h3', storageKey: 'k' } }])

    expect(queue.stats('vision', a.tenantId).pending).toBe(2)
    expect(queue.stats('vision', b.tenantId).pending).toBe(1)
    expect(queue.stats('vision').pending).toBe(3) // global, no tenantId
  })

  describe('cancelAll()', () => {
    it('cancels pending, claimed, AND running jobs for one tenant — unlike cancelBatch, which leaves running jobs alone', () => {
      const a = createTestTenant('A')
      queue.enqueue(a.tenantId, [
        { kind: 'vision', payload: { imageId: 'i1', sourceHash: 'h1', storageKey: 'k' } },
        { kind: 'vision', payload: { imageId: 'i2', sourceHash: 'h2', storageKey: 'k' } },
        { kind: 'vision', payload: { imageId: 'i3', sourceHash: 'h3', storageKey: 'k' } },
      ])
      const claimed = queue.claim('vision', 'w1')!
      queue.markRunning(claimed.id, 'w1') // this one is now genuinely 'running', not just 'claimed'
      queue.claim('vision', 'w2') // a second one sits at 'claimed'
      // The third stays 'pending'.

      const result = queue.cancelAll(a.tenantId)
      expect(result.cancelled).toBe(3)
      expect(result.tenantsAffected).toEqual([a.tenantId])

      const stats = queue.stats('vision', a.tenantId)
      expect(stats.cancelled).toBe(3)
      expect(stats.pending + stats.claimed + stats.running).toBe(0)
      expect(tenantQueueState.get(a.tenantId)?.runningJobs).toBe(0)
    })

    it('with no tenantId, clears every tenant\'s queue; with one, leaves every other tenant untouched', () => {
      const a = createTestTenant('A')
      const b = createTestTenant('B')
      queue.enqueue(a.tenantId, [{ kind: 'vision', payload: { imageId: 'i1', sourceHash: 'h1', storageKey: 'k' } }])
      queue.enqueue(b.tenantId, [{ kind: 'vision', payload: { imageId: 'j1', sourceHash: 'h2', storageKey: 'k' } }])

      queue.cancelAll(a.tenantId)
      expect(queue.stats('vision', a.tenantId).pending).toBe(0)
      expect(queue.stats('vision', b.tenantId).pending).toBe(1) // B untouched

      const result = queue.cancelAll() // no tenantId — everyone
      expect(result.cancelled).toBe(1) // only B had anything left
      expect(queue.stats('vision', b.tenantId).pending).toBe(0)
    })

    it('a late, stale complete() from a zombie worker after cancelAll() is a no-op', () => {
      const a = createTestTenant('A')
      queue.enqueue(a.tenantId, [{ kind: 'vision', payload: { imageId: 'i1', sourceHash: 'h1', storageKey: 'k' } }])
      const claimed = queue.claim('vision', 'zombie-worker')!
      queue.markRunning(claimed.id, 'zombie-worker')

      queue.cancelAll(a.tenantId)

      const result = queue.complete(claimed.id, 'zombie-worker')
      expect(result.ok).toBe(false) // ownedRow no longer matches — the row is 'cancelled' now
      expect(queue.stats('vision', a.tenantId).cancelled).toBe(1)
      expect(queue.stats('vision', a.tenantId).completed).toBe(0)
    })
  })

  describe('returnToPending() — P6 graceful shutdown', () => {
    it('hands a running job back to pending WITHOUT consuming an attempt, and decrements running_jobs', () => {
      const a = createTestTenant('A')
      queue.enqueue(a.tenantId, [{ kind: 'vision', payload: { imageId: 'i1', sourceHash: 'h1', storageKey: 'k' } }])
      const job = queue.claim('vision', 'w1')!
      queue.markRunning(job.id, 'w1')
      expect(tenantQueueState.get(a.tenantId)?.runningJobs).toBe(1)

      const result = queue.returnToPending(job.id, 'w1')
      expect(result).toBe(true)

      const row = queue.get(a.tenantId, job.id)!
      expect(row.status).toBe('pending')
      expect(row.attempts).toBe(0) // the defining difference from fail()/reclaimStale()
      expect(tenantQueueState.get(a.tenantId)?.runningJobs).toBe(0)

      // Immediately claimable again — nothing about the row is left in a
      // half-returned state.
      const reclaimed = queue.claim('vision', 'w2')
      expect(reclaimed?.id).toBe(job.id)
    })

    it('is a no-op for a job already finished, or claimed by a different worker (stale write guard)', () => {
      const a = createTestTenant('A')
      queue.enqueue(a.tenantId, [{ kind: 'vision', payload: { imageId: 'i1', sourceHash: 'h1', storageKey: 'k' } }])
      const job = queue.claim('vision', 'w1')!
      queue.markRunning(job.id, 'w1')

      expect(queue.returnToPending(job.id, 'wrong-worker')).toBe(false)
      expect(queue.get(a.tenantId, job.id)!.status).toBe('running') // untouched

      queue.complete(job.id, 'w1')
      expect(queue.returnToPending(job.id, 'w1')).toBe(false) // already completed
      expect(queue.get(a.tenantId, job.id)!.status).toBe('completed')
    })
  })
})
