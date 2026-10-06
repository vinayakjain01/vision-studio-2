import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, it, expect, afterEach } from 'vitest'
import { findTenancyBoundaryViolations } from '../../scripts/lib/tenancy-boundaries'

/**
 * Proves the lint guard actually catches what it claims to, rather than
 * being a script nobody has seen fail. Builds a throwaway fake project
 * (its own `src/`/`scripts/`) rather than touching the real one — the real
 * project should already be clean, and that's covered separately below.
 */
describe('tenancy boundary guard', () => {
  let fixtureRoot: string

  afterEach(() => {
    if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true })
  })

  function writeFixture(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-lint-fixture-'))
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, rel)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, content)
    }
    return root
  }

  it('flags getDb() called from outside the allowed modules', () => {
    fixtureRoot = writeFixture({
      'src/app/api/products/route.ts': `
        import { getDb } from '@/db/client'
        export function GET() {
          return getDb().prepare('SELECT 1').get()
        }
      `,
    })

    const violations = findTenancyBoundaryViolations(fixtureRoot)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({
      file: 'src/app/api/products/route.ts',
      pattern: 'getDb()',
    })
  })

  it('flags a raw `new Database(` call outside client.ts', () => {
    fixtureRoot = writeFixture({
      'scripts/ad-hoc-fix.ts': `
        import Database from 'better-sqlite3'
        const db = new Database('data/tenants/tnt_x/app.db')
      `,
    })

    const violations = findTenancyBoundaryViolations(fixtureRoot)
    expect(violations.map(v => v.pattern)).toContain('new Database(')
  })

  it('flags tenantPaths() used directly outside the tenancy/storage modules', () => {
    fixtureRoot = writeFixture({
      'src/app/api/batches/route.ts': `
        import { tenantPaths } from '@/config'
        export function GET() {
          return tenantPaths('tnt_x').root
        }
      `,
    })

    const violations = findTenancyBoundaryViolations(fixtureRoot)
    expect(violations.map(v => v.pattern)).toContain('tenantPaths()')
  })

  it('does not flag the same call inside an allowed module', () => {
    fixtureRoot = writeFixture({
      'src/db/client.ts': `
        export function getDb() {
          return new Database('x')
        }
      `,
    })

    expect(findTenancyBoundaryViolations(fixtureRoot)).toHaveLength(0)
  })

  it('passes cleanly against the real project tree', () => {
    const realRoot = path.resolve(__dirname, '../..')
    expect(findTenancyBoundaryViolations(realRoot)).toEqual([])
  })
})
