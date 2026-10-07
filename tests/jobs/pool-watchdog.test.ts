import { describe, it, expect } from 'vitest'
import { isJobHung } from '@/jobs/pool'
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
