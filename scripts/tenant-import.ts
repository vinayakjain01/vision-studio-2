/**
 * Import a tenant bundle produced by scripts/tenant-export.ts into THIS
 * server's control.db and data directory. Refuses if a tenant with the same
 * id already exists here.
 *
 *   npm run tenant:import -- --bundle /path/to/bundle
 */

import { config } from '../src/config'
import { importTenantBundle } from './lib/backup-restore'

function parseArgs(argv: string[]): { bundle?: string } {
  const out: { bundle?: string } = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--bundle') out.bundle = argv[++i]
  }
  return out
}

async function main() {
  const { bundle } = parseArgs(process.argv.slice(2))
  if (!bundle) {
    console.error('Usage: npm run tenant:import -- --bundle /path/to/bundle')
    process.exit(1)
  }

  const tenantId = await importTenantBundle({ dataDir: config.paths.dataDir, bundleDir: bundle })
  console.log(`✓ imported tenant ${tenantId}`)
  console.log('  run `npm run db:migrate` to confirm its app.db schema is current, then it is ready to use.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
