import path from 'path'
import { describe, it, expect } from 'vitest'
import { listApiRoutes } from './route-inventory'
import { ROUTE_MANIFEST } from './route-manifest'

/**
 * The enforcement mechanism the spec asks for: "fail if [a route is] missing
 * from the isolation matrix or not explicitly marked public." A route added
 * to `src/app/api/**` later, with no corresponding entry here, fails this
 * test immediately — it cannot silently ship with no isolation coverage.
 */
describe('route inventory ⊆ isolation manifest', () => {
  const projectRoot = path.resolve(__dirname, '../..')
  const discovered = listApiRoutes(projectRoot)
  const manifestByPath = new Map(ROUTE_MANIFEST.map(r => [r.routePath, r]))

  it('found at least the routes known at the time this suite was written', () => {
    // A floor, not a ceiling — guards against the scan itself silently
    // returning nothing (e.g. a path typo) and every other test in this
    // file passing vacuously.
    expect(discovered.length).toBeGreaterThanOrEqual(28)
  })

  it('every discovered route has a manifest entry', () => {
    const missing = discovered
      .map(r => r.routePath)
      .filter(routePath => !manifestByPath.has(routePath))
    expect(missing).toEqual([])
  })

  it('every manifest entry corresponds to a real route on disk', () => {
    const discoveredPaths = new Set(discovered.map(r => r.routePath))
    const stale = ROUTE_MANIFEST.map(r => r.routePath).filter(p => !discoveredPaths.has(p))
    expect(stale).toEqual([])
  })

  it('every discovered HTTP method is covered by its manifest entry', () => {
    const gaps: string[] = []
    for (const route of discovered) {
      const entry = manifestByPath.get(route.routePath)
      if (!entry) continue // already reported above
      if (entry.public) continue

      const coveredMethods = new Set([
        ...(entry.listResource ? ['GET'] : []),
        ...(entry.pathResource?.methods ?? []),
        ...(entry.bodyResources?.map(b => b.method) ?? []),
      ])

      for (const method of route.methods) {
        if (!coveredMethods.has(method) && !entry.note) {
          gaps.push(`${route.routePath} ${method}`)
        }
      }
    }
    // A route whose manifest entry carries a `note` has made a deliberate,
    // documented choice about why a method isn't in the per-ID matrix (see
    // route-manifest.ts) — that's not a gap, it's a recorded decision.
    // Routes with no note and no coverage are the real gaps.
    expect(gaps).toEqual([])
  })

  it('every manifest entry gives a reason when it skips per-ID coverage', () => {
    const unexplained = ROUTE_MANIFEST.filter(
      r => !r.public && !r.listResource && !r.pathResource && !r.bodyResources && !r.note
    )
    expect(unexplained).toEqual([])
  })
})
