/**
 * Phase 1.7 (docs/ISSUES.md — the fix-issues program's final Phase 1 item):
 * the soak test the spec calls for — 3 users x 100 images, sustained — at
 * the confirmed production LIVE SETTINGS, with real ONNX vision, real
 * render compositing, and Cloudinary mocked at a realistic (default 12s)
 * latency. Verifies, at the end:
 *   1. No job left in a non-terminal status (pending/claimed/running) for
 *      any of the 3 tenants.
 *   2. Memory stayed flat across the run (no unbounded growth).
 *   3. Every tenant's `running_jobs` counter is back to zero.
 *
 * In-process pool (not a spawned HTTP server) — this phase is about queue
 * health and memory over a sustained run, not web latency (Phase 1.6's
 * job), so the simpler in-process harness is the right tool.
 *
 *   npx tsx scripts/soak-test-phase17.ts
 *   npx tsx scripts/soak-test-phase17.ts --images=100 --ai-extend-latency=12000
 *
 * ALWAYS runs against a fresh temp directory, never the real data/ dir.
 */

import os from 'os'
import fs from 'fs'
import path from 'path'

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-soak-'))
process.env.VISION_STUDIO_DATA_DIR = tmpDataDir
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'soak-admin@loadtest.local'
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Loadtest-Password-1'
process.env.ALLOW_MULTI_TENANT_PREVIEW = '1'
process.env.VISION_STUDIO_LOADTEST_MOCK_AI_EXTEND = '1'
;(process.env as any).NODE_ENV = process.env.NODE_ENV || 'production'

// ── LIVE SETTINGS — confirmed on the production box, docs/ISSUES.md.
process.env.JOB_VISION_CONCURRENCY = process.env.JOB_VISION_CONCURRENCY || '1'
process.env.JOB_RENDER_CONCURRENCY = process.env.JOB_RENDER_CONCURRENCY || '1'
process.env.VISION_ORT_THREADS = process.env.VISION_ORT_THREADS || '3'
process.env.CLOUDINARY_JOB_CONCURRENCY = process.env.CLOUDINARY_JOB_CONCURRENCY || '4'
process.env.AI_EXTEND_PER_TENANT_CONCURRENCY = process.env.AI_EXTEND_PER_TENANT_CONCURRENCY || '2'

function parseArgs(argv: string[]) {
  let imagesPerUser = 100
  let latencyMs = 12000
  let userCount = 3
  for (const arg of argv) {
    if (arg.startsWith('--images=')) imagesPerUser = Number(arg.slice('--images='.length))
    else if (arg.startsWith('--ai-extend-latency=')) latencyMs = Number(arg.slice('--ai-extend-latency='.length))
    else if (arg.startsWith('--users=')) userCount = Number(arg.slice('--users='.length))
  }
  return { imagesPerUser, latencyMs, userCount }
}
const { imagesPerUser, latencyMs, userCount } = parseArgs(process.argv.slice(2))
process.env.VISION_STUDIO_LOADTEST_AI_EXTEND_LATENCY_MS = String(latencyMs)

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main() {
  const { migrateControl } = await import('@/db/migrate')
  const { getControlDb, closeDb } = await import('@/db/client')
  const { getPool } = await import('@/jobs/pool')
  const { generateFixturePhotos, importFixturePhotos, createLoadTestTenant, cleanupDir } = await import(
    './lib/loadtest-fixtures'
  )
  const { runWithTenant } = await import('@/tenancy/context')
  const { startBatch } = await import('@/services/generation-service')

  console.log(
    `[soak] Phase 1.7 soak test — users=${userCount} imagesPerUser=${imagesPerUser} aiExtendLatencyMs=${latencyMs} data dir=${tmpDataDir}`
  )
  migrateControl(getControlDb())

  const fixtureDir = path.join(tmpDataDir, '_fixtures')
  const fixturePaths = await generateFixturePhotos(fixtureDir, Math.min(imagesPerUser, 50))

  const pool = getPool()
  pool.start()
  console.log('[soak] warming up workers (model load)...')
  await sleep(15_000)

  // ── Memory sampling for the whole run ─────────────────────────────────────
  const rssSamples: { atMs: number; rssMb: number }[] = []
  const soakStart = Date.now()
  const memoryTimer = setInterval(() => {
    rssSamples.push({ atMs: Date.now() - soakStart, rssMb: process.memoryUsage().rss / 1024 / 1024 })
  }, 15_000)
  memoryTimer.unref()

  const tenants = await Promise.all(
    Array.from({ length: userCount }, (_, i) => createLoadTestTenant(`Soak-User${i + 1}`, { maxQueuedJobs: imagesPerUser + 50 }))
  )

  const imports = await Promise.all(tenants.map(t => importFixturePhotos(t, fixturePaths, imagesPerUser)))

  async function waitForVisionDrain(tenantId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const row = getControlDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM jobs WHERE tenant_id = ? AND kind = 'vision' AND status IN ('pending','claimed','running')`
        )
        .get(tenantId) as { n: number }
      if (row.n === 0) return
      await sleep(1000)
    }
    console.warn(`[soak] tenant ${tenantId}: vision did not drain within ${timeoutMs}ms`)
  }

  console.log('[soak] waiting for vision analysis to drain for every user...')
  await Promise.all(tenants.map(t => waitForVisionDrain(t.tenantId, 15 * 60_000)))

  console.log('[soak] starting generation batches for every user...')
  const batchResults = tenants.map((t, i) =>
    runWithTenant({ tenantId: t.tenantId, userId: t.userId, role: 'owner' }, () =>
      startBatch(`soak-${t.name}`, { importId: imports[i].importId, allImages: true, templateId: t.templateId })
    )
  )
  for (const [i, result] of batchResults.entries()) {
    console.log(`[soak] ${tenants[i].name}: queued ${result.queued} render job(s)`)
  }

  function allJobsDone(tenantIds: string[]): boolean {
    const db = getControlDb()
    const placeholders = tenantIds.map(() => '?').join(',')
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE tenant_id IN (${placeholders}) AND status IN ('pending','claimed','running')`)
      .get(...tenantIds) as { n: number }
    return row.n === 0
  }

  const tenantIds = tenants.map(t => t.tenantId)
  const deadline = Date.now() + 60 * 60_000 // generous outer cap — this is a soak test, not a throughput benchmark
  let drained = false
  let lastProgressLog = 0
  while (Date.now() < deadline) {
    if (allJobsDone(tenantIds)) {
      drained = true
      break
    }
    if (Date.now() - lastProgressLog > 60_000) {
      lastProgressLog = Date.now()
      const db = getControlDb()
      const placeholders = tenantIds.map(() => '?').join(',')
      const completed = (
        db
          .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE tenant_id IN (${placeholders}) AND status = 'completed'`)
          .get(...tenantIds) as { n: number }
      ).n
      const total = tenantIds.length * imagesPerUser * 2 // vision + render per image, rough denominator for a progress indicator only
      console.log(
        `[soak] progress: ${completed} jobs completed (~${((completed / total) * 100).toFixed(0)}%), ` +
          `${Math.round((Date.now() - soakStart) / 1000)}s elapsed`
      )
    }
    await sleep(2000)
  }

  clearInterval(memoryTimer)

  // ── Verification ──────────────────────────────────────────────────────────
  const db = getControlDb()
  const placeholders = tenantIds.map(() => '?').join(',')

  const stuckJobs = db
    .prepare(
      `SELECT id, tenant_id, kind, status FROM jobs WHERE tenant_id IN (${placeholders}) AND status IN ('pending','claimed','running')`
    )
    .all(...tenantIds) as { id: string; tenant_id: string; kind: string; status: string }[]

  const corruptCompletions = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM jobs WHERE tenant_id IN (${placeholders}) AND status = 'completed' AND error IS NOT NULL`
      )
      .get(...tenantIds) as { n: number }
  ).n

  const runningJobsCounters = tenantIds.map(tid => {
    const row = db.prepare(`SELECT running_jobs FROM tenant_queue_state WHERE tenant_id = ?`).get(tid) as
      | { running_jobs: number }
      | undefined
    return { tenantId: tid, runningJobs: row?.running_jobs ?? -1 }
  })

  let memoryGrowthPct = 0
  if (rssSamples.length > 1) {
    const rssValues = rssSamples.map(s => s.rssMb)
    const minMb = Math.min(...rssValues)
    const maxMb = Math.max(...rssValues)
    memoryGrowthPct = ((maxMb - minMb) / minMb) * 100
  }

  const elapsedMin = (Date.now() - soakStart) / 60_000

  console.log('\n[soak] === RESULTS ===')
  console.log(`elapsed: ${elapsedMin.toFixed(1)} minutes`)
  console.log(`drained before outer timeout: ${drained}`)
  console.log(`stuck jobs (non-terminal at end): ${stuckJobs.length}`)
  if (stuckJobs.length > 0) {
    console.log(`  ${JSON.stringify(stuckJobs.slice(0, 10))}`)
  }
  console.log(`completed jobs with a non-null error (corrupt result): ${corruptCompletions}`)
  console.log(`running_jobs counters at end: ${JSON.stringify(runningJobsCounters)}`)
  console.log(
    `memory: min=${Math.min(...rssSamples.map(s => s.rssMb)).toFixed(0)}MB max=${Math.max(...rssSamples.map(s => s.rssMb)).toFixed(0)}MB growth=${memoryGrowthPct.toFixed(1)}% (${rssSamples.length} samples)`
  )

  const allCountersZero = runningJobsCounters.every(c => c.runningJobs === 0)
  const pass = drained && stuckJobs.length === 0 && corruptCompletions === 0 && allCountersZero && memoryGrowthPct < 50

  console.log(`\n[soak] PASS/FAIL targets:`)
  console.log(`  [${drained ? 'PASS' : 'FAIL'}] drained within the outer timeout`)
  console.log(`  [${stuckJobs.length === 0 ? 'PASS' : 'FAIL'}] no stuck jobs — ${stuckJobs.length} found`)
  console.log(`  [${corruptCompletions === 0 ? 'PASS' : 'FAIL'}] no corrupt completions — ${corruptCompletions} found`)
  console.log(`  [${allCountersZero ? 'PASS' : 'FAIL'}] every tenant's running_jobs counter is zero`)
  console.log(`  [${memoryGrowthPct < 50 ? 'PASS' : 'FAIL'}] memory growth under 50% — ${memoryGrowthPct.toFixed(1)}%`)
  console.log(`\n[soak] OVERALL: ${pass ? 'PASS' : 'FAIL'}`)

  await pool.stop()
  closeDb()
  cleanupDir(tmpDataDir)

  process.exit(pass ? 0 : 1)
}

main().catch(err => {
  console.error('[soak] fatal:', err)
  fs.rmSync(tmpDataDir, { recursive: true, force: true })
  process.exit(1)
})
