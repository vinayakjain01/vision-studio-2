/**
 * Ops utility: cancel every pending/claimed/running job for one tenant and
 * reset any image stuck mid-analysis back to pending.
 *
 *   node scripts/clear-queue.js [tenantId]
 *
 * Defaults to the single tenant legacy migration creates when none is
 * given. Previously hardcoded `data/vision-studio.db` — the pre-tenancy
 * path, which no longer exists after `npm run tenants:migrate-legacy`.
 */
const path = require('path')
const Database = require('better-sqlite3')

function resolveTenantId(argTenantId) {
  if (argTenantId) return argTenantId
  const controlDb = new Database(path.join('data', 'control.db'), { readonly: true })
  const rows = controlDb.prepare('SELECT id, name FROM tenants').all()
  controlDb.close()
  if (rows.length === 0) throw new Error('no tenants exist — run `npm run tenants:migrate-legacy` first')
  if (rows.length > 1) {
    throw new Error(
      `${rows.length} tenants exist; pass one explicitly: node scripts/clear-queue.js <tenantId>\n` +
        rows.map(r => `  ${r.id}  (${r.name})`).join('\n')
    )
  }
  return rows[0].id
}

const tenantId = resolveTenantId(process.argv[2])
const dbPath = path.join('data', 'tenants', tenantId, 'app.db')
const db = new Database(dbPath)
const now = new Date().toISOString()

const tx = db.transaction(() => {
  const jobs = db.prepare(`
    UPDATE jobs SET status = 'cancelled', updated_at = ?, completed_at = ?
    WHERE status IN ('pending', 'claimed', 'running')
  `).run(now, now)

  // Images that were mid-analysis go back to 'pending' so they aren't stuck as 'processing'
  const imgs = db.prepare(`
    UPDATE images SET vision_status = 'pending', updated_at = ?
    WHERE vision_status = 'processing'
  `).run(now)

  const batches = db.prepare(`
    UPDATE batches SET status = 'cancelled', updated_at = ?
    WHERE status IN ('queued', 'running')
  `).run(now)

  console.log(
    `[${tenantId}] cancelled ${jobs.changes} jobs, reset ${imgs.changes} images, cancelled ${batches.changes} batches`
  )
})
tx()
db.close()
