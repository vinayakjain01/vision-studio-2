/**
 * Extracted from scripts/tenants-migrate-legacy.ts purely so it can be
 * imported by tests — that script calls its own `main()` unconditionally at
 * module load (including `process.exit()` on a missing `--i-have-a-backup`
 * flag), so importing it directly anywhere else, including a test, would
 * run the real migration and exit the process. This file has no such
 * side effect.
 */

import type Database from 'better-sqlite3'

/**
 * Copies a tenant's pre-P3 `jobs` rows (still sitting in its app.db — P3
 * never drops that table, see schema.sql's module doc) into control.db's
 * now-global `jobs` table, stamped with `tenant_id`. Idempotent: `INSERT OR
 * IGNORE` keyed by the job's own id, which survives the copy unchanged, so
 * re-running this script never double-inserts.
 *
 * Completed/failed/cancelled rows are preserved as-is — batch progress
 * (`batches.completed_jobs` etc.) was computed from them historically and
 * must keep reading the same numbers. Pending/claimed/running rows are
 * reset to 'pending' with their worker/lease fields cleared: whatever
 * worker held one is long gone (this script only runs once, offline, never
 * concurrently with a live pool), so there is nothing valid to preserve
 * about who was running it or when its lease was due.
 *
 * `priority_class` is inferred from the legacy numeric `priority` this
 * tenant's rows already carry (0/1 = someone was watching — an ad-hoc
 * render or single-image reanalyze; 10/20/50 = bulk import analysis or
 * batch renders — see generation-service.ts/import-service.ts's own
 * priority choices, unchanged by P3). Only matters for rows reset to
 * 'pending' above, since those are the only ones that will ever be
 * scheduled again.
 */
export function migrateTenantJobs(
  tenantId: string,
  tenantDb: Database.Database,
  controlDb: Database.Database
): { copied: number; legacyCount: number } {
  const hasJobsTable = tenantDb
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'jobs'")
    .get()
  if (!hasJobsTable) return { copied: 0, legacyCount: 0 }

  const legacyJobs = tenantDb.prepare('SELECT * FROM jobs').all() as any[]
  if (legacyJobs.length === 0) return { copied: 0, legacyCount: 0 }

  const insert = controlDb.prepare(
    `INSERT OR IGNORE INTO jobs (
       id, tenant_id, kind, priority_class, status, priority, batch_id, dedupe_key, payload,
       attempts, max_attempts, worker_id, claimed_at, lease_expires_at, heartbeat_at, available_at,
       error, result, created_at, started_at, updated_at, completed_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )

  const liveStatuses = new Set(['pending', 'claimed', 'running'])
  let copied = 0

  for (const row of legacyJobs) {
    const wasLive = liveStatuses.has(row.status)
    const priorityClass = row.priority <= 1 ? 'interactive' : 'bulk'

    const info = insert.run(
      row.id,
      tenantId,
      row.kind,
      priorityClass,
      wasLive ? 'pending' : row.status,
      row.priority,
      row.batch_id,
      row.dedupe_key,
      row.payload,
      row.attempts,
      row.max_attempts,
      wasLive ? null : row.worker_id,
      wasLive ? null : row.claimed_at,
      null, // lease_expires_at — fresh lease assigned at next real claim
      wasLive ? null : row.heartbeat_at,
      wasLive ? null : row.available_at,
      row.error,
      row.result,
      row.created_at,
      null, // started_at — column didn't exist pre-P3; unknown for historical rows
      row.updated_at,
      row.completed_at
    )
    if (info.changes > 0) copied++
  }

  return { copied, legacyCount: legacyJobs.length }
}
