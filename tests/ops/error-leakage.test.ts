import { describe, it, expect, afterEach } from 'vitest'
import { mapKnownError } from '@/lib/api-handler'

describe('mapKnownError() — production error leakage (P6 security pass)', () => {
  const originalEnv = process.env.NODE_ENV

  afterEach(() => {
    ;(process.env as any).NODE_ENV = originalEnv
  })

  it('never leaks a raw error message (e.g. an absolute file path from ENOENT) to the client in production', async () => {
    ;(process.env as any).NODE_ENV = 'production'
    const err = new Error("ENOENT: no such file or directory, open 'C:\\Projects\\Vision Studio\\data\\tenants\\secret-tenant\\app.db'")

    const res = mapKnownError(err)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('internal server error')
    expect(body.error).not.toContain('Vision Studio')
    expect(body.error).not.toContain('.db')
  })

  it('still returns the real message in development, for local debugging', async () => {
    ;(process.env as any).NODE_ENV = 'development'
    const err = new Error('some specific internal failure')

    const res = mapKnownError(err)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('some specific internal failure')
  })

  it('structured known errors (quota, capacity, disk) keep their specific message even in production', async () => {
    ;(process.env as any).NODE_ENV = 'production'
    const { QuotaExceededError } = await import('@/jobs/quota')
    const err = new QuotaExceededError('too many uploads in flight', 'max_concurrent_uploads', 3, 3)

    const res = mapKnownError(err)
    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.error).toBe('too many uploads in flight')
    expect(body.code).toBe('max_concurrent_uploads')
  })
})
