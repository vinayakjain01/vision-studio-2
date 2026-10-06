import path from 'path'
import { describe, it, expect } from 'vitest'
import { makeRequest } from '../helpers/request'
import { loadRouteModule } from './load-route'
import { listApiRoutes } from './route-inventory'
import { ROUTE_MANIFEST } from './route-manifest'

/**
 * Driven by the filesystem inventory, not the hand-written manifest's
 * per-resource checks — this is the blanket "no session, no access" sweep
 * the spec asks for ("Assert unauthenticated access is rejected everywhere
 * except login/health"), and it has to cover every route whether or not
 * someone remembered to add it to the detailed cross-tenant matrix above.
 *
 * Dynamic segment values don't matter here: `handler()` resolves the
 * session before the route body ever runs, so an unauthenticated request
 * is rejected before any param is read — a dummy value for every segment is
 * enough to invoke the handler at all.
 */
describe('unauthenticated access is rejected everywhere except public routes', () => {
  const projectRoot = path.resolve(__dirname, '../..')
  const discovered = listApiRoutes(projectRoot)
  const publicPaths = new Set(ROUTE_MANIFEST.filter(r => r.public).map(r => r.routePath))

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

  for (const route of discovered) {
    const isPublic = publicPaths.has(route.routePath)

    for (const method of route.methods) {
      const title = `${method} ${route.routePath}`

      if (isPublic) {
        it(`${title} — public route, no session required`, async () => {
          const mod = await loadRouteModule(route.filePath)
          const fn = mod[method] as (...args: unknown[]) => Promise<Response>
          const request = makeRequest('http://localhost:3000/api/test', { method })
          const res = await fn(request, { params: Promise.resolve(dummyParams(route.filePath)) })
          // Not asserting 200 — login with no body is a 400, for instance —
          // only that it's not the 401 a protected route would give.
          expect(res.status).not.toBe(401)
        })
        continue
      }

      it(`${title} — rejects a request with no session cookie (401)`, async () => {
        const mod = await loadRouteModule(route.filePath)
        const fn = mod[method] as (...args: unknown[]) => Promise<Response>
        const request = makeRequest('http://localhost:3000/api/test', { method })
        const res = await fn(request, { params: Promise.resolve(dummyParams(route.filePath)) })
        expect(res.status).toBe(401)
      })

      it(`${title} — rejects a forged/expired session token (401)`, async () => {
        const mod = await loadRouteModule(route.filePath)
        const fn = mod[method] as (...args: unknown[]) => Promise<Response>
        const request = makeRequest('http://localhost:3000/api/test', {
          method,
          cookie: 'vs_session=not-a-real-token',
        })
        const res = await fn(request, { params: Promise.resolve(dummyParams(route.filePath)) })
        expect(res.status).toBe(401)
      })
    }
  }
})
