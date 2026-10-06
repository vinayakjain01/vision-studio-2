import fs from 'fs'
import path from 'path'

export interface RouteInfo {
  /** URL path with Next's dynamic segments, e.g. `/api/products/[productId]`. */
  routePath: string
  filePath: string
  methods: string[]
}

const METHOD_RE = /export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=/g

/**
 * Enumerates every `route.ts` under `src/app/api` from the filesystem
 * itself, not from a hand-maintained list — the isolation suite's whole
 * point is that a NEW route cannot silently ship without being added to the
 * isolation matrix, which only holds if the inventory it's checked against
 * is derived from what's actually on disk right now.
 */
export function listApiRoutes(projectRoot: string): RouteInfo[] {
  const apiRoot = path.join(projectRoot, 'src', 'app', 'api')
  const out: RouteInfo[] = []

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && entry.name === 'route.ts') {
        const source = fs.readFileSync(full, 'utf8')
        const methods = [...source.matchAll(METHOD_RE)].map(m => m[1])
        const relDir = path.relative(apiRoot, dir).split(path.sep).join('/')
        const routePath = '/api' + (relDir === '.' ? '' : '/' + relDir)
        out.push({ routePath, filePath: path.relative(projectRoot, full).split(path.sep).join('/'), methods })
      }
    }
  }

  if (fs.existsSync(apiRoot)) walk(apiRoot)
  return out.sort((a, b) => a.routePath.localeCompare(b.routePath))
}
