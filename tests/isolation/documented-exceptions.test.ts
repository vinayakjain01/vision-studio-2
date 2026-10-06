import { describe, it, expect, beforeAll } from 'vitest'
import { createTestTenant, cookieHeader, type TestTenant } from '../helpers/tenancy-fixture'
import { seedResources, type SeededResources } from '../helpers/seed-resources'
import { makeRequest, makeParams } from '../helpers/request'
import { GET as downloadGetImpl } from '@/app/api/creatives/download/route'
import { POST as generatePostImpl } from '@/app/api/generate/route'

const downloadGet = downloadGetImpl as unknown as (...args: unknown[]) => Promise<Response>
const generatePost = generatePostImpl as unknown as (...args: unknown[]) => Promise<Response>

/**
 * Two routes read a resource ID from a QUERY STRING / request BODY as a
 * list-scoping filter rather than fetching one resource by ID — see
 * route-manifest.ts's `note` on both. They can't 404 the way the rest of
 * the matrix does (there's no single resource to find-or-404; it's a
 * WHERE clause that either matches rows in the caller's own tenant or
 * doesn't), but the actual isolation property — a wrong-tenant ID behaves
 * identically to a nonexistent one, and never returns another tenant's
 * data — still has to hold. This is that property, tested directly,
 * instead of being silently exempted from the suite.
 */
describe('documented exceptions: query/scope-filtered routes', () => {
  let tenantA: TestTenant
  let tenantB: TestTenant
  let resourcesA: SeededResources

  beforeAll(async () => {
    tenantA = createTestTenant('Tenant A')
    tenantB = createTestTenant('Tenant B')
    resourcesA = await seedResources(tenantA)
  })

  describe('/api/creatives/download', () => {
    it("tenant B's request scoped to tenant A's real batchId gets the same response as a nonexistent batchId", async () => {
      const asOtherTenant = await downloadGet(
        makeRequest(`http://localhost:3000/api/creatives/download?batchId=${resourcesA.batchId}`, {
          cookie: cookieHeader(tenantB.sessionToken),
        }),
        makeParams({})
      )
      const asNonexistent = await downloadGet(
        makeRequest('http://localhost:3000/api/creatives/download?batchId=nonexistent_000', {
          cookie: cookieHeader(tenantB.sessionToken),
        }),
        makeParams({})
      )

      expect(asOtherTenant.status).toBe(asNonexistent.status)
      const [bodyA, bodyB] = await Promise.all([asOtherTenant.json(), asNonexistent.json()])
      expect(bodyA).toEqual(bodyB)
      // Specifically not a ZIP — confirms no creative bytes were ever assembled.
      expect(asOtherTenant.headers.get('content-type')).not.toMatch(/zip/)
    })

    it('tenant A can still download its own batch', async () => {
      const res = await downloadGet(
        makeRequest(`http://localhost:3000/api/creatives/download?batchId=${resourcesA.batchId}`, {
          cookie: cookieHeader(tenantA.sessionToken),
        }),
        makeParams({})
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toMatch(/zip/)
    })

    it('unauthenticated request is rejected (401)', async () => {
      const res = await downloadGet(
        makeRequest(`http://localhost:3000/api/creatives/download?batchId=${resourcesA.batchId}`),
        makeParams({})
      )
      expect(res.status).toBe(401)
    })
  })

  describe('/api/generate dryRun', () => {
    it("a plan scoped to tenant A's real productId matches zero products under tenant B", async () => {
      const res = await generatePost(
        makeRequest('http://localhost:3000/api/generate', {
          method: 'POST',
          cookie: cookieHeader(tenantB.sessionToken),
          json: { dryRun: true, productIds: [resourcesA.productId] },
        }),
        makeParams({})
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.plan.total).toBe(0)
      expect(body.plan.items).toEqual([])
    })

    it('unauthenticated request is rejected (401)', async () => {
      const res = await generatePost(
        makeRequest('http://localhost:3000/api/generate', {
          method: 'POST',
          json: { dryRun: true, productIds: [resourcesA.productId] },
        }),
        makeParams({})
      )
      expect(res.status).toBe(401)
    })
  })
})
