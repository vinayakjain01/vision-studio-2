/**
 * Benchmark: queue.claim() latency with a large, realistic queue.
 *
 *   npx tsx scripts/bench-claim.ts
 *
 * Seeds 100,000 pending jobs across 20 tenants directly into a TEMP
 * control.db (never the real data/ directory), runs EXPLAIN QUERY PLAN
 * against the per-tenant probe query claim() actually uses, then calls
 * claim() 2,000 times and reports p50/p95/p99 — see docs/MULTI_TENANCY.md
 * §3.2 and src/jobs/queue.ts's claim()/claimCandidate() doc comments for
 * why the design is "probe each tenant via an index seek" rather than one
 * cross-tenant scan: this script is what verifies that design actually
 * delivers flat latency as the table grows, not just that it should in
 * theory.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'

process.env.VISION_STUDIO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-bench-'))
process.env.ADMIN_EMAIL = 'bench@test.local'
process.env.ADMIN_PASSWORD = 'bench-password'
process.env.ALLOW_MULTI_TENANT_PREVIEW = '1'

async function main() {
  const { getControlDb, closeDb } = await import('../src/db/client')
  const { migrateControl } = await import('../src/db/migrate')
  const { tenants } = await import('../src/db/control-repositories')
  const queue = await import('../src/jobs/queue')

  const TENANT_COUNT = 20
  const JOBS_PER_TENANT = 5_000 // 20 * 5,000 = 100,000
  const CLAIM_SAMPLES = 2_000

  console.log('Vision Studio — claim() benchmark')
  console.log(`  tenants           ${TENANT_COUNT}`)
  console.log(`  jobs/tenant       ${JOBS_PER_TENANT}`)
  console.log(`  total pending     ${TENANT_COUNT * JOBS_PER_TENANT}`)
  console.log(`  data dir          ${process.env.VISION_STUDIO_DATA_DIR}\n`)

  const db = getControlDb()
  migrateControl(db)

  console.log('Seeding tenants...')
  const tenantIds: string[] = []
  for (let i = 0; i < TENANT_COUNT; i++) {
    tenantIds.push(tenants.create(`bench-tenant-${i}`).id)
  }

  console.log('Seeding jobs (one big transaction per tenant)...')
  const seedStart = Date.now()
  for (const tenantId of tenantIds) {
    queue.enqueue(
      tenantId,
      Array.from({ length: JOBS_PER_TENANT }, (_, i) => ({
        kind: 'vision' as const,
        payload: { imageId: `img-${i}`, sourceHash: `hash-${tenantId}-${i}`, storageKey: 'k' },
      }))
    )
  }
  console.log(`  seeded in ${Date.now() - seedStart}ms\n`)

  console.log('EXPLAIN QUERY PLAN — per-tenant probe (the query claimCandidate() runs once per candidate tenant):')
  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT id FROM jobs
       WHERE tenant_id = ? AND kind = ? AND status = 'pending' AND priority_class = ?
         AND (available_at IS NULL OR available_at <= ?)
       ORDER BY priority ASC, created_at ASC
       LIMIT 1`
    )
    .all(tenantIds[0], 'vision', 'bulk', new Date().toISOString()) as { detail: string }[]
  for (const row of plan) console.log(`  ${row.detail}`)
  const usesScan = plan.some(row => /SCAN jobs\b/.test(row.detail) && !/USING INDEX/.test(row.detail))
  console.log(usesScan ? '  ✗ FULL TABLE SCAN DETECTED\n' : '  ✓ no full table scan\n')

  console.log(`Sampling claim() latency (${CLAIM_SAMPLES} calls)...`)
  const samples: number[] = []
  for (let i = 0; i < CLAIM_SAMPLES; i++) {
    const start = process.hrtime.bigint()
    const job = queue.claim('vision', `bench-worker-${i % 8}`)
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6
    samples.push(elapsedMs)
    if (!job) {
      console.warn(`  ran out of pending jobs at sample ${i}`)
      break
    }
  }

  samples.sort((a, b) => a - b)
  const pct = (p: number) => samples[Math.min(samples.length - 1, Math.floor((p / 100) * samples.length))]
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length

  console.log('\nResults:')
  console.log(`  samples   ${samples.length}`)
  console.log(`  mean      ${mean.toFixed(3)}ms`)
  console.log(`  p50       ${pct(50).toFixed(3)}ms`)
  console.log(`  p95       ${pct(95).toFixed(3)}ms`)
  console.log(`  p99       ${pct(99).toFixed(3)}ms`)
  console.log(`  max       ${samples[samples.length - 1].toFixed(3)}ms`)

  const p95 = pct(95)
  console.log(p95 < 5 ? `\n✓ p95 ${p95.toFixed(3)}ms is under the 5ms target` : `\n✗ p95 ${p95.toFixed(3)}ms EXCEEDS the 5ms target`)

  closeDb()
  fs.rmSync(process.env.VISION_STUDIO_DATA_DIR!, { recursive: true, force: true })
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
