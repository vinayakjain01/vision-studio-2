import '../helpers/tenant-env'

import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { makeRequest } from '../helpers/request'
import { clientIp } from '@/auth/client-ip'
import { config } from '@/config'
import { getControlDb } from '@/db/client'
import { migrateControl } from '@/db/migrate'
import { users } from '@/db/control-repositories'
import { hashPassword } from '@/auth/password'
import { POST as loginPost } from '@/app/api/auth/login/route'

const login = loginPost as unknown as (...args: unknown[]) => Promise<Response>

beforeAll(() => {
  migrateControl(getControlDb())
})

describe('clientIp() — X-Forwarded-For trust behavior (P6 security pass)', () => {
  const original = config.auth.trustProxy

  afterEach(() => {
    ;(config.auth as any).trustProxy = original
  })

  it('ignores X-Forwarded-For entirely when TRUST_PROXY is off, so a client cannot pick its own rate-limit bucket', () => {
    ;(config.auth as any).trustProxy = false
    const req = makeRequest('http://localhost:3000/api/auth/login', {
      headers: { 'x-forwarded-for': '1.2.3.4' },
    })
    expect(clientIp(req)).toBe('unknown')
  })

  it('trusts only the LAST hop when TRUST_PROXY is on — the one the trusted reverse proxy itself appended', () => {
    ;(config.auth as any).trustProxy = true
    // A spoofed first entry followed by what the trusted proxy actually observed.
    const req = makeRequest('http://localhost:3000/api/auth/login', {
      headers: { 'x-forwarded-for': '9.9.9.9 (attacker-claimed), 203.0.113.7' },
    })
    expect(clientIp(req)).toBe('203.0.113.7')
  })

  it('falls back to "unknown" when TRUST_PROXY is on but the header is absent', () => {
    ;(config.auth as any).trustProxy = true
    const req = makeRequest('http://localhost:3000/api/auth/login')
    expect(clientIp(req)).toBe('unknown')
  })
})

describe('POST /api/auth/login — per-IP rate limiting behind TRUST_PROXY (P6 security pass)', () => {
  const originalTrustProxy = config.auth.trustProxy

  afterEach(() => {
    ;(config.auth as any).trustProxy = originalTrustProxy
  })

  it('rate-limits repeated failures from the same real IP (via X-Forwarded-For) once TRUST_PROXY is on', async () => {
    ;(config.auth as any).trustProxy = true
    // Per-IP cap (4x the per-account cap) must bind BEFORE the per-account
    // one does, so a fresh, never-before-seen email every attempt keeps the
    // (much tighter) per-account bucket from being what actually trips.
    const passwordHash = await hashPassword('CorrectHorse1')
    const attempt = (i: number) => {
      users.create({ email: `ratelimit-target-${i}@test.local`, passwordHash })
      return login(
        makeRequest('http://localhost:3000/api/auth/login', {
          method: 'POST',
          headers: { 'x-forwarded-for': '198.51.100.23' },
          json: { email: `ratelimit-target-${i}@test.local`, password: 'wrong-password' },
        })
      )
    }

    const ipCap = config.auth.loginMaxAttempts * 4
    let last: Response | undefined
    for (let i = 0; i < ipCap; i++) {
      last = await attempt(i)
      expect(last.status).toBe(401)
    }

    last = await attempt(ipCap)
    expect(last.status).toBe(429)
  }, 45_000) // real argon2 verification per attempt — ~40 of them, each ~0.5s

  it('a different claimed IP in an UNTRUSTED X-Forwarded-For header does not evade the shared "unknown" bucket', async () => {
    ;(config.auth as any).trustProxy = false
    const passwordHash = await hashPassword('CorrectHorse1')
    const attemptAs = (i: number, fakeIp: string) => {
      users.create({ email: `ratelimit-spoof-${i}@test.local`, passwordHash })
      return login(
        makeRequest('http://localhost:3000/api/auth/login', {
          method: 'POST',
          headers: { 'x-forwarded-for': fakeIp },
          json: { email: `ratelimit-spoof-${i}@test.local`, password: 'wrong-password' },
        })
      )
    }

    const ipCap = config.auth.loginMaxAttempts * 4
    for (let i = 0; i < ipCap; i++) {
      const res = await attemptAs(i, `10.0.0.${i}`) // a different claimed IP every time, different account every time
      expect(res.status).toBe(401)
    }

    // All of the above landed in the one shared "unknown" bucket regardless
    // of the claimed header value or account — one more failure from ANY
    // claimed IP must now be rate-limited too.
    const res = await attemptAs(ipCap, '10.0.0.999')
    expect(res.status).toBe(429)
  }, 45_000) // real argon2 verification per attempt — ~40 of them, each ~0.5s
})
