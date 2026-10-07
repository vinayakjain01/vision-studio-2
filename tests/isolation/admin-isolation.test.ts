import path from 'path'
import { describe, it, expect, beforeAll } from 'vitest'
import { makeRequest } from '../helpers/request'
import { createTestTenant, cookieHeader } from '../helpers/tenancy-fixture'
import { loadRouteModule } from './load-route'
import { listApiRoutes } from './route-inventory'
import { users } from '@/db/control-repositories'
import { createSession } from '@/auth/session'

/**
 * P5 §1: "/admin and /api/admin/* are platform_admin only... Non-admins and
 * anonymous users get 404/401 with no hint the page exists."
 *
 * Driven by filesystem discovery (same pattern as unauthenticated.test.ts),
 * filtered to `/api/admin/*` — so a new admin route added later is
 * automatically covered without anyone remembering to add it here. Three
 * identities probe every admin route/method:
 *   - a regular (non-admin) authenticated tenant user   -> 404
 *   - a forged/garbage session token                     -> 401
 *   - a genuine platform admin (positive control)         -> neither 404 nor 401
 *
 * `unauthenticated.test.ts` already covers the plain "no cookie at all"
 * case for every non-public route, admin included — not repeated here.
 */
describe('admin routes: tenant users and forged sessions cannot reach any of them', () => {
  const projectRoot = path.resolve(__dirname, '../..')
  const adminRoutes = listApiRoutes(projectRoot).filter(r => r.routePath.startsWith('/api/admin/'))

  it('found at least the admin routes known when this suite was written', () => {
    expect(adminRoutes.length).toBeGreaterThanOrEqual(5)
  })

  let regularUserCookie: string
  let adminCookie: string

  beforeAll(async () => {
    const tenant = createTestTenant('AdminIsolationRegular')
    regularUserCookie = cookieHeader(tenant.sessionToken)

    // A platform admin with NO personal tenant at all — the case
    // `ResolvedSession`'s doc comment calls out explicitly, and exactly why
    // admin routes cannot be built on `handler()` (which requires a tenant).
    const admin = users.create({ email: 'admin-isolation@test.local', passwordHash: 'unused', isPlatformAdmin: true })
    const { token } = createSession(admin.id)
    adminCookie = cookieHeader(token)
  })

  function dummyParams(filePath: string): Record<string, string | string[]> {
    const segments = filePath.split('/')
    const params: Record<string, string | string[]> = {}
    for (const seg of segments) {
      const catchAll = seg.match(/^\[\.\.\.(\w+)\]$/)
      const dynamic = seg.match(/^\[(\w+)\]$/)
      if (catchAll) params[catchAll[1]] = ['dummy']
      else if (dynamic) params[dynamic[1]] = 'dummy'
    }
    return params
  }

  for (const route of adminRoutes) {
    for (const method of route.methods) {
      const title = `${method} ${route.routePath}`

      it(`${title} — a non-admin tenant user gets 404`, async () => {
        const mod = await loadRouteModule(route.filePath)
        const fn = mod[method] as (...args: unknown[]) => Promise<Response>
        const request = makeRequest('http://localhost:3000/api/test', { method, cookie: regularUserCookie })
        const res = await fn(request, { params: Promise.resolve(dummyParams(route.filePath)) })
        expect(res.status).toBe(404)
      })

      it(`${title} — a forged/garbage session token gets 401`, async () => {
        const mod = await loadRouteModule(route.filePath)
        const fn = mod[method] as (...args: unknown[]) => Promise<Response>
        const request = makeRequest('http://localhost:3000/api/test', {
          method,
          cookie: cookieHeader('this-is-not-a-real-session-token'),
        })
        const res = await fn(request, { params: Promise.resolve(dummyParams(route.filePath)) })
        expect(res.status).toBe(401)
      })

      it(`${title} — a genuine platform admin is not rejected as not-found or unauthorized`, async () => {
        const mod = await loadRouteModule(route.filePath)
        const fn = mod[method] as (...args: unknown[]) => Promise<Response>
        const request = makeRequest('http://localhost:3000/api/test', { method, cookie: adminCookie })
        const res = await fn(request, { params: Promise.resolve(dummyParams(route.filePath)) })
        expect(res.status).not.toBe(404)
        expect(res.status).not.toBe(401)
      })
    }
  }
})
