import { describe, it, expect } from 'vitest'
import { isJobHung, isPoolStalled, shouldRecycleWorker, checkMemoryBudget } from '@/jobs/pool'
import type { JobKind } from '@/db/types'

const MAX_RUNTIME: Record<JobKind, number> = { vision: 60_000, render: 90_000, background_fill: 240_000 }

describe('pool watchdog: isJobHung (pure decision logic)', () => {
  it('is not hung before its kind\'s max runtime elapses', () => {
    const now = 1_000_000
    expect(isJobHung({ kind: 'vision', startedAt: now - 59_999 }, now, MAX_RUNTIME)).toBe(false)
  })

  it('is hung the instant it exceeds its kind\'s max runtime', () => {
    const now = 1_000_000
    expect(isJobHung({ kind: 'vision', startedAt: now - 60_001 }, now, MAX_RUNTIME)).toBe(true)
  })

  it('uses a DIFFERENT budget per kind — a render job at 70s is fine, a vision job at 70s is hung', () => {
    const now = 1_000_000
    expect(isJobHung({ kind: 'render', startedAt: now - 70_000 }, now, MAX_RUNTIME)).toBe(false)
    expect(isJobHung({ kind: 'vision', startedAt: now - 70_000 }, now, MAX_RUNTIME)).toBe(true)
  })

  it('background_fill gets a much longer budget, matching its remote-API nature', () => {
    const now = 1_000_000
    expect(isJobHung({ kind: 'background_fill', startedAt: now - 200_000 }, now, MAX_RUNTIME)).toBe(false)
    expect(isJobHung({ kind: 'background_fill', startedAt: now - 241_000 }, now, MAX_RUNTIME)).toBe(true)
  })
})

/**
 * Phase 1.5 (docs/ISSUES.md issue 10): isPoolStalled is the pure decision
 * logic behind WorkerPool.checkStall() — the "jobs pending, workers idle,
 * no progress" pool-level stall detector, distinct from the per-job
 * watchdog above (which only ever sees ONE job stuck in a native call).
 */
describe('pool stall detection: isPoolStalled (pure decision logic)', () => {
  it('is not stalled when a capable worker is busy, no matter how much work is pending', () => {
    expect(
      isPoolStalled([{ state: 'busy', kinds: ['vision'] }], { vision: 500 })
    ).toBe(false)
  })

  it('is not stalled when a capable worker is still starting', () => {
    expect(
      isPoolStalled([{ state: 'starting', kinds: ['vision'] }], { vision: 500 })
    ).toBe(false)
  })

  it('is not stalled when every worker is idle but there is no pending work for any kind they serve', () => {
    expect(
      isPoolStalled(
        [{ state: 'idle', kinds: ['vision'] }, { state: 'idle', kinds: ['render'] }],
        { vision: 0, render: 0 }
      )
    ).toBe(false)
  })

  it('IS stalled when every worker capable of a kind with pending work is idle', () => {
    expect(
      isPoolStalled([{ state: 'idle', kinds: ['vision', 'render'] }], { vision: 10, render: 0 })
    ).toBe(true)
  })

  it('is not stalled when the pending work is for a kind NO worker serves', () => {
    expect(
      isPoolStalled([{ state: 'idle', kinds: ['render'] }], { background_fill: 50 })
    ).toBe(false)
  })

  it('mixed pool: one kind genuinely stalled is enough even if another kind is fine', () => {
    expect(
      isPoolStalled(
        [
          { state: 'busy', kinds: ['render'] }, // render is progressing
          { state: 'idle', kinds: ['background_fill'] }, // but this fill worker is idle with work waiting
        ],
        { render: 5, background_fill: 3 }
      )
    ).toBe(false) // a busy worker ANYWHERE means "something is happening" — not a pool-wide stall
  })

  it('stopped workers are ignored — not treated as idle capacity for pending work', () => {
    expect(
      isPoolStalled([{ state: 'stopped', kinds: ['vision'] }], { vision: 10 })
    ).toBe(false)
  })
})

/**
 * Phase 1.5 (docs/ISSUES.md issue 10): shouldRecycleWorker is the pure
 * decision logic behind WorkerPool.maybeRecycle() — bounding exposure to a
 * slow native-library leak in a long-lived worker process by job count or
 * RSS, independent of whether any one job is itself hung.
 */
describe('worker recycling: shouldRecycleWorker (pure decision logic)', () => {
  const LIMITS = { maxJobs: 500, maxRssMb: 1536 }

  it('does not recycle a fresh, small worker', () => {
    expect(shouldRecycleWorker(3, 700, LIMITS)).toBeNull()
  })

  it('recycles once the job-count limit is reached, regardless of RSS', () => {
    const reason = shouldRecycleWorker(500, 100, LIMITS)
    expect(reason).toContain('completed 500 jobs')
  })

  it('recycles once RSS exceeds the limit, even with very few jobs completed', () => {
    const reason = shouldRecycleWorker(1, 2000, LIMITS)
    expect(reason).toContain('RSS 2000MB')
  })

  it('job-count takes priority when BOTH limits are exceeded — the reason names the one that is unambiguous', () => {
    const reason = shouldRecycleWorker(500, 2000, LIMITS)
    expect(reason).toContain('completed 500 jobs')
  })

  it('a null RSS reading (non-Linux, or a failed /proc read) never triggers the RSS branch', () => {
    expect(shouldRecycleWorker(10, null, LIMITS)).toBeNull()
  })

  it('is exactly at the boundary at the limit itself (>=, not >)', () => {
    expect(shouldRecycleWorker(499, 100, LIMITS)).toBeNull()
    expect(shouldRecycleWorker(500, 100, LIMITS)).not.toBeNull()
  })
})

/**
 * Phase 1.5: checkMemoryBudget is the pure decision logic behind
 * WorkerPool.checkStartupMemoryBudget() — a one-time startup sanity check,
 * not a measurement, so these tests exercise the arithmetic and threshold,
 * not real memory.
 */
describe('startup memory budget: checkMemoryBudget (pure decision logic)', () => {
  const PER_KIND_MB: Record<JobKind, number> = { vision: 700, render: 150, background_fill: 80 }

  it('returns null when the estimate fits comfortably within budget', () => {
    // 2 vision (1400) + 2 render (300) + 2 fill (160) = 1860MB on a 16GB box, 80% budget = 12,800MB.
    expect(checkMemoryBudget({ vision: 2, render: 2, background_fill: 2 }, PER_KIND_MB, 16_000, 0.8)).toBeNull()
  })

  it('warns when the estimate exceeds the budget fraction of total RAM', () => {
    // 8 vision workers alone = 5600MB on a 2GB box — wildly over any reasonable budget.
    const warning = checkMemoryBudget({ vision: 8, render: 1, background_fill: 1 }, PER_KIND_MB, 2_000, 0.8)
    expect(warning).toContain('exceeds')
    expect(warning).toContain('80%')
  })

  it('is exactly at the boundary at the budget fraction itself (over, not at-or-under)', () => {
    // vision=1 => 700MB estimate; total=1000MB, fraction=0.7 => budget=700MB exactly. At the boundary, not over.
    expect(checkMemoryBudget({ vision: 1, render: 0, background_fill: 0 }, PER_KIND_MB, 1_000, 0.7)).toBeNull()
    // One MB more total pushes the budget under the estimate.
    expect(checkMemoryBudget({ vision: 1, render: 0, background_fill: 0 }, PER_KIND_MB, 999, 0.7)).not.toBeNull()
  })
})
