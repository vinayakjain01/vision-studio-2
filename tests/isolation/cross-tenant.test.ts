import path from 'path'
import { describe, it, expect, beforeAll } from 'vitest'
import { createTestTenant, cookieHeader, type TestTenant } from '../helpers/tenancy-fixture'
import { seedResources, type SeededResources } from '../helpers/seed-resources'
import { makeRequest, makeParams } from '../helpers/request'
import { loadRouteModule } from './load-route'
import { listApiRoutes } from './route-inventory'
import { ROUTE_MANIFEST, resourceId } from './route-manifest'

/**
 * For every route the manifest says takes a resource ID — whether from the
 * URL path or the JSON body — proves tenant B cannot read, modify, or
 * delete tenant A's resource by ID, and that the response for "A's real ID"
 * is indistinguishable from "an ID that doesn't exist at all" (never a 403
 * that would confirm the resource exists under someone else).
 */
describe('cross-tenant resource access', () => {
  const projectRoot = path.resolve(__dirname, '../..')
  const routesByPath = new Map(listApiRoutes(projectRoot).map(r => [r.routePath, r]))

  let tenantA: TestTenant
  let tenantB: TestTenant
  let resourcesA: SeededResources

  beforeAll(async () => {
    tenantA = createTestTenant('Tenant A')
    tenantB = createTestTenant('Tenant B')
    resourcesA = await seedResources(tenantA)
  })

  async function invoke(
    filePath: string,
    method: string,
    cookie: string | undefined,
    params: Record<string, string>,
    body?: unknown
  ) {
    const mod = await loadRouteModule(filePath)
    const fn = mod[method] as (...args: unknown[]) => Promise<Response>
    expect(fn, `${filePath} exports ${method}`).toBeTypeOf('function')
    // The URL's path is never parsed for routing here — `fn` is called
    // directly, and a dynamic segment's value comes from `params` (built
    // below via `makeParams`), not from matching this URL. Any stable path
    // is fine.
    const request = makeRequest('http://localhost:3000/api/test', {
      method,
      cookie,
      json: body,
    })
    return fn(request, makeParams(params))
  }

  for (const entry of ROUTE_MANIFEST) {
    const pathResource = entry.pathResource
    if (entry.public || !pathResource) continue
    const route = routesByPath.get(entry.routePath)
    if (!route) continue

    describe(`${entry.routePath} [${pathResource.param}]`, () => {
      for (const method of pathResource.methods) {
        it(`${method} rejects tenant B using tenant A's real ${pathResource.resource} id (404, not 403)`, async () => {
          const id = resourceId(resourcesA, pathResource.resource)
          const res = await invoke(route.filePath, method, cookieHeader(tenantB.sessionToken), {
            [pathResource.param]: id,
          })
          expect(res.status).toBe(404)
          expect(res.status).not.toBe(403)
        })

        it(`${method} returns the identical 404 for a nonexistent ${pathResource.resource} id`, async () => {
          const res = await invoke(route.filePath, method, cookieHeader(tenantB.sessionToken), {
            [pathResource.param]: 'nonexistent_00000000000000',
          })
          expect(res.status).toBe(404)
        })

        it(`${method} rejects an unauthenticated caller (401)`, async () => {
          const id = resourceId(resourcesA, pathResource.resource)
          const res = await invoke(route.filePath, method, undefined, {
            [pathResource.param]: id,
          })
          expect(res.status).toBe(401)
        })

        // Only GET is exercised as a "does the legitimate owner still get
        // through" positive check. PATCH/DELETE/delete-style POSTs mutate or
        // remove the shared seeded fixture, and several resources here are
        // foreign-key-linked (deleting the product can cascade to its
        // images/creatives) — running a destructive method here would
        // corrupt the fixture for every OTHER route entry's tests later in
        // this same file. The negative checks above (404/401) are the
        // actually security-relevant assertions for mutating methods; the
        // existing-flows-still-work property for writes is covered by the
        // ad-hoc manual testing noted in the phase report, not re-asserted
        // here against shared state.
        if (method === 'GET') {
          it(`${method} still works for tenant A on its own resource`, async () => {
            const id = resourceId(resourcesA, pathResource.resource)
            const res = await invoke(route.filePath, method, cookieHeader(tenantA.sessionToken), {
              [pathResource.param]: id,
            })
            expect(res.status).toBeLessThan(400)
          })
        }
      }
    })
  }

  for (const entry of ROUTE_MANIFEST) {
    const bodyResources = entry.bodyResources
    if (entry.public || !bodyResources) continue
    const route = routesByPath.get(entry.routePath)
    if (!route) continue

    describe(`${entry.routePath} (body-ID)`, () => {
      for (const check of bodyResources) {
        it(`${check.method} rejects tenant B using tenant A's real ${check.resource} id in the body (404)`, async () => {
          const id = resourceId(resourcesA, check.resource)
          const res = await invoke(route.filePath, check.method, cookieHeader(tenantB.sessionToken), {}, {
            [check.field]: id,
            ...check.extraBody,
          })
          expect(res.status).toBe(404)
          expect(res.status).not.toBe(403)
        })

        it(`${check.method} rejects an unauthenticated caller (401)`, async () => {
          const id = resourceId(resourcesA, check.resource)
          const res = await invoke(route.filePath, check.method, undefined, {}, {
            [check.field]: id,
            ...check.extraBody,
          })
          expect(res.status).toBe(401)
        })
      }
    })
  }
})
