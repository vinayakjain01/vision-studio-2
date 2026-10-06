/**
 * Ops utility: cancel every pending/claimed/running job for one tenant and
 * reset any image stuck mid-analysis back to pending.
 *
 *   npx tsx scripts/clear-queue.ts [tenantId]
 *
 * Defaults to the single tenant legacy migration creates when none is
 * given. Goes through `openTenantDbById`/`tenants.list()` rather than its
 * own `new Database(...)` — the previous version (clear-queue.js, a raw JS
 * file) hardcoded `data/vision-studio.db`, the pre-tenancy path, which no
 * longer exists after `npm run tenants:migrate-legacy`; converting it to
 * use the real tenant-resolution path fixes that AND brings it inside the
 * lint guard's allowed-access list instead of needing its own exception.
 */

import { openTenantDbById, closeDb, nowIso } from '../src/db/client'
import { tenants } from '../src/db/control-repositories'

function resolveTenantId(argTenantId: string | undefined): string {
  if (argTenantId) return argTenantId
  const list = tenants.list()
  if (list.length === 0) throw new Error('no tenants exist — run `npm run tenants:migrate-legacy` first')
  if (list.length > 1) {
    throw new Error(
      `${list.length} tenants exist; pass one explicitly: npx tsx scripts/clear-queue.ts <tenantId>\n` +
        list.map(t => `  ${t.id}  (${t.name})`).join('\n')
    )
  }
  return list[0].id
}

function main() {
  const tenantId = resolveTenantId(process.argv[2])
  const db = openTenantDbById(tenantId)
  const now = nowIso()

  db.transaction(() => {
    const jobs = db
      .prepare(
        `UPDATE jobs SET status = 'cancelled', updated_at = ?, completed_at = ?
         WHERE status IN ('pending', 'claimed', 'running')`
      )
      .run(now, now)

    // Images that were mid-analysis go back to 'pending' so they aren't stuck as 'processing'.
    const imgs = db
      .prepare(`UPDATE images SET vision_status = 'pending', updated_at = ? WHERE vision_status = 'processing'`)
      .run(now)

    const batches = db
      .prepare(`UPDATE batches SET status = 'cancelled', updated_at = ? WHERE status IN ('queued', 'running')`)
      .run(now)

    console.log(
      `[${tenantId}] cancelled ${jobs.changes} jobs, reset ${imgs.changes} images, cancelled ${batches.changes} batches`
    )
  })()

  closeDb()
}

main()
