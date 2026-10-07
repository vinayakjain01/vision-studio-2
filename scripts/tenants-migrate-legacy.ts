/**
 * One-time migration: move the pre-multi-tenancy single data directory into
 * the new per-tenant layout, and create the first platform_admin + tenant.
 *
 *   npm run tenants:migrate-legacy -- --i-have-a-backup
 *
 * Before:
 *   data/vision-studio.db
 *   data/media/{originals,derived,creatives,assets}/
 *
 * After:
 *   data/control.db                              (new)
 *   data/tenants/<tenantId>/app.db                (was data/vision-studio.db)
 *   data/tenants/<tenantId>/media/...             (was data/media/...)
 *
 * Idempotent: if the legacy path is already gone and control.db already has
 * a tenant, this is a no-op that exits cleanly rather than erroring — safe
 * to run again (e.g. from a deploy script) without checking state first.
 *
 * Refuses to run without `--i-have-a-backup` — this moves (not copies) the
 * live database and every media file, and nothing about this operation
 * writes a backup of its own first.
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import Database from 'better-sqlite3'
import { config, tenantPaths } from '../src/config'
import { getControlDb, openTenantDbById, closeDb } from '../src/db/client'
import { migrateControl, migrate } from '../src/db/migrate'
import { users, tenants, memberships } from '../src/db/control-repositories'
import { hashPassword } from '../src/auth/password'
import { ensureMediaRoots } from '../src/storage/media-store'
import { migrateTenantJobs } from './lib/legacy-migration-jobs'

const LEGACY_DB_PATH = path.join(config.paths.dataDir, 'vision-studio.db')
const LEGACY_MEDIA_DIR = path.join(config.paths.dataDir, 'media')
const MEDIA_SUBDIRS = ['originals', 'derived', 'creatives', 'assets'] as const

const TABLES_TO_COUNT = [
  'imports',
  'products',
  'images',
  'vision_analyses',
  'derived_assets',
  'templates',
  'rules',
  'batches',
  'jobs',
  'creatives',
] as const

function countRows(db: Database.Database): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const table of TABLES_TO_COUNT) {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table)
    counts[table] = exists ? (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as any).c : 0
  }
  return counts
}

function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0
  let count = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else count++
    }
  }
  return count
}

/** Moves a directory's CONTENTS into an existing destination directory (which `ensureMediaRoots` already created), rather than moving the directory itself — the destination's parent layout is fixed by `tenantPaths()`. */
function moveContents(srcDir: string, destDir: string): void {
  if (!fs.existsSync(srcDir)) return
  for (const entry of fs.readdirSync(srcDir)) {
    fs.renameSync(path.join(srcDir, entry), path.join(destDir, entry))
  }
}

async function main() {
  if (!process.argv.includes('--i-have-a-backup')) {
    console.error(
      'Refusing to run: this moves data/vision-studio.db and data/media/* in place, with no ' +
        'backup of its own. Back up the data/ directory, then re-run with --i-have-a-backup.'
    )
    process.exit(1)
  }

  const legacyDbExists = fs.existsSync(LEGACY_DB_PATH)
  const existingTenants = fs.existsSync(config.paths.controlDatabase) ? tenants.list() : []

  if (!legacyDbExists && existingTenants.length > 0) {
    console.log('Already migrated — control.db has a tenant and the legacy database is gone. Nothing to do.')
    return
  }

  if (!legacyDbExists) {
    console.log(
      'No legacy database found — nothing to move. Bootstrapping the control plane and the ' +
        'first admin/tenant directly instead (a fresh install, not a migration).'
    )
  }

  if (!config.auth.adminEmail || !config.auth.adminPassword) {
    console.error('ADMIN_EMAIL and ADMIN_PASSWORD must both be set to create the first account.')
    process.exit(1)
  }

  console.log('Vision Studio — legacy migration')

  let beforeCounts: Record<string, number> = Object.fromEntries(TABLES_TO_COUNT.map(t => [t, 0]))
  const beforeFileCounts: Record<string, number> = Object.fromEntries(MEDIA_SUBDIRS.map(s => [s, 0]))
  const sampleFiles: { relPath: string; hash: string }[] = []

  if (legacyDbExists) {
    console.log(`  legacy database   ${LEGACY_DB_PATH}`)
    console.log(`  legacy media      ${LEGACY_MEDIA_DIR}`)

    // ── Capture pre-migration counts for verification ───────────────────────
    const legacyDb = new Database(LEGACY_DB_PATH, { readonly: true })
    beforeCounts = countRows(legacyDb)
    legacyDb.close()

    for (const sub of MEDIA_SUBDIRS) {
      beforeFileCounts[sub] = countFiles(path.join(LEGACY_MEDIA_DIR, sub))
    }
  }

  // Spot-check a handful of originals' hashes BEFORE moving anything —
  // re-verified against the same bytes at their new path after the move.
  const originalsDir = path.join(LEGACY_MEDIA_DIR, 'originals')
  if (legacyDbExists && fs.existsSync(originalsDir)) {
    const allFiles: string[] = []
    const stack = [originalsDir]
    while (stack.length > 0) {
      const current = stack.pop()!
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) stack.push(full)
        else allFiles.push(full)
      }
    }
    const sampleCount = Math.min(10, allFiles.length)
    for (let i = 0; i < sampleCount; i++) {
      const file = allFiles[Math.floor((i * allFiles.length) / sampleCount)]
      const bytes = fs.readFileSync(file)
      sampleFiles.push({
        relPath: path.relative(originalsDir, file),
        hash: crypto.createHash('sha256').update(bytes).digest('hex'),
      })
    }
  }

  // ── Control plane: admin user + tenant + membership ───────────────────────
  const controlDb = getControlDb()
  migrateControl(controlDb)

  let admin = users.findByEmail(config.auth.adminEmail)
  if (!admin) {
    const passwordHash = await hashPassword(config.auth.adminPassword)
    admin = users.create({ email: config.auth.adminEmail, passwordHash, isPlatformAdmin: true })
    console.log(`  created admin user   ${admin.email}`)
  } else {
    console.log(`  admin user already exists   ${admin.email}`)
  }

  const existingMembership = memberships.findForUser(admin.id)
  const tenant = existingMembership
    ? tenants.get(existingMembership.tenantId)!
    : tenants.create(process.env.DEFAULT_TENANT_NAME || 'Default workspace')
  if (!existingMembership) {
    memberships.create(admin.id, tenant.id, 'owner')
  }
  console.log(`  tenant   ${tenant.id}  (${tenant.name})`)

  // ── Move the data ──────────────────────────────────────────────────────────
  // Media directories only — NOT the tenant DB handle. Opening it before the
  // database file has been moved into place would create an empty app.db at
  // the destination, which the move below would then have to clobber rather
  // than land cleanly.
  ensureMediaRoots(tenant.id)

  if (legacyDbExists) {
    // Close everything (the control-plane handle used just above, and any
    // tenant handle, though none is open yet) before touching files on disk
    // — an open WAL handle mid-move is exactly the corruption this script
    // must not risk.
    closeDb()

    const paths = tenantPaths(tenant.id)
    for (const suffix of ['', '-wal', '-shm']) {
      const src = LEGACY_DB_PATH + suffix
      if (fs.existsSync(src)) fs.renameSync(src, paths.database + suffix)
    }

    for (const sub of MEDIA_SUBDIRS) {
      moveContents(path.join(LEGACY_MEDIA_DIR, sub), paths[sub])
    }

    console.log('  moved legacy database and media into the tenant directory')
  }

  // Re-open fresh handles post-move and bring the tenant DB's schema current
  // (a no-op if it already was — `migrate()` is always idempotent).
  const freshTenantDb = openTenantDbById(tenant.id)
  migrate(freshTenantDb)

  // ── P3: copy this tenant's legacy jobs into control.db's global queue ────
  const { copied: jobsCopied, legacyCount: legacyJobCount } = migrateTenantJobs(
    tenant.id,
    freshTenantDb,
    controlDb
  )
  if (legacyJobCount > 0) {
    console.log(`  copied ${jobsCopied} of ${legacyJobCount} legacy job row(s) into control.db`)
  }

  // ── Verify ──────────────────────────────────────────────────────────────
  console.log('\nVerifying...')
  let ok = true

  const afterCounts = countRows(freshTenantDb)
  for (const table of TABLES_TO_COUNT) {
    // `jobs` is verified separately below, against control.db — the table
    // this check reads (the tenant's own, pre-P3 one) is deliberately left
    // untouched, so its count trivially still matches itself.
    if (table === 'jobs') continue
    if (beforeCounts[table] !== afterCounts[table]) {
      ok = false
      console.error(`  ROW COUNT MISMATCH  ${table}: before=${beforeCounts[table]} after=${afterCounts[table]}`)
    }
  }
  if (ok) console.log(`  row counts match for all ${TABLES_TO_COUNT.length - 1} tables`)

  if (legacyJobCount > 0) {
    const controlJobCount = (
      controlDb.prepare('SELECT COUNT(*) AS c FROM jobs WHERE tenant_id = ?').get(tenant.id) as { c: number }
    ).c
    if (controlJobCount !== legacyJobCount) {
      ok = false
      console.error(
        `  JOB ROW COUNT MISMATCH  control.db has ${controlJobCount}, legacy app.db had ${legacyJobCount}`
      )
    } else {
      console.log(`  job row count matches control.db (${controlJobCount})`)
    }
  }

  const tenantPathsAfter = tenantPaths(tenant.id)
  for (const sub of MEDIA_SUBDIRS) {
    const after = countFiles(tenantPathsAfter[sub])
    if (after !== beforeFileCounts[sub]) {
      ok = false
      console.error(`  FILE COUNT MISMATCH  ${sub}: before=${beforeFileCounts[sub]} after=${after}`)
    }
  }
  if (ok) console.log(`  file counts match for all media roots`)

  for (const sample of sampleFiles) {
    const newPath = path.join(tenantPathsAfter.originals, sample.relPath)
    if (!fs.existsSync(newPath)) {
      ok = false
      console.error(`  MISSING AFTER MOVE  ${sample.relPath}`)
      continue
    }
    const actualHash = crypto.createHash('sha256').update(fs.readFileSync(newPath)).digest('hex')
    if (actualHash !== sample.hash) {
      ok = false
      console.error(`  HASH MISMATCH  ${sample.relPath}`)
    }
  }
  if (ok && sampleFiles.length > 0) console.log(`  hash spot-check passed for ${sampleFiles.length} files`)

  closeDb()

  if (!ok) {
    console.error('\n✗ Verification failed — see above. The move already happened; do not re-run blindly, inspect data/ by hand.')
    process.exit(1)
  }

  console.log(`\n✓ Migration complete. Sign in as ${admin.email} at /login.`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
