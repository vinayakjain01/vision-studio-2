/**
 * CLI: `npm run lint` runs this before eslint (see package.json). Fails the
 * build the same way a type error or lint error would — see
 * `scripts/lib/tenancy-boundaries.ts` for what it checks and why.
 */

import path from 'path'
import { findTenancyBoundaryViolations } from './lib/tenancy-boundaries'

const projectRoot = path.resolve(__dirname, '..')
const violations = findTenancyBoundaryViolations(projectRoot)

if (violations.length === 0) {
  console.log('✓ tenancy boundaries: no direct db/storage-root access outside the allowed modules')
  process.exit(0)
}

console.error(`✗ tenancy boundaries: ${violations.length} violation(s) found\n`)
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  ${v.pattern}`)
  console.error(`    ${v.excerpt}`)
}
console.error(
  '\nDirect database/storage-root access must go through src/db/repositories.ts ' +
    '(or control-repositories.ts) and src/storage/media-store.ts — see ' +
    'scripts/lib/tenancy-boundaries.ts for the allowed-module list and why this is enforced.'
)
process.exit(1)
