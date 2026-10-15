import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import { callAndLogIfSlow } from '@/lib/api-handler'

/**
 * Phase 1.5 (docs/ISSUES.md issue 10): callAndLogIfSlow is the shared timing
 * wrapper handler()/adminHandler() use around every route's actual work —
 * these tests mock performance.now() directly (this repo's existing
 * convention for timing-sensitive tests avoids vi.useFakeTimers(), see
 * tests/jobs/ai-extend-dispatcher.test.ts's own comment on why) rather than
 * waiting out a real 2s+ delay, and rely on the real default threshold
 * (2000ms, config.observability.slowRequestThresholdMs) being stable since
 * no test here sets API_SLOW_REQUEST_MS.
 */
describe('callAndLogIfSlow', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let nowSpy: ReturnType<typeof vi.spyOn> | undefined

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    nowSpy?.mockRestore()
  })

  /** First performance.now() call (the start) returns 0; every call after returns `ms`. */
  function mockDurationMs(ms: number) {
    let calls = 0
    nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => {
      calls++
      return calls === 1 ? 0 : ms
    })
  }

  function fakeRequest(method: string, pathname: string): any {
    return { method, nextUrl: { pathname } }
  }

  it('does not log a request well under the threshold', async () => {
    mockDurationMs(500)
    const res = await callAndLogIfSlow(fakeRequest('GET', '/api/products'), undefined, () =>
      NextResponse.json({ ok: true })
    )
    expect(res.status).toBe(200)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('logs a [slow-request] line with method/path/status/ms/tenantId when over the threshold', async () => {
    mockDurationMs(2500)
    await callAndLogIfSlow(fakeRequest('POST', '/api/generate'), 'tnt_abc123', () =>
      NextResponse.json({ ok: true }, { status: 201 })
    )
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const line = warnSpy.mock.calls[0].join(' ')
    expect(line).toContain('[slow-request]')
    expect(line).toContain('method=POST')
    expect(line).toContain('path=/api/generate')
    expect(line).toContain('status=201')
    expect(line).toContain('ms=2500')
    expect(line).toContain('tenantId=tnt_abc123')
  })

  it('omits tenantId from the line when none is given (public/unauthenticated routes)', async () => {
    mockDurationMs(2500)
    await callAndLogIfSlow(fakeRequest('GET', '/api/health'), undefined, () => NextResponse.json({ ok: true }))
    expect(warnSpy.mock.calls[0].join(' ')).not.toContain('tenantId=')
  })

  it('still logs, with status=error, when the wrapped handler throws — and the throw still propagates', async () => {
    mockDurationMs(3000)
    await expect(
      callAndLogIfSlow(fakeRequest('GET', '/api/boom'), undefined, () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0].join(' ')).toContain('status=error')
  })

  it('is exactly at the boundary at the threshold itself (>=, not >)', async () => {
    mockDurationMs(1999)
    await callAndLogIfSlow(fakeRequest('GET', '/api/x'), undefined, () => NextResponse.json({ ok: true }))
    expect(warnSpy).not.toHaveBeenCalled()

    mockDurationMs(2000)
    await callAndLogIfSlow(fakeRequest('GET', '/api/x'), undefined, () => NextResponse.json({ ok: true }))
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })
})
