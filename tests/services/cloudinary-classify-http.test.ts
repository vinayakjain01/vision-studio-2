import { describe, it, expect } from 'vitest'
import { classifyHttp } from '@/services/cloudinary-service'

/**
 * Reported 2026-11-05: Cloudinary's new account started returning 423
 * ("Processing continued in the background") for a real, non-trivial share
 * of generative-fill calls — Cloudinary's own way of saying the operation is
 * still being computed asynchronously, not that it was rejected. Before this
 * fix, classifyHttp had no case for 423 and it fell through to the generic
 * `'rejected'` bucket, which RETRYABLE_KINDS (ai-extend-dispatcher.ts)
 * treats as permanent — never retried, even once, within a job attempt.
 * 140 real background_fill jobs died this way in production, each burning
 * through all 3 attempts in under a few seconds, and every render job
 * depending on one of them inherited that dead job's stale error forever
 * (worker.ts's dependency-chain surfacing, which never re-queues a
 * terminally failed dependency).
 */
describe('classifyHttp — 423 (Cloudinary still processing asynchronously)', () => {
  it('classifies 423 as a retryable server_error, not a permanent rejection', () => {
    const result = classifyHttp(423, 'Processing continued in the background')
    expect(result.kind).toBe('server_error')
  })

  it('still classifies other 4xx statuses the same as before (no regression)', () => {
    expect(classifyHttp(401, 'bad key').kind).toBe('auth')
    expect(classifyHttp(403, 'forbidden').kind).toBe('auth')
    expect(classifyHttp(429, 'slow down').kind).toBe('rate_limited')
    expect(classifyHttp(400, 'bad request').kind).toBe('rejected')
  })
})
