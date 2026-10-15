import { describe, it, expect, beforeEach } from 'vitest'
import { createTestTenant } from '../helpers/tenancy-fixture'
import { getControlDb } from '@/db/client'
import { migrateControl } from '@/db/migrate'
import * as queue from '@/jobs/queue'
import { getDiagnostics } from '@/services/admin-service'

/**
 * Phase 1.2 (docs/ISSUES.md): tests/admin/no-tenant-content.test.ts already
 * covers the privacy boundary (no product/filename/template content) for
 * this endpoint. This file covers the actual diagnostic LOGIC — job
 * bucketing, oldest-claimed-or-running detection, and deferral-loop
 * candidates — against real control.db rows, not mocks.
 */
describe('getDiagnostics()', () => {
  // Every test here calls the real claim() against the real fair-share
  // scheduler — a leftover 'pending' job from an earlier test in this file
  // is an older, equally-fair candidate that would legitimately win the
  // tie-break over a test's own freshly enqueued job. Clear the slate so
  // each test's claim() can only possibly pick its own work.
  beforeEach(() => {
    // migrateControl is idempotent — needed here because this beforeEach can
    // run before the FIRST test's createTestTenant() has ever migrated
    // control.db (tenancy-fixture.ts migrates lazily, on first use).
    migrateControl(getControlDb())
    queue.cancelAll()
  })


  it('buckets jobs by kind and status, with the oldest age in each bucket', async () => {
    const tenant = await createTestTenant('DiagBuckets')
    queue.enqueue(tenant.tenantId, [
      { kind: 'vision', payload: { imageId: 'img_a', sourceHash: 'a'.repeat(64), storageKey: 'a/a/a.jpg' } },
      { kind: 'vision', payload: { imageId: 'img_b', sourceHash: 'b'.repeat(64), storageKey: 'b/b/b.jpg' } },
    ])

    const diag = await getDiagnostics()
    const pendingVision = diag.jobsByBucket.find(b => b.kind === 'vision' && b.status === 'pending')
    expect(pendingVision).toBeTruthy()
    expect(pendingVision!.count).toBeGreaterThanOrEqual(2)
    expect(pendingVision!.oldestAgeMs).toBeGreaterThanOrEqual(0)
  })

  it('reports the oldest claimed/running job across every tenant', async () => {
    const tenantA = await createTestTenant('DiagOldestA')
    const tenantB = await createTestTenant('DiagOldestB')

    const { ids: idsA } = queue.enqueue(tenantA.tenantId, [
      { kind: 'vision', payload: { imageId: 'img_old', sourceHash: 'c'.repeat(64), storageKey: 'c/c/c.jpg' } },
    ])
    // Backdate this one's created_at so it claims as the OLDER of the two,
    // and claim it first so its claimed_at is also the earliest.
    getControlDb()
      .prepare(`UPDATE jobs SET created_at = datetime('now', '-1 hour') WHERE id = ?`)
      .run(idsA[0])
    const claimedOld = queue.claim('vision', 'worker-old')
    expect(claimedOld?.id).toBe(idsA[0])

    queue.enqueue(tenantB.tenantId, [
      { kind: 'vision', payload: { imageId: 'img_new', sourceHash: 'd'.repeat(64), storageKey: 'd/d/d.jpg' } },
    ])
    queue.claim('vision', 'worker-new')

    const diag = await getDiagnostics()
    expect(diag.oldestClaimedOrRunning).toBeTruthy()
    expect(diag.oldestClaimedOrRunning!.jobId).toBe(idsA[0])
    expect(diag.oldestClaimedOrRunning!.tenantId).toBe(tenantA.tenantId)
  })

  it('flags jobs one attempt away from exhausting maxAttempts as deferral-loop candidates', async () => {
    const tenant = await createTestTenant('DiagDeferralLoop')
    const { ids } = queue.enqueue(tenant.tenantId, [
      { kind: 'vision', payload: { imageId: 'img_loop', sourceHash: 'e'.repeat(64), storageKey: 'e/e/e.jpg' } },
    ])
    // One real claim+fail cycle (exercises the actual path a struggling job
    // takes), then a direct attempts bump for the second — fail()'s retry
    // backoff deliberately delays when a job becomes claimable again
    // (retryBackoffMs), so looping real claim/fail cycles back-to-back in a
    // unit test would mean waiting out that real backoff, which is fail()'s
    // own behavior to test, not this aggregation logic's.
    const claimed = queue.claim('vision', 'worker-0')
    expect(claimed?.id).toBe(ids[0])
    queue.fail(ids[0], 'worker-0', 'simulated transient failure')
    getControlDb().prepare(`UPDATE jobs SET attempts = 2 WHERE id = ?`).run(ids[0])

    const diag = await getDiagnostics()
    const candidate = diag.deferralLoopCandidates.find(c => c.jobId === ids[0])
    expect(candidate).toBeTruthy()
    expect(candidate!.attempts).toBe(2)
    expect(candidate!.maxAttempts).toBe(3)
  })

  it('reports queue depth, memory, and worker list without throwing even with no pool running', async () => {
    const diag = await getDiagnostics()
    expect(diag.queueDepthTotal).toBeGreaterThanOrEqual(0)
    expect(diag.memory.rssMb).toBeGreaterThan(0)
    expect(Array.isArray(diag.workers)).toBe(true)
  })
})
