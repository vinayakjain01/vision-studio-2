import { describe, it, expect, beforeAll } from 'vitest'
import { createTestTenant, cookieHeader, type TestTenant } from '../helpers/tenancy-fixture'
import { seedResources, type SeededResources } from '../helpers/seed-resources'
import { makeRequest, makeParams } from '../helpers/request'
import { __onTenantDbOpen } from '@/db/client'
import { GET as productsGetImpl } from '@/app/api/products/route'
import { GET as productGetImpl } from '@/app/api/products/[productId]/route'

// The `/api/products` GET handler declares no parameters (it ignores the
// request), so TypeScript infers its wrapped type as a 0-arg function —
// technically correct for what it reads, but Next.js always calls every
// route export the same way (request, context), so these casts just widen
// back to that real calling convention for this file's purposes.
const productsGet = productsGetImpl as unknown as (...args: unknown[]) => Promise<Response>
const productGet = productGetImpl as unknown as (...args: unknown[]) => Promise<Response>

/**
 * The rest of this suite proves isolation by observing HTTP responses —
 * this test instruments the actual DB-open call site
 * (`openTenantDbById`, see the `__onTenantDbOpen` hook added for this) and
 * proves, structurally, that handling tenant B's request never opens tenant
 * A's `app.db` file at all, rather than opening it and merely filtering
 * results correctly. A response-only test could theoretically still pass if
 * a future change opened every tenant's handle "just in case" and relied on
 * the WHERE clause alone — this closes that gap.
 */
describe('tenant DB handle isolation (instrumented)', () => {
  let tenantA: TestTenant
  let tenantB: TestTenant
  let resourcesA: SeededResources

  beforeAll(async () => {
    tenantA = createTestTenant('Tenant A')
    tenantB = createTestTenant('Tenant B')
    resourcesA = await seedResources(tenantA)
  })

  it("servicing tenant B's list request never opens tenant A's DB handle", async () => {
    const opened: string[] = []
    const unsubscribe = __onTenantDbOpen(id => opened.push(id))
    try {
      const request = makeRequest('http://localhost:3000/api/products', {
        cookie: cookieHeader(tenantB.sessionToken),
      })
      await productsGet(request, makeParams({}))
    } finally {
      unsubscribe()
    }

    expect(opened.length).toBeGreaterThan(0)
    expect(opened.every(id => id === tenantB.tenantId)).toBe(true)
    expect(opened).not.toContain(tenantA.tenantId)
  })

  it("servicing tenant B's request for tenant A's real product id never opens tenant A's DB handle", async () => {
    const opened: string[] = []
    const unsubscribe = __onTenantDbOpen(id => opened.push(id))
    try {
      const request = makeRequest('http://localhost:3000/api/products/x', {
        cookie: cookieHeader(tenantB.sessionToken),
      })
      const res = await productGet(request, makeParams({ productId: resourcesA.productId }))
      expect(res.status).toBe(404)
    } finally {
      unsubscribe()
    }

    expect(opened.every(id => id === tenantB.tenantId)).toBe(true)
    expect(opened).not.toContain(tenantA.tenantId)
  })

  it("servicing tenant A's own request opens only tenant A's DB handle", async () => {
    const opened: string[] = []
    const unsubscribe = __onTenantDbOpen(id => opened.push(id))
    try {
      const request = makeRequest('http://localhost:3000/api/products/x', {
        cookie: cookieHeader(tenantA.sessionToken),
      })
      const res = await productGet(request, makeParams({ productId: resourcesA.productId }))
      expect(res.status).toBe(200)
    } finally {
      unsubscribe()
    }

    expect(opened.length).toBeGreaterThan(0)
    expect(opened.every(id => id === tenantA.tenantId)).toBe(true)
  })
})
