/**
 * Export ONE tenant as a self-contained, portable bundle (app.db, media,
 * and its control-plane rows as JSON) — for moving a tenant to another
 * server. See scripts/lib/backup-restore.ts's `exportTenantBundle` doc
 * comment, and docs/OPERATIONS.md's "move a tenant to another server" entry.
 *
 *   npm run tenant:export -- --tenant <id> --out /path/to/bundle
 */

import { config } from '../src/config'
import { exportTenantBundle } from './lib/backup-restore'

function parseArgs(argv: string[]): { tenantId?: string; out?: string } {
  const out: { tenantId?: string; out?: string } = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tenant') out.tenantId = argv[++i]
    else if (argv[i] === '--out') out.out = argv[++i]
  }
  return out
}

async function main() {
  const { tenantId, out } = parseArgs(process.argv.slice(2))
  if (!tenantId || !out) {
    console.error('Usage: npm run tenant:export -- --tenant <id> --out /path/to/bundle')
    process.exit(1)
  }

  await exportTenantBundle({ dataDir: config.paths.dataDir, tenantId, destDir: out })
  console.log(`✓ exported tenant ${tenantId} to ${out}`)
  console.log('  copy this directory to the target server, then run: npm run tenant:import -- --bundle <path>')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
