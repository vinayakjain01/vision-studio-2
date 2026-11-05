import { describe, it, expect } from 'vitest'
import { resolveBackgroundFillDependency } from '@/jobs/worker'

/**
 * Every one of three separate "Generate stuck at 0/N done" incidents
 * (2026-10-30, 2026-11-05 x2) traced back to the same root cause: once a
 * `background_fill` job a render depends on reached a TERMINAL state
 * (failed, or cancelled via an operator's `cancelAll()`), the render job's
 * dependency check found that same dead row forever — `findLatestByDedupeKey`
 * always returns the latest match for the dedupe key, and nothing ever
 * created a newer one. The render job just re-threw that dead row's stored
 * error (or, for a cancelled row with no error text, "unknown error") on
 * every single retry until it exhausted its own attempts and permanently
 * failed too — never calling `ensureBackgroundFillQueued` to give the
 * dependency a fresh try.
 *
 * `resolveBackgroundFillDependency` is the pure decision extracted from
 * `handleRenderJob` — it now treats a terminal dependency as "needs a fresh
 * attempt", not as a dead end, while preserving the original decisions for
 * an alive dependency and for no dependency ever having existed.
 */
describe('resolveBackgroundFillDependency', () => {
  it('requeues and waits for FREE when the dependency has failed — never a permanent dead end', () => {
    const decision = resolveBackgroundFillDependency(
      { status: 'failed', error: 'Cloudinary returned a server error (423): Processing continued in the background' },
      'tpl_abc',
      'abc123'
    )
    expect(decision.requeue).toBe(true)
    expect(decision.waitIsFree).toBe(true)
    expect(decision.message).toContain('423')
  })

  it('requeues and waits for FREE when the dependency was cancelled, even with no error text', () => {
    const decision = resolveBackgroundFillDependency({ status: 'cancelled', error: null }, 'tpl_abc', 'abc123')
    expect(decision.requeue).toBe(true)
    expect(decision.waitIsFree).toBe(true)
    // No "unknown error" dead-end message — this used to be the exact bug.
    expect(decision.message).not.toMatch(/unknown error/i)
  })

  it('does NOT requeue, and waits for FREE, when the dependency is alive (pending/claimed/running) — unchanged behaviour', () => {
    for (const status of ['pending', 'claimed', 'running'] as const) {
      const decision = resolveBackgroundFillDependency({ status, error: null }, 'tpl_abc', 'abc123')
      expect(decision.requeue).toBe(false)
      expect(decision.waitIsFree).toBe(true)
    }
  })

  it('requeues and charges an attempt when no dependency has ever existed — unchanged behaviour', () => {
    const decision = resolveBackgroundFillDependency(null, 'tpl_abc', 'abc123')
    expect(decision.requeue).toBe(true)
    expect(decision.waitIsFree).toBe(false)
  })

  it('does NOT requeue when the dependency already completed — the render should read the cache instead, not hit this path at all, but the decision itself must not misfire', () => {
    const decision = resolveBackgroundFillDependency({ status: 'completed', error: null }, 'tpl_abc', 'abc123')
    expect(decision.requeue).toBe(false)
  })
})
