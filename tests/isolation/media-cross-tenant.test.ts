import { describe, it, expect, beforeAll } from 'vitest'
import { createTestTenant, cookieHeader, type TestTenant } from '../helpers/tenancy-fixture'
import { seedResources, type SeededResources } from '../helpers/seed-resources'
import { makeRequest, makeParams } from '../helpers/request'
import { GET as mediaGet } from '@/app/api/media/[root]/[...key]/route'

describe('media route: cross-tenant access and path traversal', () => {
  let tenantA: TestTenant
  let tenantB: TestTenant
  let resourcesA: SeededResources

  beforeAll(async () => {
    tenantA = createTestTenant('Tenant A')
    tenantB = createTestTenant('Tenant B')
    resourcesA = await seedResources(tenantA)
  })

  async function get(cookie: string | undefined, root: string, key: string[]) {
    const request = makeRequest('http://localhost:3000/api/media/x', { cookie })
    return mediaGet(request, makeParams({ root, key }))
  }

  it("tenant A can read its own original", async () => {
    const res = await get(cookieHeader(tenantA.sessionToken), 'originals', resourcesA.storageKey.split('/'))
    expect(res.status).toBe(200)
  })

  it("tenant B gets 404 for tenant A's real storage key (never 403) — separate media roots, not an ACL check", async () => {
    const res = await get(cookieHeader(tenantB.sessionToken), 'originals', resourcesA.storageKey.split('/'))
    expect(res.status).toBe(404)
    expect(res.status).not.toBe(403)
  })

  it('unauthenticated request is rejected before any file access (401)', async () => {
    const res = await get(undefined, 'originals', resourcesA.storageKey.split('/'))
    expect(res.status).toBe(401)
  })

  it('rejects a key with a literal `..` traversal segment — as a 404, not a distinguishable 400', async () => {
    // `statMedia()` (media-store.ts) catches `resolvePath`'s "unsafe key"
    // throw the same way it catches a plain ENOENT, so a traversal attempt
    // is 404 here, same as a key that's simply missing — not the 400 a
    // naive implementation might return. That's stricter than the baseline
    // "don't allow traversal" requirement: it also means a traversal probe
    // can't be distinguished from a normal miss by its response.
    const res = await get(cookieHeader(tenantA.sessionToken), 'originals', ['..', '..', '..', 'etc', 'passwd'])
    expect(res.status).toBe(404)
  })

  it('rejects an absolute-path-looking key', async () => {
    const res = await get(cookieHeader(tenantA.sessionToken), 'originals', ['', 'etc', 'passwd'])
    expect([400, 404]).toContain(res.status)
  })

  it('rejects an unknown media root', async () => {
    const res = await get(cookieHeader(tenantA.sessionToken), '..', ['x'])
    expect(res.status).toBe(400)
  })

  it('a key that is syntactically safe but does not exist is a plain 404', async () => {
    const res = await get(cookieHeader(tenantA.sessionToken), 'originals', ['zz', 'zz', 'nonexistent.jpg'])
    expect(res.status).toBe(404)
  })
})
