import { describe, it, expect, beforeEach } from 'vitest'
import { createTestTenant } from '../helpers/tenancy-fixture'
import { getControlDb } from '@/db/client'
import { migrateControl } from '@/db/migrate'
import {
  hourBucketFor,
  computeHourlyRollup,
  backfillHourlyRollups,
  pruneHourlyRollups,
  getQueueWaitPercentiles,
} from '@/jobs/queue-wait-rollup'

describe('queue-wait-rollup', () => {
  beforeEach(() => {
    const db = getControlDb()
    migrateControl(db)
    db.exec('DELETE FROM jobs')
    db.exec('DELETE FROM queue_wait_hourly_rollups')
    db.exec('DELETE FROM tenant_queue_state')
    db.exec('DELETE FROM ai_extend_tenant_state')
    db.exec('DELETE FROM usage_counters')
    db.exec('DELETE FROM quotas')
    db.exec('DELETE FROM memberships')
    db.exec('DELETE FROM sessions')
    db.exec('DELETE FROM users')
    db.exec('DELETE FROM tenants')
  })

  function insertJob(tenantId: string, createdAt: Date, waitMs: number | null) {
    const db = getControlDb()
    const id = `job_${Math.random().toString(36).slice(2)}`
    const startedAt = waitMs === null ? null : new Date(createdAt.getTime() + waitMs).toISOString()
    db.prepare(
      `INSERT INTO jobs (id, tenant_id, kind, priority_class, status, priority, payload, attempts, max_attempts,
                         created_at, started_at, updated_at)
       VALUES (?, ?, 'vision', 'bulk', 'completed', 100, '{}', 0, 3, ?, ?, ?)`
    ).run(id, tenantId, createdAt.toISOString(), startedAt, createdAt.toISOString())
  }

  it('computeHourlyRollup produces exact p50/p95 for one hour, scoped per tenant', () => {
    const tenant = createTestTenant('RollupExact')
    const hourStart = new Date('2026-01-01T10:00:00.000Z')

    // 10 jobs with wait times 100..1000ms, evenly spaced within the hour.
    const waits = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]
    for (const w of waits) {
      insertJob(tenant.tenantId, new Date(hourStart.getTime() + w), w)
    }

    const results = computeHourlyRollup(hourBucketFor(hourStart))
    const stats = results.find(r => r.tenantId === tenant.tenantId)!
    expect(stats.sampleCount).toBe(10)
    // Sorted waits: [100..1000], p50 index = floor(0.5*10)=5 -> 600; p95 index = floor(0.95*10)=9 -> 1000.
    expect(stats.p50Ms).toBe(600)
    expect(stats.p95Ms).toBe(1000)

    // Persisted — a second read without recomputing sees the same row.
    const row = getControlDb()
      .prepare('SELECT * FROM queue_wait_hourly_rollups WHERE tenant_id = ? AND hour_bucket = ?')
      .get(tenant.tenantId, hourBucketFor(hourStart)) as any
    expect(row.sample_count).toBe(10)
    expect(row.p50_ms).toBe(600)
  })

  it('a job still pending (no started_at) is excluded from the wait calculation', () => {
    const tenant = createTestTenant('RollupPending')
    const hourStart = new Date('2026-01-01T11:00:00.000Z')
    insertJob(tenant.tenantId, new Date(hourStart.getTime() + 100), 500)
    insertJob(tenant.tenantId, new Date(hourStart.getTime() + 200), null) // never started

    const results = computeHourlyRollup(hourBucketFor(hourStart))
    const stats = results.find(r => r.tenantId === tenant.tenantId)!
    expect(stats.sampleCount).toBe(1)
  })

  it('backfillHourlyRollups fills in a missing past hour and does not recompute it once it has data', () => {
    const tenant = createTestTenant('RollupBackfill')
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    insertJob(tenant.tenantId, twoHoursAgo, 250)

    backfillHourlyRollups()

    const row = getControlDb()
      .prepare('SELECT * FROM queue_wait_hourly_rollups WHERE tenant_id = ? AND hour_bucket = ?')
      .get(tenant.tenantId, hourBucketFor(twoHoursAgo)) as any
    expect(row.sample_count).toBe(1)
    const firstComputedAt = row.computed_at

    // Second pass: a bucket that already has a row is skipped entirely, so
    // its computed_at is untouched — it is not re-queried against `jobs`.
    // (Hours with NO data at all get re-checked on every sweep, since there
    // is nothing to record "already looked, found nothing" — cheap, bounded
    // per hour, and not what this assertion is about.)
    backfillHourlyRollups()
    const rowAfter = getControlDb()
      .prepare('SELECT * FROM queue_wait_hourly_rollups WHERE tenant_id = ? AND hour_bucket = ?')
      .get(tenant.tenantId, hourBucketFor(twoHoursAgo)) as any
    expect(rowAfter.computed_at).toBe(firstComputedAt)
  })

  it('pruneHourlyRollups removes rows older than the retention window', () => {
    const db = getControlDb()
    const tenant = createTestTenant('RollupPrune')
    const oldBucket = hourBucketFor(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
    const recentBucket = hourBucketFor(new Date(Date.now() - 2 * 60 * 60 * 1000))
    db.prepare(
      `INSERT INTO queue_wait_hourly_rollups (tenant_id, hour_bucket, sample_count, p50_ms, p95_ms, computed_at)
       VALUES (?, ?, 1, 100, 100, ?), (?, ?, 1, 100, 100, ?)`
    ).run(tenant.tenantId, oldBucket, new Date().toISOString(), tenant.tenantId, recentBucket, new Date().toISOString())

    const removed = pruneHourlyRollups(24 * 14)
    expect(removed).toBe(1)
    const remaining = db.prepare('SELECT hour_bucket FROM queue_wait_hourly_rollups').all() as { hour_bucket: string }[]
    expect(remaining.map(r => r.hour_bucket)).toEqual([recentBucket])
  })

  it('getQueueWaitPercentiles combines rolled-up past hours with a live current-hour read, without writing anything for the live hour', () => {
    const tenant = createTestTenant('RollupLive')
    const db = getControlDb()

    // One rolled-up hour, 3 hours ago.
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000)
    insertJob(tenant.tenantId, threeHoursAgo, 1000)
    computeHourlyRollup(hourBucketFor(threeHoursAgo))

    // One job in the CURRENT hour, never rolled up.
    insertJob(tenant.tenantId, new Date(), 2000)

    const countBefore = (
      db.prepare('SELECT COUNT(*) AS n FROM queue_wait_hourly_rollups').get() as { n: number }
    ).n

    const result = getQueueWaitPercentiles(tenant.tenantId, 24)
    expect(result.sampleCount).toBe(2)

    // The live hour must NOT have been persisted by a read call.
    const countAfter = (
      db.prepare('SELECT COUNT(*) AS n FROM queue_wait_hourly_rollups').get() as { n: number }
    ).n
    expect(countAfter).toBe(countBefore)
  })

  it('a tenant with no queue-wait samples at all gets zeros, not an error', () => {
    const tenant = createTestTenant('RollupEmpty')
    const result = getQueueWaitPercentiles(tenant.tenantId, 24)
    expect(result).toEqual({ p50Ms: 0, p95Ms: 0, sampleCount: 0 })
  })
})
