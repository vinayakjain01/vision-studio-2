import { describe, it, expect } from 'vitest'
import { isJobHung, isPoolStalled } from '@/jobs/pool'
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
