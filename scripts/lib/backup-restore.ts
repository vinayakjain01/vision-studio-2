/**
 * Backup/restore core logic (P6) — extracted from scripts/backup.ts and
 * scripts/restore.ts so tests can call it directly without going through a
 * CLI's argv parsing or `process.exit()` (same reason
 * scripts/lib/legacy-migration-jobs.ts exists as its own file).
 *
 * Uses better-sqlite3's ONLINE backup API (`db.backup()`) for every SQLite
 * file — it copies the database page-by-page while the source stays fully
 * usable for reads AND writes throughout (no long write-lock, no need to
 * stop the app), which is the entire point of taking a backup of a live
 * server rather than one that's down for maintenance.
 *
 * Media files are content-addressed and immutable once written (see
 * src/storage/media-store.ts's module doc) — a file that already exists at
 * its destination path can never have different bytes than what's already
 * backed up there, so copying only skips files already present is both
 * correct and the entire "incremental" story: no file-diffing, no
 * timestamps to compare, just "does this path already exist in the backup".
 * This is why media lives in ONE shared pool across every backup run
 * (`<backupRoot>/media/...`) rather than being duplicated per timestamped
 * snapshot the way the (small, genuinely point-in-time) database files are.
 *
 * IMPORTANT: a filesystem/volume snapshot taken of the live `data/`
 * directory (as opposed to running this script) is CRASH-CONSISTENT ONLY —
 * SQLite's WAL file and main database file are snapshotted at whatever
 * instant the snapshot tool fires, which may not be a transactionally
 * consistent point if a write was physically in progress across both files
 * at that exact moment. SQLite in WAL mode recovers cleanly from this the
 * same way it recovers from a real power-loss crash (that's the whole
 * design point of WAL), so a crash-consistent snapshot is NOT corrupt —
 * but it reflects "the database as it would look after a crash at that
 * moment", not a guaranteed clean/quiesced state, and restoring one means
 * accepting whatever that recovery produces. This script's online backups
 * do not have that caveat: `db.backup()` always produces a transactionally
 * consistent copy, which is why it exists at all instead of just telling
 * everyone to snapshot the volume.
 */

import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import Database from 'better-sqlite3'

export interface BackupSummary {
  timestamp: string
  snapshotDir: string
  tenantsBackedUp: string[]
  mediaFilesCopied: number
  mediaFilesSkipped: number
}

export interface TenantInfo {
  id: string
  name: string
}

/** Sanitizes an ISO timestamp into something safe as a directory name on every OS (no colons). */
export function timestampDirName(date: Date): string {
  return date.toISOString().replace(/:/g, '-')
}

async function backupOneDb(sourcePath: string, destPath: string): Promise<void> {
  await fsp.mkdir(path.dirname(destPath), { recursive: true })
  const db = new Database(sourcePath, { readonly: true })
  try {
    await db.backup(destPath)
  } finally {
    db.close()
  }
}

/** Copies every file under `srcRoot` into the equivalent path under `destRoot`, skipping any that already exist there. Returns {copied, skipped}. */
async function mirrorNewFiles(srcRoot: string, destRoot: string): Promise<{ copied: number; skipped: number }> {
  let copied = 0
  let skipped = 0
  if (!fs.existsSync(srcRoot)) return { copied, skipped }

  const stack = [srcRoot]
  while (stack.length > 0) {
    const dir = stack.pop()!
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const srcPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(srcPath)
        continue
      }
      const rel = path.relative(srcRoot, srcPath)
      const destPath = path.join(destRoot, rel)
      if (fs.existsSync(destPath)) {
        skipped++
        continue
      }
      await fsp.mkdir(path.dirname(destPath), { recursive: true })
      await fsp.copyFile(srcPath, destPath)
      copied++
    }
  }
  return { copied, skipped }
}

/**
 * Full backup: control.db, every tenant's app.db (or just `tenantId` if
 * given), and an incremental copy of media. `dataDir`/`backupRoot` are
 * passed explicitly rather than read from `config` — this runs standalone,
 * before any TenantContext exists, the same reasoning `scripts/migrate.ts`
 * documents for using `openTenantDbById` directly.
 */
export async function runBackup(options: {
  dataDir: string
  backupRoot: string
  tenantId?: string
}): Promise<BackupSummary> {
  const { dataDir, backupRoot, tenantId } = options
  const controlDbPath = path.join(dataDir, 'control.db')
  const now = new Date()
  const timestamp = timestampDirName(now)
  const snapshotDir = path.join(backupRoot, timestamp)

  const controlDb = new Database(controlDbPath, { readonly: true })
  const allTenants = controlDb
    .prepare('SELECT id, name FROM tenants')
    .all() as TenantInfo[]
  controlDb.close()

  const targets = tenantId ? allTenants.filter(t => t.id === tenantId) : allTenants
  if (tenantId && targets.length === 0) {
    throw new Error(`no tenant with id ${tenantId}`)
  }

  // control.db always backed up in full, even for a per-tenant backup —
  // restoring a single tenant's app.db with no matching control-plane row
  // (user/membership/quotas) would be unusable on its own. The per-tenant
  // EXPORT functions below (not this one) are the real per-tenant-only path.
  await backupOneDb(controlDbPath, path.join(snapshotDir, 'control.db'))

  let mediaFilesCopied = 0
  let mediaFilesSkipped = 0
  const tenantsBackedUp: string[] = []

  for (const tenant of targets) {
    const tenantRoot = path.join(dataDir, 'tenants', tenant.id)
    const appDbPath = path.join(tenantRoot, 'app.db')
    if (fs.existsSync(appDbPath)) {
      await backupOneDb(appDbPath, path.join(snapshotDir, 'tenants', tenant.id, 'app.db'))
    }

    const mediaSrc = path.join(tenantRoot, 'media')
    const mediaDest = path.join(backupRoot, 'media', 'tenants', tenant.id, 'media')
    const { copied, skipped } = await mirrorNewFiles(mediaSrc, mediaDest)
    mediaFilesCopied += copied
    mediaFilesSkipped += skipped
    tenantsBackedUp.push(tenant.id)
  }

  await fsp.writeFile(
    path.join(snapshotDir, 'manifest.json'),
    JSON.stringify({ timestamp: now.toISOString(), tenantIds: tenantsBackedUp }, null, 2)
  )

  return { timestamp: now.toISOString(), snapshotDir, tenantsBackedUp, mediaFilesCopied, mediaFilesSkipped }
}

/** `media` is the shared, non-timestamped pool directory (see the module doc) — never itself a snapshot, so it must never be picked up by name-sort alone. */
const RESERVED_BACKUP_ROOT_ENTRIES = new Set(['media'])

/**
 * Finds the most recent snapshot directory under `backupRoot` — a real
 * snapshot is identified by having its own `manifest.json` (written at the
 * end of `runBackup`), not just by directory-name sorting, which would
 * otherwise mistake the shared `media/` pool directory for one (its name
 * sorts after an ISO timestamp lexicographically).
 */
export async function findLatestSnapshot(backupRoot: string): Promise<string | null> {
  if (!fs.existsSync(backupRoot)) return null
  const entries = (await fsp.readdir(backupRoot, { withFileTypes: true }))
    .filter(e => e.isDirectory() && !RESERVED_BACKUP_ROOT_ENTRIES.has(e.name))
    .map(e => e.name)
    .filter(name => fs.existsSync(path.join(backupRoot, name, 'manifest.json')))
    .sort()
  return entries.length > 0 ? entries[entries.length - 1] : null
}

export interface RestoreSummary {
  snapshotDir: string
  tenantsRestored: string[]
}

/**
 * Restores a full snapshot into `targetDataDir` — a plain file copy of the
 * already-consistent backup files (the consistency work happened at BACKUP
 * time via the online backup API; restore is intentionally dumb). Refuses
 * to restore into a non-empty `targetDataDir` unless `force` is set, the
 * same "don't silently overwrite" posture as the admin tenant-purge
 * confirmation flow.
 */
export async function runRestore(options: {
  backupRoot: string
  snapshot?: string // directory name under backupRoot, or omitted for the latest
  targetDataDir: string
  tenantId?: string
  force?: boolean
}): Promise<RestoreSummary> {
  const { backupRoot, targetDataDir, tenantId, force } = options
  const snapshot = options.snapshot ?? (await findLatestSnapshot(backupRoot))
  if (!snapshot) throw new Error(`no snapshots found under ${backupRoot}`)
  const snapshotDir = path.join(backupRoot, snapshot)
  if (!fs.existsSync(snapshotDir)) throw new Error(`snapshot not found: ${snapshotDir}`)

  if (!force && fs.existsSync(targetDataDir)) {
    const existing = await fsp.readdir(targetDataDir)
    if (existing.length > 0) {
      throw new Error(`${targetDataDir} is not empty — pass force:true to restore into it anyway`)
    }
  }

  await fsp.mkdir(targetDataDir, { recursive: true })
  await fsp.copyFile(path.join(snapshotDir, 'control.db'), path.join(targetDataDir, 'control.db'))

  const manifest = JSON.parse(
    await fsp.readFile(path.join(snapshotDir, 'manifest.json'), 'utf8')
  ) as { tenantIds: string[] }
  const tenantIds = tenantId ? manifest.tenantIds.filter(id => id === tenantId) : manifest.tenantIds
  if (tenantId && tenantIds.length === 0) {
    throw new Error(`tenant ${tenantId} is not in snapshot ${snapshot}`)
  }

  for (const id of tenantIds) {
    const appDbSrc = path.join(snapshotDir, 'tenants', id, 'app.db')
    const appDbDest = path.join(targetDataDir, 'tenants', id, 'app.db')
    if (fs.existsSync(appDbSrc)) {
      await fsp.mkdir(path.dirname(appDbDest), { recursive: true })
      await fsp.copyFile(appDbSrc, appDbDest)
    }

    const mediaSrc = path.join(backupRoot, 'media', 'tenants', id, 'media')
    const mediaDest = path.join(targetDataDir, 'tenants', id, 'media')
    await mirrorNewFiles(mediaSrc, mediaDest)
  }

  return { snapshotDir, tenantsRestored: tenantIds }
}

// ─── Per-tenant export/restore (moving ONE tenant to another server) ───────

export interface TenantExportManifest {
  tenant: Record<string, unknown>
  quotas: Record<string, unknown> | null
  tenantQueueState: Record<string, unknown> | null
  aiExtendTenantState: Record<string, unknown> | null
  usageCounters: Record<string, unknown>[]
  memberships: Record<string, unknown>[]
  users: Record<string, unknown>[]
}

/**
 * Self-contained export of ONE tenant: its app.db, its media, and every
 * control-plane row that belongs to it (extracted as JSON, not a raw SQL
 * dump, so `importTenantBundle` can re-insert via plain parameterised
 * statements without needing to parse or replay SQL from an untrusted
 * source file). Written to `destDir`, which becomes a complete, portable
 * bundle for `npm run tenants:export`'s counterpart import step — see
 * docs/OPERATIONS.md's "move a tenant to another server" runbook entry.
 */
export async function exportTenantBundle(options: {
  dataDir: string
  tenantId: string
  destDir: string
}): Promise<void> {
  const { dataDir, tenantId, destDir } = options
  const controlDbPath = path.join(dataDir, 'control.db')
  const controlDb = new Database(controlDbPath, { readonly: true })

  const tenant = controlDb.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId) as any
  if (!tenant) {
    controlDb.close()
    throw new Error(`no tenant with id ${tenantId}`)
  }

  const manifest: TenantExportManifest = {
    tenant,
    quotas: (controlDb.prepare('SELECT * FROM quotas WHERE tenant_id = ?').get(tenantId) as any) ?? null,
    tenantQueueState:
      (controlDb.prepare('SELECT * FROM tenant_queue_state WHERE tenant_id = ?').get(tenantId) as any) ?? null,
    aiExtendTenantState:
      (controlDb.prepare('SELECT * FROM ai_extend_tenant_state WHERE tenant_id = ?').get(tenantId) as any) ?? null,
    usageCounters: controlDb.prepare('SELECT * FROM usage_counters WHERE tenant_id = ?').all(tenantId) as any[],
    memberships: controlDb.prepare('SELECT * FROM memberships WHERE tenant_id = ?').all(tenantId) as any[],
    users: [],
  }
  const userIds = manifest.memberships.map((m: any) => m.user_id)
  manifest.users =
    userIds.length > 0
      ? (controlDb
          .prepare(`SELECT * FROM users WHERE id IN (${userIds.map(() => '?').join(',')})`)
          .all(...userIds) as any[])
      : []
  controlDb.close()

  await fsp.mkdir(destDir, { recursive: true })
  await fsp.writeFile(path.join(destDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  const appDbSrc = path.join(dataDir, 'tenants', tenantId, 'app.db')
  if (fs.existsSync(appDbSrc)) {
    await backupOneDb(appDbSrc, path.join(destDir, 'app.db'))
  }

  const mediaSrc = path.join(dataDir, 'tenants', tenantId, 'media')
  await mirrorNewFiles(mediaSrc, path.join(destDir, 'media'))
}

/**
 * Re-inserts a tenant bundle (from `exportTenantBundle`) into a DIFFERENT
 * server's control.db and data directory. Refuses if a tenant with the same
 * id already exists there — this is meant to move a tenant, not merge or
 * silently overwrite one.
 */
export async function importTenantBundle(options: { dataDir: string; bundleDir: string }): Promise<string> {
  const { dataDir, bundleDir } = options
  const manifest = JSON.parse(
    await fsp.readFile(path.join(bundleDir, 'manifest.json'), 'utf8')
  ) as TenantExportManifest

  const controlDbPath = path.join(dataDir, 'control.db')
  const controlDb = new Database(controlDbPath)
  try {
    const existing = controlDb.prepare('SELECT 1 FROM tenants WHERE id = ?').get(manifest.tenant.id)
    if (existing) {
      throw new Error(`a tenant with id ${manifest.tenant.id} already exists on this server`)
    }

    const insertRow = (table: string, row: Record<string, unknown>) => {
      const columns = Object.keys(row)
      controlDb
        .prepare(
          `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
        )
        .run(...columns.map(c => row[c] as any))
    }

    controlDb.transaction(() => {
      for (const user of manifest.users) insertRow('users', user)
      insertRow('tenants', manifest.tenant)
      if (manifest.quotas) insertRow('quotas', manifest.quotas)
      if (manifest.tenantQueueState) insertRow('tenant_queue_state', manifest.tenantQueueState)
      if (manifest.aiExtendTenantState) insertRow('ai_extend_tenant_state', manifest.aiExtendTenantState)
      for (const usage of manifest.usageCounters) insertRow('usage_counters', usage)
      for (const membership of manifest.memberships) insertRow('memberships', membership)
    })()
  } finally {
    controlDb.close()
  }

  const tenantId = manifest.tenant.id as string
  const appDbSrc = path.join(bundleDir, 'app.db')
  if (fs.existsSync(appDbSrc)) {
    const appDbDest = path.join(dataDir, 'tenants', tenantId, 'app.db')
    await fsp.mkdir(path.dirname(appDbDest), { recursive: true })
    await fsp.copyFile(appDbSrc, appDbDest)
  }

  const mediaSrc = path.join(bundleDir, 'media')
  const mediaDest = path.join(dataDir, 'tenants', tenantId, 'media')
  await mirrorNewFiles(mediaSrc, mediaDest)

  return tenantId
}
