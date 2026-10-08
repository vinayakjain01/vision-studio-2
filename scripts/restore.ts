/**
 * Restore a backup taken by scripts/backup.ts into a data directory.
 *
 *   npm run restore -- --into /path/to/data                  -- latest snapshot, every tenant
 *   npm run restore -- --into /path/to/data --snapshot 2026-10-08T12-00-00.000Z
 *   npm run restore -- --into /path/to/data --tenant <id>
 *   npm run restore -- --into /path/to/data --force           -- allow a non-empty target
 *
 * Refuses to restore into a non-empty directory without --force — this is
 * meant for disaster recovery (an empty volume) or a throwaway verification
 * directory, not for overwriting a live data/ dir by accident.
 */

import { runRestore } from './lib/backup-restore'

function parseArgs(argv: string[]) {
  const out: { into?: string; snapshot?: string; tenantId?: string; force?: boolean; backupRoot?: string } = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--into') out.into = argv[++i]
    else if (argv[i] === '--snapshot') out.snapshot = argv[++i]
    else if (argv[i] === '--tenant') out.tenantId = argv[++i]
    else if (argv[i] === '--force') out.force = true
    else if (argv[i] === '--backup-root') out.backupRoot = argv[++i]
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.into) {
    console.error('Usage: npm run restore -- --into /path/to/data [--snapshot <name>] [--tenant <id>] [--force]')
    process.exit(1)
  }
  const backupRoot = args.backupRoot ?? process.env.BACKUP_DIR ?? './backups'

  console.log('Vision Studio — restore')
  console.log(`  backup root  ${backupRoot}`)
  console.log(`  target dir   ${args.into}`)

  const summary = await runRestore({
    backupRoot,
    snapshot: args.snapshot,
    targetDataDir: args.into,
    tenantId: args.tenantId,
    force: args.force,
  })

  console.log(`\n  snapshot used     ${summary.snapshotDir}`)
  console.log(`  tenants restored  ${summary.tenantsRestored.join(', ') || '(none)'}`)
  console.log('\n✓ restore complete — run `npm run db:migrate` against the target dir before starting the app,')
  console.log('  then verify with PRAGMA integrity_check (see docs/OPERATIONS.md).')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
