/**
 * Phase 1.6 (docs/ISSUES.md issue 6 — "cannot handle multiple concurrent
 * logins/requests"): verifies the two scenarios the spec names explicitly,
 * against a REAL running server (real ONNX vision, real render compositing,
 * Cloudinary mocked) at the confirmed production LIVE SETTINGS — reusing
 * `scripts/lib/loadtest-web-scenarios.ts`'s `startRealServer`/`timedFetch`.
 *
 *   Scenario A: 3 DIFFERENT tenants, each importing + generating +
 *               downloading SIMULTANEOUSLY — does splitting load across
 *               tenants cost any one of them disproportionately versus
 *               running alone? (the scheduler fairness question)
 *   Scenario B: 3 CONCURRENT SESSIONS of the SAME account (3 independent
 *               logins, same tenant) each doing the same full workflow at
 *               once — does one session's work block another's requests
 *               for the SAME account (shared quotas, shared
 *               tenant_queue_state)? (the "3 concurrent logins" question,
 *               read literally)
 *
 * Reports queue wait (batch creation -> completion) and web p95 (real HTTP
 * latency for the exact status-poll endpoint a browser uses) per user, per
 * the spec's own acceptance criteria — not a judgment call on pass/fail,
 * since "fix any blocking found" depends on what these numbers show.
 *
 *   npx tsx scripts/verify-issue6-concurrency.ts
 *
 * Requires `npm run build` first — spawns a real `next start`, same as
 * loadtest-multitenant.ts's own web scenarios (5/6).
 *
 * ALWAYS runs against a fresh temp directory, never the real data/ dir.
 */

import os from 'os'
import fs from 'fs'
import path from 'path'

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-verify-issue6-'))
process.env.VISION_STUDIO_DATA_DIR = tmpDataDir
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'verify6-admin@loadtest.local'
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
// Shorter than issue 4's own 12s default — this script is about CONCURRENCY
// fairness, not re-measuring issue 4's latency breakdown; a shorter mocked
// latency keeps total runtime reasonable while still exercising the same
// AI-Extend-wait/defer machinery under real concurrent load.
process.env.VISION_STUDIO_LOADTEST_AI_EXTEND_LATENCY_MS =
  process.env.VISION_STUDIO_LOADTEST_AI_EXTEND_LATENCY_MS || '4000'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0
  const idx = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1)
  return sortedMs[Math.max(0, idx)]
}

interface UserRunResult {
  label: string
  batchCreateMs: number
  queueWaitMs: number
  imagesCompleted: number
  downloadMs: number
  downloadOk: boolean
  pollP50Ms: number
  pollP95Ms: number
  pollSampleCount: number
}

async function login(baseUrl: string, email: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw new Error(`login failed for ${email}: HTTP ${res.status}`)
  return (res.headers.get('set-cookie') ?? '').split(';')[0]
}

async function runFullWorkflow(
  baseUrl: string,
  cookie: string,
  label: string,
  importId: string,
  templateId: string,
  timedFetch: (url: string, cookie?: string) => Promise<{ ms: number; ok: boolean }>
): Promise<UserRunResult> {
  const createStart = process.hrtime.bigint()
  const genRes = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ importId, templateId, allImages: true, name: `issue6-${label}` }),
  })
  const batchCreateMs = Number(process.hrtime.bigint() - createStart) / 1e6
  const genBody = (await genRes.json()) as { batch?: { id: string } }
  const batchId = genBody.batch?.id
  if (!batchId) {
    throw new Error(`${label}: POST /api/generate did not return a batch id (HTTP ${genRes.status})`)
  }

  const pollSamples: number[] = []
  const deadline = Date.now() + 10 * 60_000
  let createdAt: string | null = null
  let completedAt: string | null = null
  let imagesCompleted = 0

  while (Date.now() < deadline) {
    const { ms, ok } = await timedFetch(`${baseUrl}/api/batches/${batchId}`, cookie)
    pollSamples.push(ms)
    if (ok) {
      // A second, untimed fetch for the actual body — timedFetch's job is
      // honest latency measurement (drain the real body), not parsing it.
      const statusRes = await fetch(`${baseUrl}/api/batches/${batchId}`, { headers: { cookie } })
      const body = (await statusRes.json()) as {
        batch: { status: string; createdAt: string; completedAt: string | null; completedJobs: number }
      }
      createdAt = body.batch.createdAt
      imagesCompleted = body.batch.completedJobs
      if (body.batch.status !== 'running' && body.batch.status !== 'queued') {
        completedAt = body.batch.completedAt
        break
      }
    }
    await sleep(1000)
  }

  const queueWaitMs =
    createdAt && completedAt ? new Date(completedAt).getTime() - new Date(createdAt).getTime() : -1

  const downloadStart = process.hrtime.bigint()
  const downloadRes = await fetch(`${baseUrl}/api/creatives/download?batchId=${batchId}`, { headers: { cookie } })
  await downloadRes.arrayBuffer()
  const downloadMs = Number(process.hrtime.bigint() - downloadStart) / 1e6

  const sortedPolls = [...pollSamples].sort((a, b) => a - b)
  return {
    label,
    batchCreateMs,
    queueWaitMs,
    imagesCompleted,
    downloadMs,
    downloadOk: downloadRes.ok,
    pollP50Ms: percentile(sortedPolls, 50),
    pollP95Ms: percentile(sortedPolls, 95),
    pollSampleCount: pollSamples.length,
  }
}

function printResults(scenarioName: string, results: UserRunResult[]) {
  console.log(`\n[verify-issue6] === ${scenarioName} ===`)
  for (const r of results) {
    console.log(
      `  ${r.label.padEnd(10)} batchCreate=${r.batchCreateMs.toFixed(0)}ms ` +
        `queueWait=${r.queueWaitMs >= 0 ? (r.queueWaitMs / 1000).toFixed(1) + 's' : 'did not complete'} ` +
        `imagesCompleted=${r.imagesCompleted} pollP50=${r.pollP50Ms.toFixed(0)}ms pollP95=${r.pollP95Ms.toFixed(0)}ms ` +
        `(n=${r.pollSampleCount}) download=${r.downloadOk ? 'ok' : 'FAILED'} in ${(r.downloadMs / 1000).toFixed(1)}s`
    )
  }
  const queueWaits = results.map(r => r.queueWaitMs).filter(ms => ms >= 0)
  if (queueWaits.length > 1) {
    const spread = Math.max(...queueWaits) - Math.min(...queueWaits)
    console.log(
      `  queue-wait spread across users: ${(spread / 1000).toFixed(1)}s (max ${(Math.max(...queueWaits) / 1000).toFixed(1)}s vs min ${(Math.min(...queueWaits) / 1000).toFixed(1)}s)`
    )
  }
}

async function main() {
  const { migrateControl } = await import('@/db/migrate')
  const { getControlDb, closeDb } = await import('@/db/client')
  const { getPool } = await import('@/jobs/pool')
  const { generateFixturePhotos, importFixturePhotos, createLoadTestTenant, cleanupDir } = await import(
    './lib/loadtest-fixtures'
  )
  const webScenarios = await import('./lib/loadtest-web-scenarios')

  const imageCount = 10 // modest per-tenant/session — this is about FAIRNESS, not another throughput measurement (that's issue 4's job)

  console.log(`[verify-issue6] data dir=${tmpDataDir} imagesPerUser=${imageCount}`)
  migrateControl(getControlDb())

  const fixtureDir = path.join(tmpDataDir, '_fixtures')
  const fixturePaths = await generateFixturePhotos(fixtureDir, 20)

  const pool = getPool()
  pool.start()
  console.log('[verify-issue6] warming up workers (model load)...')
  await sleep(15_000)

  async function waitForVisionDrain(tenantId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const row = getControlDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM jobs WHERE tenant_id = ? AND kind = 'vision' AND status IN ('pending','claimed','running')`
        )
        .get(tenantId) as { n: number }
      if (row.n === 0) return
      await sleep(300)
    }
  }

  console.log('[verify-issue6] starting real server...')
  const port = 3900 + Math.floor(Math.random() * 90)
  const server = await webScenarios.startRealServer(port)

  try {
    // ── Scenario A: 3 different tenants, full workflow, concurrently ───────
    const tenantsA = await Promise.all([
      createLoadTestTenant('Issue6-TenantA1'),
      createLoadTestTenant('Issue6-TenantA2'),
      createLoadTestTenant('Issue6-TenantA3'),
    ])
    const importsA = await Promise.all(tenantsA.map(t => importFixturePhotos(t, fixturePaths, imageCount)))
    await Promise.all(tenantsA.map(t => waitForVisionDrain(t.tenantId, 5 * 60_000)))

    const resultsA = await Promise.all(
      tenantsA.map(async (t, i) => {
        const cookie = await login(server.baseUrl, t.email, t.password)
        return runFullWorkflow(
          server.baseUrl,
          cookie,
          `tenant-${i + 1}`,
          importsA[i].importId,
          t.templateId,
          webScenarios.timedFetch
        ).catch(err => {
          console.error(`[verify-issue6] Scenario A tenant-${i + 1} failed:`, err.message)
          throw err
        })
      })
    )
    printResults('Scenario A — 3 different tenants, concurrent full workflows', resultsA)

    // ── Scenario B: 3 concurrent sessions, SAME account ─────────────────────
    const tenantB = await createLoadTestTenant('Issue6-TenantB-SharedAccount')
    // Three independent imports under the SAME tenant so each "session" has
    // its own distinct batch to drive — a real user wouldn't have 3 browser
    // tabs fighting over the exact same batch, but would plausibly have 3
    // tabs each doing their own import+generate against the same account.
    const importsB = await Promise.all([
      importFixturePhotos(tenantB, fixturePaths, imageCount),
      importFixturePhotos(tenantB, fixturePaths, imageCount),
      importFixturePhotos(tenantB, fixturePaths, imageCount),
    ])
    await waitForVisionDrain(tenantB.tenantId, 8 * 60_000)

    const resultsB = await Promise.all(
      importsB.map(async (imp, i) => {
        const cookie = await login(server.baseUrl, tenantB.email, tenantB.password)
        return runFullWorkflow(
          server.baseUrl,
          cookie,
          `session-${i + 1}`,
          imp.importId,
          tenantB.templateId,
          webScenarios.timedFetch
        ).catch(err => {
          console.error(`[verify-issue6] Scenario B session-${i + 1} failed:`, err.message)
          throw err
        })
      })
    )
    printResults('Scenario B — 3 concurrent sessions, same account', resultsB)
  } finally {
    await webScenarios.stopRealServer(server)
    await pool.stop()
    closeDb()
    cleanupDir(tmpDataDir)
  }
}

main().catch(err => {
  console.error('[verify-issue6] fatal:', err)
  fs.rmSync(tmpDataDir, { recursive: true, force: true })
  process.exit(1)
})
