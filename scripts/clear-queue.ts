/**
 * Ops utility: cancel every pending/claimed/running job, and reset any image
 * stuck mid-analysis back to pending — for ONE tenant, or every tenant.
 *
 *   npx tsx scripts/clear-queue.ts            cancel ALL tenants' queues
 *   npx tsx scripts/clear-queue.ts <tenantId>  cancel just that tenant's
 *
 * Rewritten for P3+: jobs live in the SHARED control.db `jobs` table now,
 * not a per-tenant `app.db` table — the previous version of this script
 * still queried the tenant's own database directly, a table that no longer
 * exists there at all post-P3 (silently doing nothing, or erroring, rather
 * than actually clearing a stuck queue).
 */

import { openTenantDbById, closeDb, nowIso } from '../src/db/client'
import { tenants } from '../src/db/control-repositories'
import { cancelAll } from '../src/jobs/queue'

function main() {
  const tenantId = process.argv[2]

  const result = cancelAll(tenantId)
  console.log(
    tenantId
      ? `[${tenantId}] cancelled ${result.cancelled} job(s)`
      : `cancelled ${result.cancelled} job(s) across ${result.tenantsAffected.length} tenant(s)`
  )

  // Images that were mid-analysis go back to 'pending' so they aren't stuck
  // as 'processing' forever with no job left to ever finish them. This part
  // IS still per-tenant app.db, unlike jobs — vision_status lives there.
  const targets = tenantId ? [tenantId] : tenants.list().map(t => t.id)
  const now = nowIso()
  for (const id of targets) {
    const db = openTenantDbById(id)
    const imgs = db
      .prepare(`UPDATE images SET vision_status = 'pending', updated_at = ? WHERE vision_status = 'processing'`)
      .run(now)
    const batches = db
      .prepare(`UPDATE batches SET status = 'cancelled', updated_at = ? WHERE status IN ('queued', 'running')`)
      .run(now)
    if (imgs.changes > 0 || batches.changes > 0) {
      console.log(`  [${id}] reset ${imgs.changes} image(s), cancelled ${batches.changes} batch(es)`)
    }
  }

  closeDb()
}

main()
