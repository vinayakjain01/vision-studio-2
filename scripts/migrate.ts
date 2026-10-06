/**
 * CLI: apply schemas.
 *
 *   npm run db:migrate          control.db baseline+migrations, then every
 *                               tenant's app.db
 *   npm run db:reset            drop all tenant tables, then re-apply
 *                               (control.db is NEVER dropped by --reset —
 *                               that would delete every account and tenant
 *                               record; see `npm run db:reset` in
 *                               package.json if a control-plane reset is
 *                               ever genuinely needed, which it isn't here)
 */

import { getControlDb, openTenantDbById, closeDb } from '../src/db/client'
import { migrate, migrateControl, dropAll } from '../src/db/migrate'
import { tenants } from '../src/db/control-repositories'
import { ensureMediaRoots } from '../src/storage/media-store'

function main() {
  const reset = process.argv.includes('--reset')

  const controlDb = getControlDb()
  migrateControl(controlDb)
  console.log(`  control.db   migrated`)

  const list = tenants.list()
  if (list.length === 0) {
    console.log('  no tenants yet — run `npm run tenants:migrate-legacy` or create one first')
  }

  for (const tenant of list) {
    ensureMediaRoots(tenant.id)
    const db = openTenantDbById(tenant.id)

    if (reset) {
      console.log(`  [${tenant.id}] dropping all tables (media on disk is preserved)`)
      dropAll(db)
    }

    const result = migrate(db)
    const summary = result.applied.length
      ? `migrations: ${result.applied.join(', ')}`
      : `up to date (${result.skipped.length} previously applied)`
    console.log(`  [${tenant.id}] ${tenant.name} — ${summary}`)
  }

  closeDb()
  console.log('\n✓ schema ready')
}

main()
