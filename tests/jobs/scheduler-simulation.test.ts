import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestTenant } from '../helpers/tenancy-fixture'
import * as queue from '@/jobs/queue'
import { getControlDb } from '@/db/client'
import { migrateControl } from '@/db/migrate'
import { tenantQueueState } from '@/db/control-repositories'

/**
 * Deterministic scheduler simulation — no real workers, no ML, no real
 * clock. `vi.setSystemTime` drives a virtual clock that `queue.ts`'s plain
 * `Date.now()`/`nowIso()` calls read transparently (no production code
 * changed for testability); a handful of simulated "workers" claim and
 * "complete" jobs against the REAL claim()/complete() implementation, each
 * taking a fixed, configurable amount of SIMULATED time — so the whole
 * suite runs in milliseconds of real wall-clock time regardless of how much
 * simulated time it models.
 */
describe('scheduler simulation (virtual clock)', () => {
  const JOB_DURATION_MS = 50
  const IDLE_POLL_MS = 10

  beforeEach(() => {
    const db = getControlDb()
    migrateControl(db)
    db.exec('DELETE FROM jobs')
    db.exec('DELETE FROM tenant_queue_state')
    db.exec('DELETE FROM memberships')
    db.exec('DELETE FROM sessions')
    db.exec('DELETE FROM users')
    db.exec('DELETE FROM tenants')
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  interface WorkerState {
    nextEventAt: number
    id: string
    pendingJobId: string | null
  }

  /**
   * Runs `workerCount` simulated workers against `kind` until the queue is
   * drained (or `maxSteps` is hit, as a safety net against an infinite loop
   * from a test bug).
   *
   * Proper discrete-event simulation, not a per-worker claim-then-complete
   * loop: every worker whose next event falls at the current earliest
   * virtual instant is processed TOGETHER, in order, before the clock moves
   * on. That matters — completing a job before giving every OTHER worker
   * free at that same instant a chance to claim would let `running_jobs`
   * fall back to 0 between them, hiding exactly the cross-tenant fairness
   * signal this suite exists to check (an earlier version of this test had
   * that bug: each worker's claim+complete pair was fully resolved before
   * the next worker's claim, so two tenants tied at running_jobs=0 on
   * literally every claim and the second worker's fairness pick never had
   * anything to prefer).
   *
   * Returns every claimed job's `{tenantId, jobId, claimedAtMs, priorityClass}`
   * in claim order, for the assertions below to analyze.
   */
  function simulate(
    kind: 'vision' | 'render',
    workerCount: number,
    maxSteps = 5000
  ): { tenantId: string; jobId: string; claimedAtMs: number; priorityClass: string }[] {
    const workers: WorkerState[] = Array.from({ length: workerCount }, (_, i) => ({
      nextEventAt: Date.now(),
      id: `sim-worker-${i}`,
      pendingJobId: null,
    }))

    const history: { tenantId: string; jobId: string; claimedAtMs: number; priorityClass: string }[] = []
    let idleStreak = 0

    for (let step = 0; step < maxSteps; step++) {
      const minTime = Math.min(...workers.map(w => w.nextEventAt))
      vi.setSystemTime(minTime)

      const due = workers.filter(w => w.nextEventAt === minTime)
      let progressed = false

      for (const w of due) {
        if (w.pendingJobId) {
          queue.complete(w.pendingJobId, w.id, {})
          w.pendingJobId = null
          progressed = true
        }

        const job = queue.claim(kind, w.id)
        if (job) {
          queue.markRunning(job.id, w.id)
          history.push({
            tenantId: job.tenantId,
            jobId: job.id,
            claimedAtMs: minTime,
            priorityClass: job.priorityClass,
          })
          w.pendingJobId = job.id
          w.nextEventAt = minTime + JOB_DURATION_MS
          progressed = true
        } else {
          w.nextEventAt = minTime + IDLE_POLL_MS
        }
      }

      if (!progressed) {
        idleStreak++
        if (idleStreak > workerCount * 3) break
      } else {
        idleStreak = 0
      }
    }

    return history
  }

  function assertNoRunningJobsDrift(): void {
    const db = getControlDb()
    for (const state of tenantQueueState.listAll()) {
      const actual = (
        db
          .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE tenant_id = ? AND status IN ('claimed', 'running')`)
          .get(state.tenantId) as { n: number }
      ).n
      expect(actual, `tenant ${state.tenantId} running_jobs drifted`).toBe(state.runningJobs)
    }
  }

  it('a light tenant is not starved by one heavy tenant with 500 queued jobs', () => {
    const heavy = createTestTenant('Heavy')
    const light = createTestTenant('Light')

    queue.enqueue(
      heavy.tenantId,
      Array.from({ length: 500 }, (_, i) => ({
        kind: 'vision' as const,
        priorityClass: 'bulk' as const,
        payload: { imageId: `heavy-${i}`, sourceHash: `h${i}`, storageKey: 'k' },
      }))
    )
    const lightEnqueueTime = Date.now()
    queue.enqueue(light.tenantId, [
      { kind: 'vision', priorityClass: 'bulk', payload: { imageId: 'light-0', sourceHash: 'hl0', storageKey: 'k' } },
    ])

    const history = simulate('vision', 2)
    const lightClaim = history.find(h => h.tenantId === light.tenantId)
    expect(lightClaim, 'light tenant\'s job was never claimed').toBeDefined()

    const waitMs = lightClaim!.claimedAtMs - lightEnqueueTime
    // Fairness alternates between the two tenants by running_jobs/weight —
    // the light tenant should get a turn within roughly one or two job
    // durations, not after any meaningful fraction of the heavy tenant's 500.
    expect(waitMs).toBeLessThanOrEqual(JOB_DURATION_MS * 2 + IDLE_POLL_MS * 2)

    assertNoRunningJobsDrift()
  })

  it('a lone tenant with no competition uses every worker, draining as fast as the simulated pool allows', () => {
    const solo = createTestTenant('Solo')
    queue.enqueue(
      solo.tenantId,
      Array.from({ length: 20 }, (_, i) => ({
        kind: 'vision' as const,
        payload: { imageId: `s${i}`, sourceHash: `hs${i}`, storageKey: 'k' },
      }))
    )

    const history = simulate('vision', 4)
    expect(history).toHaveLength(20)
    expect(history.every(h => h.tenantId === solo.tenantId)).toBe(true)
    assertNoRunningJobsDrift()
  })

  it('interactive jobs are claimed before bulk ones, across the whole simulated run', () => {
    const t = createTestTenant('T')
    queue.enqueue(t.tenantId, [
      ...Array.from({ length: 10 }, (_, i) => ({
        kind: 'vision' as const,
        priorityClass: 'bulk' as const,
        payload: { imageId: `bulk-${i}`, sourceHash: `hb${i}`, storageKey: 'k' },
      })),
      { kind: 'vision', priorityClass: 'interactive', payload: { imageId: 'int-0', sourceHash: 'hi0', storageKey: 'k' } },
    ])

    const history = simulate('vision', 1)
    expect(history[0].priorityClass).toBe('interactive')
    expect(history[0].tenantId).toBe(t.tenantId)
    assertNoRunningJobsDrift()
  })

  it('bulk aging promotes a long-waiting job so it is no longer starved behind fresh bulk work', () => {
    const t = createTestTenant('T')
    queue.enqueue(t.tenantId, [
      { kind: 'vision', priorityClass: 'bulk', payload: { imageId: 'old', sourceHash: 'ho', storageKey: 'k' } },
    ])

    // Age it past a short threshold via the virtual clock, then promote.
    vi.setSystemTime(Date.now() + 10_000)
    const promoted = queue.promoteAgedBulkJobs(5)
    expect(promoted).toBe(1)

    // Fresh bulk work arrives from elsewhere afterward — the aged job
    // (now 'interactive') must still win.
    const other = createTestTenant('Other')
    queue.enqueue(other.tenantId, [
      { kind: 'vision', priorityClass: 'bulk', payload: { imageId: 'fresh', sourceHash: 'hf', storageKey: 'k' } },
    ])

    const job = queue.claim('vision', 'w1')!
    expect((job.payload as any).imageId).toBe('old')
    assertNoRunningJobsDrift()
  })

  it('weights are respected: a 3x-weighted tenant gets a visibly larger share while both are contending', () => {
    const heavy = createTestTenant('Heavy')
    const light = createTestTenant('Light')
    tenantQueueState.setWeight(heavy.tenantId, 3)
    tenantQueueState.setWeight(light.tenantId, 1)

    // Both backlogs are deliberately much larger than the measurement window
    // below — the whole point is to read the STEADY-STATE throughput ratio
    // while both tenants are still contending for workers, not the final
    // totals once one or both queues fully drain (at which point every job
    // gets claimed eventually regardless of weight, and a raw-count
    // comparison stops meaning anything).
    queue.enqueue(
      heavy.tenantId,
      Array.from({ length: 200 }, (_, i) => ({
        kind: 'vision' as const,
        payload: { imageId: `h${i}`, sourceHash: `hh${i}`, storageKey: 'k' },
      }))
    )
    queue.enqueue(
      light.tenantId,
      Array.from({ length: 200 }, (_, i) => ({
        kind: 'vision' as const,
        payload: { imageId: `l${i}`, sourceHash: `hl${i}`, storageKey: 'k' },
      }))
    )

    // 4 concurrent worker slots: with only 2, uniform job durations settle
    // into a stable 1-running-job-each oscillation regardless of weight
    // (both tenants' single slot frees at the same instant every cycle, so
    // running_jobs never exceeds 1 for either — there's nothing for a 3:1
    // weight to bias between). With 4, heavy (weight 3) can hold 3
    // concurrent running jobs against light's 1 before their running_jobs/
    // weight ratios re-tie — exactly where the 3:1 split should show up.
    const windowSize = 80
    const full = simulate('vision', 4, 40) // 40 discrete steps, each up to 4 concurrent claims
    expect(full.length).toBeGreaterThanOrEqual(windowSize) // neither queue should be exhausted yet
    const history = full.slice(0, windowSize)

    const heavyShare = history.filter(h => h.tenantId === heavy.tenantId).length
    const lightShare = history.filter(h => h.tenantId === light.tenantId).length

    // Roughly 3:1 — not exact (fair-share ordering, not a strict quota), but
    // heavy should clearly get the larger share.
    expect(heavyShare).toBeGreaterThan(lightShare * 1.5)
    assertNoRunningJobsDrift()
  })
})
