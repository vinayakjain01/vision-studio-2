/**
 * Phase 1.3 (docs/ISSUES.md, issue 4 — "30 images / 15 minutes"):
 * reproduces the slow-batch report end to end on a fresh tenant, at the
 * PRODUCTION BOX'S CONFIRMED LIVE SETTINGS (`JOB_VISION_CONCURRENCY=1`,
 * `JOB_RENDER_CONCURRENCY=1`, `VISION_ORT_THREADS=3`,
 * `CLOUDINARY_JOB_CONCURRENCY=4`, `AI_EXTEND_PER_TENANT_CONCURRENCY=2`),
 * with ONLY the Cloudinary generative-fill call mocked (realistic,
 * configurable latency + occasional 429s — see
 * `src/jobs/loadtest-mock-ai-extend.ts`). Vision analysis and render
 * compositing run for real (real ONNX, real sharp), same as
 * `scripts/loadtest-multitenant.ts --mode=real`.
 *
 * Measures three phases separately so issue 4's "where does ~30s/image go"
 * question has a real answer instead of a guess:
 *   1. vision-analysis-only (no render triggered)
 *   2. render WITHOUT ai_extend (a `solid`-background template — isolates
 *      render/encode cost from the AI Extend wait entirely)
 *   3. render WITH ai_extend (the default template — the actual reported
 *      slow path)
 *
 * Per-image/per-job detail comes from the `[stage]` log lines Phase 1.2's
 * `logStageTiming()` already emits from every worker process — workers run
 * with `stdio: 'inherit'` (see `src/jobs/pool.ts`), so those lines land in
 * THIS process's own stdout, interleaved with the `[repro]` lines below.
 * Run this redirected to a file, then feed that file to
 * `scripts/parse-stage-log.ts` for the per-image timeline:
 *
 *   npx tsx scripts/reproduce-issue4-slow-batch.ts > /tmp/repro-issue4.log 2>&1
 *   npx tsx scripts/parse-stage-log.ts /tmp/repro-issue4.log
 *
 * Flags:
 *   --images=30             number of photos per phase (default 30, per the report)
 *   --ai-extend-latency=12000   mocked Cloudinary latency in ms (default 12000)
 *
 * ALWAYS runs against a fresh temp directory, never the real data/ dir —
 * same isolation as loadtest-multitenant.ts.
 */

import os from 'os'
import fs from 'fs'
import path from 'path'

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-repro-issue4-'))
process.env.VISION_STUDIO_DATA_DIR = tmpDataDir
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'repro-admin@loadtest.local'
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Loadtest-Password-1'
process.env.ALLOW_MULTI_TENANT_PREVIEW = '1'
process.env.VISION_STUDIO_LOADTEST_MOCK_AI_EXTEND = '1'
;(process.env as any).NODE_ENV = process.env.NODE_ENV || 'production'

// ── LIVE SETTINGS — confirmed on the production box, docs/ISSUES.md line 22-26.
//    Only applied if not already set, so an operator can override on the
//    command line to sweep a specific hypothesis (e.g. JOB_RENDER_CONCURRENCY=2).
process.env.JOB_VISION_CONCURRENCY = process.env.JOB_VISION_CONCURRENCY || '1'
process.env.JOB_RENDER_CONCURRENCY = process.env.JOB_RENDER_CONCURRENCY || '1'
process.env.VISION_ORT_THREADS = process.env.VISION_ORT_THREADS || '3'
process.env.CLOUDINARY_JOB_CONCURRENCY = process.env.CLOUDINARY_JOB_CONCURRENCY || '4'
process.env.AI_EXTEND_PER_TENANT_CONCURRENCY = process.env.AI_EXTEND_PER_TENANT_CONCURRENCY || '2'

function parseArgs(argv: string[]) {
  let imageCount = 30
  let latencyMs = 12000
  for (const arg of argv) {
    if (arg.startsWith('--images=')) imageCount = Number(arg.slice('--images='.length))
    else if (arg.startsWith('--ai-extend-latency=')) latencyMs = Number(arg.slice('--ai-extend-latency='.length))
  }
  return { imageCount, latencyMs }
}
const { imageCount, latencyMs } = parseArgs(process.argv.slice(2))
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
  const { templates } = await import('@/db/repositories')
  const { createDefaultTemplate } = await import('@/templates/types')
  const { startBatch } = await import('@/services/generation-service')

  console.log(
    `[repro] issue 4 reproduction — images=${imageCount} aiExtendLatencyMs=${latencyMs} data dir=${tmpDataDir}`
  )
  console.log(
    `[repro] live settings: JOB_VISION_CONCURRENCY=${process.env.JOB_VISION_CONCURRENCY} JOB_RENDER_CONCURRENCY=${process.env.JOB_RENDER_CONCURRENCY} VISION_ORT_THREADS=${process.env.VISION_ORT_THREADS} CLOUDINARY_JOB_CONCURRENCY=${process.env.CLOUDINARY_JOB_CONCURRENCY} AI_EXTEND_PER_TENANT_CONCURRENCY=${process.env.AI_EXTEND_PER_TENANT_CONCURRENCY}`
  )
  migrateControl(getControlDb())

  const fixtureDir = path.join(tmpDataDir, '_fixtures')
  const fixturePaths = await generateFixturePhotos(fixtureDir, Math.min(imageCount, 50))

  const pool = getPool()
  pool.start()
  // Real mode needs real ONNX model load + worker spin-up before the first
  // phase's clock starts, or phase 1 pays a one-time cold-start cost no
  // later phase does (same reasoning as loadtest-multitenant.ts).
  console.log('[repro] warming up workers (model load)...')
  await sleep(15_000)

  async function waitForBatchDrain(tenantId: string, timeoutMs: number, pollMs = 500): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const row = getControlDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM jobs WHERE tenant_id = ? AND status IN ('pending','claimed','running')`
        )
        .get(tenantId) as { n: number }
      if (row.n === 0) return true
      await sleep(pollMs)
    }
    return false
  }

  function countCompleted(tenantId: string, kind?: string): number {
    const db = getControlDb()
    const row = kind
      ? (db
          .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE tenant_id = ? AND kind = ? AND status = 'completed'`)
          .get(tenantId, kind) as { n: number })
      : (db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE tenant_id = ? AND status = 'completed'`).get(tenantId) as {
          n: number
        })
    return row.n
  }

  function countFailed(tenantId: string): number {
    const row = getControlDb()
      .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE tenant_id = ? AND status = 'failed'`)
      .get(tenantId) as { n: number }
    return row.n
  }

  const report: Record<string, unknown> = {}

  // ── Phase A: vision-analysis-only ─────────────────────────────────────────
  console.log(`\n[repro] === Phase A: vision-analysis-only (${imageCount} images) ===`)
  const tenantA = await createLoadTestTenant('ReproIssue4-Vision', { maxQueuedJobs: imageCount + 20 })
  const visionStart = Date.now()
  const { importId: importIdA } = await importFixturePhotos(tenantA, fixturePaths, imageCount)
  const visionDrained = await waitForBatchDrain(tenantA.tenantId, 20 * 60_000)
  const visionElapsedMs = Date.now() - visionStart
  const visionCompleted = countCompleted(tenantA.tenantId, 'vision')
  report.phaseA = {
    imageCount,
    importId: importIdA,
    drained: visionDrained,
    completed: visionCompleted,
    failed: countFailed(tenantA.tenantId),
    elapsedMs: visionElapsedMs,
    imagesPerMinute: (visionCompleted / visionElapsedMs) * 60_000,
  }
  console.log(`[repro] Phase A: ${visionCompleted}/${imageCount} vision jobs in ${(visionElapsedMs / 1000).toFixed(1)}s (${((visionCompleted / visionElapsedMs) * 60_000).toFixed(1)} img/min)`)

  // ── Phase B: render WITHOUT ai_extend (isolates render/encode cost) ──────
  console.log(`\n[repro] === Phase B: render WITHOUT ai_extend (${imageCount} images) ===`)
  const tenantB = await createLoadTestTenant('ReproIssue4-RenderSolid', { maxQueuedJobs: imageCount + 20 })
  const { importId: importIdB } = await importFixturePhotos(tenantB, fixturePaths, imageCount)
  await waitForBatchDrain(tenantB.tenantId, 20 * 60_000) // drain vision first — render needs visionReady

  const solidTemplateId = runWithTenant(
    { tenantId: tenantB.tenantId, userId: tenantB.userId, role: 'owner' },
    () => {
      const doc = createDefaultTemplate('4:5')
      doc.background = { ...doc.background, mode: 'solid' }
      return templates.create({ name: 'Repro — solid background', document: doc }).id
    }
  )

  const renderNoAiStart = Date.now()
  const renderNoAiResult = runWithTenant({ tenantId: tenantB.tenantId, userId: tenantB.userId, role: 'owner' }, () =>
    startBatch('repro-render-solid', { importId: importIdB, allImages: true, templateId: solidTemplateId })
  )
  const renderNoAiDrained = await waitForBatchDrain(tenantB.tenantId, 20 * 60_000)
  const renderNoAiElapsedMs = Date.now() - renderNoAiStart
  const renderNoAiCompleted = countCompleted(tenantB.tenantId, 'render')
  report.phaseB = {
    imageCount,
    queued: renderNoAiResult.queued,
    drained: renderNoAiDrained,
    completed: renderNoAiCompleted,
    failed: countFailed(tenantB.tenantId),
    elapsedMs: renderNoAiElapsedMs,
    imagesPerMinute: (renderNoAiCompleted / renderNoAiElapsedMs) * 60_000,
  }
  console.log(`[repro] Phase B: ${renderNoAiCompleted}/${renderNoAiResult.queued} render jobs (no AI Extend) in ${(renderNoAiElapsedMs / 1000).toFixed(1)}s (${((renderNoAiCompleted / renderNoAiElapsedMs) * 60_000).toFixed(1)} img/min)`)

  // ── Phase C: render WITH ai_extend (the actual reported slow path) ───────
  console.log(`\n[repro] === Phase C: render WITH ai_extend, mocked latency=${latencyMs}ms (${imageCount} images) ===`)
  const tenantC = await createLoadTestTenant('ReproIssue4-RenderAiExtend', { maxQueuedJobs: imageCount + 20 })
  const { importId: importIdC } = await importFixturePhotos(tenantC, fixturePaths, imageCount)
  await waitForBatchDrain(tenantC.tenantId, 20 * 60_000)

  const renderAiStart = Date.now()
  const renderAiResult = runWithTenant({ tenantId: tenantC.tenantId, userId: tenantC.userId, role: 'owner' }, () =>
    startBatch('repro-render-ai-extend', { importId: importIdC, allImages: true, templateId: tenantC.templateId })
  )
  const renderAiDrained = await waitForBatchDrain(tenantC.tenantId, 30 * 60_000)
  const renderAiElapsedMs = Date.now() - renderAiStart
  const renderAiCompleted = countCompleted(tenantC.tenantId, 'render')
  const fillCompleted = countCompleted(tenantC.tenantId, 'background_fill')
  report.phaseC = {
    imageCount,
    queued: renderAiResult.queued,
    drained: renderAiDrained,
    completed: renderAiCompleted,
    fillJobsCompleted: fillCompleted,
    failed: countFailed(tenantC.tenantId),
    elapsedMs: renderAiElapsedMs,
    imagesPerMinute: (renderAiCompleted / renderAiElapsedMs) * 60_000,
  }
  console.log(`[repro] Phase C: ${renderAiCompleted}/${renderAiResult.queued} render jobs (WITH AI Extend) in ${(renderAiElapsedMs / 1000).toFixed(1)}s (${((renderAiCompleted / renderAiElapsedMs) * 60_000).toFixed(1)} img/min)`)
  console.log(`[repro] Phase C: ${fillCompleted} background_fill jobs completed`)

  console.log('\n[repro] === SUMMARY (json) ===')
  console.log(JSON.stringify(report, null, 2))

  await pool.stop()
  closeDb()
  cleanupDir(tmpDataDir)
}

main().catch(err => {
  console.error('[repro] fatal:', err)
  fs.rmSync(tmpDataDir, { recursive: true, force: true })
  process.exit(1)
})
