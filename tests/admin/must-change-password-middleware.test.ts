import { describe, it, expect } from 'vitest'
import { createTestTenant, cookieHeader } from '../helpers/tenancy-fixture'
import { makeRequest } from '../helpers/request'
import { users } from '@/db/control-repositories'
import { middleware } from '@/middleware'

/**
 * P5: an admin-created account or an admin password reset sets
 * `must_change_password`. The login response's flag alone isn't trusted to
 * be acted on client-side — middleware itself confines the session to the
 * change-password flow (see middleware.ts's `ALLOWED_WHILE_MUST_CHANGE_PASSWORD`)
 * until it's cleared.
 */
describe('middleware: mustChangePassword confines the session to the change-password flow', () => {
  it('redirects a page request elsewhere to /settings', () => {
    const tenant = createTestTenant('MustChangePwPage')
    users.setPasswordHash(tenant.userId, 'unused-hash', true)

    const request = makeRequest('http://localhost:3000/products', { cookie: cookieHeader(tenant.sessionToken) })
    const res = middleware(request)
    expect(res.status).toBe(307) // NextResponse.redirect default
    expect(res.headers.get('location')).toContain('/settings')
  })

  it('returns 403 for an API request elsewhere', () => {
    const tenant = createTestTenant('MustChangePwApi')
    users.setPasswordHash(tenant.userId, 'unused-hash', true)

    const request = makeRequest('http://localhost:3000/api/products', { cookie: cookieHeader(tenant.sessionToken) })
    const res = middleware(request)
    expect(res.status).toBe(403)
  })

  it('allows /settings and /api/auth/change-password through unchanged', () => {
    const tenant = createTestTenant('MustChangePwAllowed')
    users.setPasswordHash(tenant.userId, 'unused-hash', true)

    const settingsReq = makeRequest('http://localhost:3000/settings', { cookie: cookieHeader(tenant.sessionToken) })
    expect(middleware(settingsReq).status).not.toBe(403)

    const changePwReq = makeRequest('http://localhost:3000/api/auth/change-password', {
      method: 'POST',
      cookie: cookieHeader(tenant.sessionToken),
    })
    const res = middleware(changePwReq)
    expect(res.status).not.toBe(403)
    expect(res.status).not.toBe(307)
  })

  it('a normal (no forced change) session is never redirected by this rule', () => {
    const tenant = createTestTenant('NormalSession')
    const request = makeRequest('http://localhost:3000/products', { cookie: cookieHeader(tenant.sessionToken) })
    const res = middleware(request)
    expect(res.status).not.toBe(403)
    expect(res.status).not.toBe(307)
  })
})
