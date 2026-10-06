import path from 'path'
import { describe, it, expect, beforeAll } from 'vitest'
import { createTestTenant, cookieHeader, type TestTenant } from '../helpers/tenancy-fixture'
import { seedResources, type SeededResources } from '../helpers/seed-resources'
import { makeRequest, makeParams } from '../helpers/request'
import { loadRouteModule } from './load-route'
import { listApiRoutes } from './route-inventory'
import { ROUTE_MANIFEST } from './route-manifest'

/**
 * For every GET route the manifest marks as returning a tenant-scoped
 * collection, proves tenant B's list contains none of tenant A's seeded
 * resource IDs. The per-ID 404 checks in `cross-tenant.test.ts` prove a
 * DIRECT lookup by ID is safe; this proves the LIST endpoints don't simply
 * enumerate everyone's rows and filter client-side (or forget to filter at
 * all), which a single-ID test can't catch.
 */
describe('tenant-scoped list endpoints never include another tenant\'s rows', () => {
  const projectRoot = path.resolve(__dirname, '../..')
  const routesByPath = new Map(listApiRoutes(projectRoot).map(r => [r.routePath, r]))

  let tenantA: TestTenant
  let tenantB: TestTenant
  let resourcesA: SeededResources
  let resourcesB: SeededResources

  beforeAll(async () => {
    tenantA = createTestTenant('Tenant A')
    tenantB = createTestTenant('Tenant B')
    resourcesA = await seedResources(tenantA)
    resourcesB = await seedResources(tenantB)
  })

  /** Collects every string value that looks like one of tenant A's seeded IDs, anywhere in the response body. */
  function findLeakedIds(payload: unknown, forbiddenIds: Set<string>, found: Set<string>): void {
    if (payload == null) return
    if (typeof payload === 'string') {
      if (forbiddenIds.has(payload)) found.add(payload)
      return
    }
    if (Array.isArray(payload)) {
      for (const item of payload) findLeakedIds(item, forbiddenIds, found)
      return
    }
    if (typeof payload === 'object') {
      for (const value of Object.values(payload as Record<string, unknown>)) {
        findLeakedIds(value, forbiddenIds, found)
      }
    }
  }

  for (const entry of ROUTE_MANIFEST) {
    if (!entry.listResource) continue
    const route = routesByPath.get(entry.routePath)
    if (!route || !route.methods.includes('GET')) continue

    it(`GET ${entry.routePath} — tenant B's list contains none of tenant A's ${entry.listResource} ids`, async () => {
      const mod = await loadRouteModule(route.filePath)
      const GET = mod.GET as (...args: unknown[]) => Promise<Response>

      const request = makeRequest('http://localhost:3000' + entry.routePath, {
        cookie: cookieHeader(tenantB.sessionToken),
      })
      const res = await GET(request, makeParams({}))
      expect(res.status).toBe(200)

      const body = await res.json()
      const forbidden = new Set(Object.values(resourcesA) as string[])
      const leaked = new Set<string>()
      findLeakedIds(body, forbidden, leaked)

      expect([...leaked]).toEqual([])
    })

    // Skipped for the `image` resource kind: /api/preview/subjects only
    // surfaces images with a completed vision analysis row
    // (`getUsableAnalysis`), which this suite's lightweight fixture doesn't
    // fabricate (the vision engine's own output format is substantial and
    // orthogonal to tenancy). The leakage check above still runs and is the
    // security-relevant half of this pair; skipping only means this file
    // doesn't also re-verify that fixture-independent "images.listByStatus
    // is tenant-scoped" fact that's already covered by the dedup-separation
    // and cross-tenant suites exercising the same repository layer.
    if (entry.listResource === 'image') continue

    it(`GET ${entry.routePath} — tenant B's own ${entry.listResource} IS visible to tenant B`, async () => {
      // Guards against the leakage check above passing vacuously because the
      // route always returns an empty list regardless of caller.
      const mod = await loadRouteModule(route.filePath)
      const GET = mod.GET as (...args: unknown[]) => Promise<Response>
      const request = makeRequest('http://localhost:3000' + entry.routePath, {
        cookie: cookieHeader(tenantB.sessionToken),
      })
      const res = await GET(request, makeParams({}))
      const body = await res.json()

      const ownId = resourcesB[(entry.listResource + 'Id') as keyof SeededResources]
      const found = new Set<string>()
      findLeakedIds(body, new Set([ownId]), found)
      expect(found.has(ownId)).toBe(true)
    })
  }
})
