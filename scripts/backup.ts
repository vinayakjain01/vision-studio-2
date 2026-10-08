/**
 * Online backup of control.db, every tenant's app.db, and an incremental
 * copy of media — see scripts/lib/backup-restore.ts for the full design
 * rationale (online backup API, why media is a shared incremental pool,
 * the crash-consistent-snapshot caveat).
 *
 *   npm run backup                           -- every tenant
 *   npm run backup -- --tenant <tenantId>     -- just one
 *   npm run backup -- --out /path/to/backups  -- override BACKUP_DIR
 *
 * Safe to run against a LIVE server — the backup API does not block writes.
 * Never touches anything outside `--out`/`BACKUP_DIR`; only reads `data/`.
 */

import { config } from '../src/config'
import { runBackup } from './lib/backup-restore'

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
  const backupRoot = out ?? process.env.BACKUP_DIR ?? './backups'

  console.log(`Vision Studio — backup`)
  console.log(`  data dir     ${config.paths.dataDir}`)
  console.log(`  backup root  ${backupRoot}`)
  if (tenantId) console.log(`  scope        tenant ${tenantId} only (control.db is always backed up in full)`)

  const summary = await runBackup({ dataDir: config.paths.dataDir, backupRoot, tenantId })

  console.log(`\n  snapshot       ${summary.snapshotDir}`)
  console.log(`  tenants        ${summary.tenantsBackedUp.length}`)
  console.log(`  media copied   ${summary.mediaFilesCopied} file(s)`)
  console.log(`  media skipped  ${summary.mediaFilesSkipped} file(s) (already backed up)`)
  console.log('\n✓ backup complete')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
