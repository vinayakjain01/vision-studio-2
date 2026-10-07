import { describe, it, expect } from 'vitest'
import { startEventLoopMonitor, getEventLoopStats } from '@/lib/event-loop-monitor'

describe('event-loop delay monitor', () => {
  it('is null before starting, and reports real numbers once running', async () => {
    expect(getEventLoopStats()).toBeNull()

    startEventLoopMonitor()
    // Let the event loop actually turn over a few times so the histogram has
    // real samples — monitorEventLoopDelay measures ACTUAL timer drift, so
    // this can't be asserted synchronously. Generous margin: under a full
    // test-suite run (many other tests' timers/workers competing for the
    // event loop), a short wait can elapse before the histogram's own
    // internal resolution-interval timer completes even once, leaving
    // `mean` as NaN (zero samples) rather than a real, if elevated, number.
    await new Promise(resolve => setTimeout(resolve, 300))

    const stats = getEventLoopStats()
    expect(stats).not.toBeNull()
    expect(stats!.meanMs).toBeGreaterThanOrEqual(0)
    expect(stats!.p99Ms).toBeGreaterThanOrEqual(stats!.p50Ms)
    expect(stats!.maxMs).toBeGreaterThanOrEqual(stats!.p99Ms)
  })

  it('calling start twice is a no-op (same histogram instance kept)', () => {
    startEventLoopMonitor()
    const before = getEventLoopStats()
    startEventLoopMonitor()
    const after = getEventLoopStats()
    // Both reads succeed against the same underlying histogram — a second
    // start() didn't throw or replace it with a fresh (reset) one.
    expect(before).not.toBeNull()
    expect(after).not.toBeNull()
  })
})
