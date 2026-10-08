import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { describe, it, expect } from 'vitest'
import { createTestTenant } from '../helpers/tenancy-fixture'
import { runWithTenant } from '@/tenancy/context'
import { config } from '@/config'
import { writeFileAtomic } from '@/storage/media-store'
import { imports, products, images, templates, batches, creatives } from '@/db/repositories'
import { createDefaultTemplate } from '@/templates/types'
import {
  runBackup,
  runRestore,
  findLatestSnapshot,
  exportTenantBundle,
  importTenantBundle,
} from '../../scripts/lib/backup-restore'

function tmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `vs-${label}-`))
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** Row counts across every table that should round-trip through a backup/restore. */
function tenantAppDbCounts(dbPath: string): Record<string, number> {
  const db = new Database(dbPath, { readonly: true })
  try {
    const tables = ['imports', 'products', 'images', 'templates', 'batches', 'creatives']
    const counts: Record<string, number> = {}
    for (const t of tables) counts[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n
    return counts
  } finally {
    db.close()
  }
}

describe('backup/restore (P6)', () => {
  async function seedTenantWithRealData(label: string) {
    const tenant = createTestTenant(label)
    const ctx = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' as const }
    const creativeBytes = Buffer.from(`real-creative-bytes-for-${label}-` + 'x'.repeat(50))
    let creativeStorageKey = ''

    await runWithTenant(ctx, async () => {
      const imp = imports.create({ name: `${label}-import` })
      const product = products.upsert({
        importId: imp.id,
        name: 'Backup Test Product',
        slug: 'backup-test-product',
        folderPath: 'backup-test-product',
        category: null,
      })
      const image = images.create({
        productId: product.id,
        importId: imp.id,
        sourceHash: `hash-${label}`,
        storageKey: `bk/up/hash-${label}.jpg`,
        fileName: 'photo.jpg',
        relativePath: 'backup-test-product/photo.jpg',
        mimeType: 'image/jpeg',
        byteSize: 10,
        width: 10,
        height: 10,
        exifOrientation: null,
        hasAlpha: false,
        colorSpace: 'srgb',
        capturedAt: null,
        cameraMake: null,
        cameraModel: null,
        position: 0,
        isPrimary: true,
      })
      const template = templates.create({ name: 'T', document: createDefaultTemplate('4:5') })
      const batch = batches.create('backup-test-batch')
      creativeStorageKey = `${batch.id}/creative.jpg`
      await writeFileAtomic('creatives', creativeStorageKey, creativeBytes)
      creatives.put({
        productId: product.id,
        imageId: image.id,
        templateId: template.id,
        batchId: batch.id,
        sourceHash: `hash-${label}`,
        visionId: null,
        storageKey: creativeStorageKey,
        mimeType: 'image/jpeg',
        width: 10,
        height: 10,
        byteSize: creativeBytes.byteLength,
        framing: null,
        renderMs: 1,
      })
    })

    return { tenant, creativeBytes, creativeStorageKey }
  }

  it('full backup -> restore into a fresh dir: integrity_check passes, row counts match, a media file\'s bytes are identical', async () => {
    const { tenant, creativeBytes, creativeStorageKey } = await seedTenantWithRealData('BackupFull')
    const backupRoot = tmpDir('backup-root')
    const restoreTarget = tmpDir('restore-target')
    // runRestore refuses a non-empty target — mkdtempSync's own dir counts
    // as "exists but empty", which is exactly the case it should allow.

    const backupSummary = await runBackup({ dataDir: config.paths.dataDir, backupRoot })
    expect(backupSummary.tenantsBackedUp).toContain(tenant.tenantId)
    expect(backupSummary.mediaFilesCopied).toBeGreaterThan(0)

    const restoreSummary = await runRestore({ backupRoot, targetDataDir: restoreTarget })
    expect(restoreSummary.tenantsRestored).toContain(tenant.tenantId)

    // 1. PRAGMA integrity_check passes on both restored databases.
    const restoredControlDb = new Database(path.join(restoreTarget, 'control.db'), { readonly: true })
    expect((restoredControlDb.pragma('integrity_check') as any[])[0].integrity_check).toBe('ok')
    restoredControlDb.close()

    const restoredAppDbPath = path.join(restoreTarget, 'tenants', tenant.tenantId, 'app.db')
    const restoredAppDb = new Database(restoredAppDbPath, { readonly: true })
    expect((restoredAppDb.pragma('integrity_check') as any[])[0].integrity_check).toBe('ok')
    restoredAppDb.close()

    // 2. Row counts match the source.
    const sourceAppDbPath = path.join(config.paths.dataDir, 'tenants', tenant.tenantId, 'app.db')
    expect(tenantAppDbCounts(restoredAppDbPath)).toEqual(tenantAppDbCounts(sourceAppDbPath))

    // 3. A spot-checked media file's bytes are byte-identical (hash match).
    const restoredCreativePath = path.join(
      restoreTarget,
      'tenants',
      tenant.tenantId,
      'media',
      'creatives',
      creativeStorageKey
    )
    expect(fs.existsSync(restoredCreativePath)).toBe(true)
    const restoredBytes = fs.readFileSync(restoredCreativePath)
    expect(sha256(restoredBytes)).toBe(sha256(creativeBytes))
  })

  it('a second backup run only copies NEW media files, skipping everything already backed up', async () => {
    await seedTenantWithRealData('BackupIncremental')
    const backupRoot = tmpDir('backup-root-incremental')

    const first = await runBackup({ dataDir: config.paths.dataDir, backupRoot })
    expect(first.mediaFilesCopied).toBeGreaterThan(0)

    const second = await runBackup({ dataDir: config.paths.dataDir, backupRoot })
    expect(second.mediaFilesCopied).toBe(0)
    expect(second.mediaFilesSkipped).toBe(first.mediaFilesCopied)
  })

  it('findLatestSnapshot picks the most recent of several snapshots', async () => {
    await seedTenantWithRealData('BackupLatest')
    const backupRoot = tmpDir('backup-root-latest')

    const first = await runBackup({ dataDir: config.paths.dataDir, backupRoot })
    await new Promise(r => setTimeout(r, 5)) // ensure a different timestamp
    const second = await runBackup({ dataDir: config.paths.dataDir, backupRoot })

    const latest = await findLatestSnapshot(backupRoot)
    expect(path.join(backupRoot, latest!)).toBe(second.snapshotDir)
    expect(latest).not.toBe(path.basename(first.snapshotDir))
  })

  it('restore refuses a non-empty target directory unless forced', async () => {
    await seedTenantWithRealData('BackupRefuse')
    const backupRoot = tmpDir('backup-root-refuse')
    await runBackup({ dataDir: config.paths.dataDir, backupRoot })

    const target = tmpDir('restore-target-refuse')
    fs.writeFileSync(path.join(target, 'something'), 'not empty')

    await expect(runRestore({ backupRoot, targetDataDir: target })).rejects.toThrow('not empty')
    await expect(runRestore({ backupRoot, targetDataDir: target, force: true })).resolves.toBeDefined()
  })

  it('per-tenant export/import moves one tenant to a different server\'s data dir + control.db', async () => {
    const { tenant, creativeBytes, creativeStorageKey } = await seedTenantWithRealData('TenantMove')
    const bundleDir = tmpDir('tenant-bundle')
    await exportTenantBundle({ dataDir: config.paths.dataDir, tenantId: tenant.tenantId, destDir: bundleDir })

    // A separate "other server" — its own fresh data dir and control.db,
    // migrated but with no tenants of its own yet.
    const otherDataDir = tmpDir('other-server-data')
    const { migrateControl } = await import('@/db/migrate')
    const otherControlDb = new Database(path.join(otherDataDir, 'control.db'))
    migrateControl(otherControlDb as any)
    otherControlDb.close()

    const importedTenantId = await importTenantBundle({ dataDir: otherDataDir, bundleDir })
    expect(importedTenantId).toBe(tenant.tenantId)

    // The tenant's control-plane rows now exist on the "other server".
    const otherDb = new Database(path.join(otherDataDir, 'control.db'), { readonly: true })
    const tenantRow = otherDb.prepare('SELECT * FROM tenants WHERE id = ?').get(tenant.tenantId)
    const quotaRow = otherDb.prepare('SELECT * FROM quotas WHERE tenant_id = ?').get(tenant.tenantId)
    const membershipRow = otherDb.prepare('SELECT * FROM memberships WHERE tenant_id = ?').get(tenant.tenantId)
    otherDb.close()
    expect(tenantRow).toBeTruthy()
    expect(quotaRow).toBeTruthy()
    expect(membershipRow).toBeTruthy()

    // Its app.db and media are in place too.
    const otherAppDbPath = path.join(otherDataDir, 'tenants', tenant.tenantId, 'app.db')
    expect(fs.existsSync(otherAppDbPath)).toBe(true)
    const sourceAppDbPath = path.join(config.paths.dataDir, 'tenants', tenant.tenantId, 'app.db')
    expect(tenantAppDbCounts(otherAppDbPath)).toEqual(tenantAppDbCounts(sourceAppDbPath))

    const otherCreativePath = path.join(otherDataDir, 'tenants', tenant.tenantId, 'media', 'creatives', creativeStorageKey)
    expect(sha256(fs.readFileSync(otherCreativePath))).toBe(sha256(creativeBytes))
  })

  it('importTenantBundle refuses a tenant id that already exists on the target server', async () => {
    const { tenant } = await seedTenantWithRealData('TenantMoveConflict')
    const bundleDir = tmpDir('tenant-bundle-conflict')
    await exportTenantBundle({ dataDir: config.paths.dataDir, tenantId: tenant.tenantId, destDir: bundleDir })

    // Import it into the SAME data dir it came from — the tenant id already exists there.
    await expect(importTenantBundle({ dataDir: config.paths.dataDir, bundleDir })).rejects.toThrow('already exists')
  })
})
