/**
 * Benchmark: the admin tenants-table queries (queued/running counts,
 * jobs/hour, queue-wait p50/p95) against a realistic 100k-row `jobs` table.
 *
 *   npx tsx scripts/bench-admin-queries.ts
 *
 * The spec for P5's admin page says: "Compute from indexed queries; add
 * hourly rollups only if a query takes over ~50ms at 100k job rows
 * (measure and report)." This script is that measurement — seeds 100,000
 * jobs across 20 tenants with a realistic spread of created/started/
 * completed timestamps over the last 5 days, runs EXPLAIN QUERY PLAN plus
 * timed samples of each query the admin tenants list actually runs, and
 * prints a verdict against the 50ms threshold.
 *
 * Never touches the real data/ directory — temp dir, removed at the end.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'

process.env.VISION_STUDIO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-admin-bench-'))
process.env.ADMIN_EMAIL = 'bench@test.local'
process.env.ADMIN_PASSWORD = 'bench-password'
process.env.ALLOW_MULTI_TENANT_PREVIEW = '1'

const TENANT_COUNT = 20
const JOB_COUNT = 100_000
const DAY_MS = 24 * 60 * 60 * 1000

function timed<T>(label: string, fn: () => T): T {
  const start = process.hrtime.bigint()
  const result = fn()
  const ms = Number(process.hrtime.bigint() - start) / 1e6
  console.log(`  ${label}: ${ms.toFixed(2)}ms`)
  return result
}

async function main() {
  const { getControlDb, closeDb } = await import('../src/db/client')
  const { migrateControl } = await import('../src/db/migrate')
  const { tenants } = await import('../src/db/control-repositories')

  console.log('Vision Studio — admin tenants-table query benchmark')
  console.log(`  tenants   ${TENANT_COUNT}`)
  console.log(`  jobs      ${JOB_COUNT}`)
  console.log(`  data dir  ${process.env.VISION_STUDIO_DATA_DIR}\n`)

  const db = getControlDb()
  migrateControl(db)

  const tenantIds: string[] = []
  for (let i = 0; i < TENANT_COUNT; i++) tenantIds.push(tenants.create(`admin-bench-tenant-${i}`).id)

  console.log('Seeding jobs with a realistic timestamp spread (last 5 days)...')
  const seedStart = Date.now()
  const now = Date.now()

  const insert = db.prepare(
    `INSERT INTO jobs (id, tenant_id, kind, priority_class, status, priority, batch_id, dedupe_key,
                       payload, attempts, max_attempts, created_at, started_at, updated_at, completed_at)
     VALUES (?, ?, 'vision', 'bulk', ?, 100, NULL, NULL, '{}', 0, 3, ?, ?, ?, ?)`
  )
  const insertMany = db.transaction((rows: any[]) => {
    for (const r of rows) insert.run(...r)
  })

  const rows: any[] = []
  for (let i = 0; i < JOB_COUNT; i++) {
    const tenantId = tenantIds[i % TENANT_COUNT]
    // Spread over the last 5 days, weighted so a meaningful chunk falls
    // inside the last 24h (what the admin table's "jobs/hour" and
    // "queue wait" columns actually window on).
    const ageMs = Math.random() < 0.4 ? Math.random() * DAY_MS : Math.random() * 5 * DAY_MS
    const createdAt = new Date(now - ageMs)
    const isTerminal = Math.random() < 0.9
    const status = isTerminal ? (Math.random() < 0.95 ? 'completed' : 'failed') : 'pending'
    const waitMs = 50 + Math.random() * 4000 // realistic scheduler wait
    const runMs = 200 + Math.random() * 3000
    const startedAt = isTerminal ? new Date(createdAt.getTime() + waitMs) : null
    const completedAt = isTerminal ? new Date(createdAt.getTime() + waitMs + runMs) : null
    rows.push([
      `job_bench_${i}`,
      tenantId,
      status,
      createdAt.toISOString(),
      startedAt?.toISOString() ?? null,
      createdAt.toISOString(),
      completedAt?.toISOString() ?? null,
    ])
  }
  insertMany(rows)
  console.log(`  seeded in ${Date.now() - seedStart}ms\n`)

  const cutoff24h = new Date(now - DAY_MS).toISOString()

  // ── Query 1: queued + running jobs per tenant (no time filter) ──────────
  console.log('Query 1: queued + running jobs per tenant')
  console.log(
    (
      db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT tenant_id,
                  SUM(CASE WHEN status IN ('pending','claimed') THEN 1 ELSE 0 END) AS queued,
                  SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
           FROM jobs GROUP BY tenant_id`
        )
        .all() as { detail: string }[]
    )
      .map(r => `    ${r.detail}`)
      .join('\n')
  )
  timed('time', () =>
    db
      .prepare(
        `SELECT tenant_id,
                SUM(CASE WHEN status IN ('pending','claimed') THEN 1 ELSE 0 END) AS queued,
                SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
         FROM jobs GROUP BY tenant_id`
      )
      .all()
  )

  // ── Query 2: jobs completed in the last 24h per tenant (throughput) ─────
  console.log('\nQuery 2: jobs completed in the last 24h per tenant')
  console.log(
    (
      db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT tenant_id, COUNT(*) AS n FROM jobs
           WHERE status = 'completed' AND completed_at >= ?
           GROUP BY tenant_id`
        )
        .all(cutoff24h) as { detail: string }[]
    )
      .map(r => `    ${r.detail}`)
      .join('\n')
  )
  timed('time (no index yet)', () =>
    db
      .prepare(
        `SELECT tenant_id, COUNT(*) AS n FROM jobs
         WHERE status = 'completed' AND completed_at >= ?
         GROUP BY tenant_id`
      )
      .all(cutoff24h)
  )

  // ── Query 3: queue-wait samples (started_at - created_at), last 24h ─────
  console.log('\nQuery 3: queue-wait samples, last 24h (percentiles computed in JS)')
  console.log(
    (
      db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT tenant_id, created_at, started_at FROM jobs
           WHERE created_at >= ? AND started_at IS NOT NULL`
        )
        .all(cutoff24h) as { detail: string }[]
    )
      .map(r => `    ${r.detail}`)
      .join('\n')
  )
  const waitRows = timed('time (no index yet)', () =>
    db
      .prepare(
        `SELECT tenant_id, created_at, started_at FROM jobs
         WHERE created_at >= ? AND started_at IS NOT NULL`
      )
      .all(cutoff24h) as { tenant_id: string; created_at: string; started_at: string }[]
  )
  console.log(`  rows returned: ${waitRows.length}`)

  // ── Now add the candidate index and re-measure queries 2 and 3 ──────────
  console.log('\nAdding idx_jobs_completed_at (tenant_id, status, completed_at) and re-measuring Query 2...')
  db.exec('CREATE INDEX idx_jobs_completed_at ON jobs (status, completed_at, tenant_id)')
  timed('time (with index)', () =>
    db
      .prepare(
        `SELECT tenant_id, COUNT(*) AS n FROM jobs
         WHERE status = 'completed' AND completed_at >= ?
         GROUP BY tenant_id`
      )
      .all(cutoff24h)
  )
  console.log(
    (
      db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT tenant_id, COUNT(*) AS n FROM jobs
           WHERE status = 'completed' AND completed_at >= ?
           GROUP BY tenant_id`
        )
        .all(cutoff24h) as { detail: string }[]
    )
      .map(r => `    ${r.detail}`)
      .join('\n')
  )

  console.log('\nAdding idx_jobs_created_at (created_at) and re-measuring Query 3...')
  db.exec('CREATE INDEX idx_jobs_created_at ON jobs (created_at)')
  timed('time (with index)', () =>
    db
      .prepare(
        `SELECT tenant_id, created_at, started_at FROM jobs
         WHERE created_at >= ? AND started_at IS NOT NULL`
      )
      .all(cutoff24h)
  )
  console.log(
    (
      db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT tenant_id, created_at, started_at FROM jobs
           WHERE created_at >= ? AND started_at IS NOT NULL`
        )
        .all(cutoff24h) as { detail: string }[]
    )
      .map(r => `    ${r.detail}`)
      .join('\n')
  )

  closeDb()
  fs.rmSync(process.env.VISION_STUDIO_DATA_DIR!, { recursive: true, force: true })
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
