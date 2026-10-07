/**
 * Static check: direct database/storage-root access is confined to the
 * modules that implement the tenancy layer. Everything else — API routes,
 * pages, services — must go through `src/db/repositories.ts` (or
 * `control-repositories.ts`) and `src/storage/media-store.ts`, never open a
 * handle or resolve a tenant root itself.
 *
 * This is the enforcement half of "every data access gets its handle and
 * paths only through the tenant context" (docs/MULTI_TENANCY.md P2 #1): it's
 * easy to introduce a module-level `new Database(...)` or a raw
 * `tenantPaths(id)` call by copy-pasting from `client.ts`/`media-store.ts`
 * without copying the part that resolves the tenant safely, and a reviewer
 * skimming a diff can miss it. A grep-based check that runs on every `npm
 * run lint` catches it the same day instead of in production.
 *
 * Deliberately regex-based, not an AST/eslint rule: the forbidden patterns
 * are fixed identifiers (`getDb(`, `new Database(`, `openTenantDbById(`,
 * `tenantPaths(`), and a string scan is enough to catch them reliably
 * without the project taking on a custom eslint rule just for this.
 */

import fs from 'fs'
import path from 'path'

export interface Violation {
  file: string
  line: number
  pattern: string
  excerpt: string
}

interface Pattern {
  name: string
  regex: RegExp
}

const FORBIDDEN_PATTERNS: Pattern[] = [
  { name: 'getDb()', regex: /\bgetDb\s*\(/ },
  { name: 'new Database(', regex: /\bnew\s+Database\s*\(/ },
  { name: 'openTenantDbById()', regex: /\bopenTenantDbById\s*\(/ },
  { name: 'tenantPaths()', regex: /\btenantPaths\s*\(/ },
]

/**
 * Files/directories allowed to use the patterns above. Paths are relative to
 * the project root, POSIX-separated, and matched as an exact file or a
 * directory prefix.
 *
 * Kept as one explicit list rather than a naming convention (e.g. "anything
 * under db/") so that adding a new allowed module is a deliberate, visible
 * edit here — the same reason the tenant-creation guard
 * (`control-repositories.ts`) spells out its condition instead of inferring
 * it.
 */
const ALLOWED = [
  // This file's own comments and regex literals name every forbidden
  // pattern as their subject matter, which the regex scan below can't tell
  // apart from a real call site.
  'scripts/lib/tenancy-boundaries.ts',
  'src/db/client.ts',
  'src/db/repositories.ts',
  'src/db/control-repositories.ts',
  'src/db/migrate.ts',
  'src/storage/media-store.ts',
  'src/config.ts',
  'src/tenancy/context.ts',
  'src/tenancy/page-context.ts',
  // The job queue/worker pool's own data-access layer — reviewed as part of
  // P3's global-queue migration.
  'src/jobs/queue.ts',
  'src/jobs/runner.ts',
  'src/jobs/pool.ts',
  'src/jobs/worker.ts',
  'src/jobs/worker-entry.ts',
  // Maintenance scripts with no request to derive a tenant from — see each
  // file's own doc comment for why it uses openTenantDbById explicitly.
  'scripts/clear-queue.ts',
  'scripts/migrate.ts',
  'scripts/tenants-migrate-legacy.ts',
]

const SCAN_ROOTS = ['src', 'scripts']

function isAllowed(relPath: string): boolean {
  return ALLOWED.includes(relPath)
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      out.push(full)
    }
  }
}

/**
 * Scans `src/` and `scripts/` under `projectRoot` for the forbidden patterns
 * outside the allowlist. Returns one `Violation` per matching line.
 */
export function findTenancyBoundaryViolations(projectRoot: string): Violation[] {
  const files: string[] = []
  for (const root of SCAN_ROOTS) {
    const full = path.join(projectRoot, root)
    if (fs.existsSync(full)) walk(full, files)
  }

  const violations: Violation[] = []

  for (const file of files) {
    const relPath = path.relative(projectRoot, file).split(path.sep).join('/')
    if (isAllowed(relPath)) continue

    const lines = fs.readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, idx) => {
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.regex.test(line)) {
          violations.push({
            file: relPath,
            line: idx + 1,
            pattern: pattern.name,
            excerpt: line.trim(),
          })
        }
      }
    })
  }

  return violations
}
