/**
 * Multi-tenancy load test — scripts/loadtest-multitenant.ts
 *
 * Two modes:
 *   --mode=fast   (default) Deterministic, synthetic worker timing (no ONNX,
 *                 no Cloudinary) — exercises the REAL queue/scheduler/pool
 *                 code, fast enough for CI. Measures SCHEDULER behavior:
 *                 fairness, ordering, throughput under contention. Not real
 *                 wall-clock job duration.
 *   --mode=real   Real ONNX vision analysis on real (synthetic, generated)
 *                 photos, real worker processes, the real pool. AI Extend's
 *                 Cloudinary call is mocked (realistic latency + occasional
 *                 429s) — NEVER spends a real credit or makes a network call.
 *                 Run `npm run build` first; scenarios 5/6 start a real
 *                 `next start` server.
 *
 *   npm run loadtest                              # fast mode, every scenario
 *   npm run loadtest -- --mode=real                # real mode, every scenario
 *   npm run loadtest -- --scenario=1,2,3            # just these
 *   npm run loadtest -- --report=./loadtest-report.md
 *   npm run loadtest -- --mode=real --no-web        # skip scenarios 5/6 (no server spawn)
 *
 * ALWAYS runs against a fresh temp directory — VISION_STUDIO_DATA_DIR is set
 * to a freshly created `os.tmpdir()` subdirectory before anything else in
 * this file runs, exactly like tests/helpers/tenant-env.ts. The real data/
 * directory is never touched, never even read.
 */

import os from 'os'
import fs from 'fs'
import path from 'path'
import type { ScenarioResult } from './lib/loadtest-metrics'

// ── Env setup — MUST happen before any `@/...` import (config.ts reads
//    VISION_STUDIO_DATA_DIR into a module-level constant at import time). ──
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-loadtest-'))
process.env.VISION_STUDIO_DATA_DIR = tmpDataDir
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'loadtest-admin@loadtest.local'
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Loadtest-Password-1'
process.env.ALLOW_MULTI_TENANT_PREVIEW = '1'

interface Args {
  mode: 'fast' | 'real'
  scenarios: string[]
  reportPath: string
  web: boolean
  keepDataDir: boolean
}

function parseArgs(argv: string[]): Args {
  const out: Args = { mode: 'fast', scenarios: ['1', '2', '3', '4', '5', '6', '7'], reportPath: './loadtest-report.md', web: true, keepDataDir: false }
  for (const arg of argv) {
    if (arg === '--mode=real') out.mode = 'real'
    else if (arg === '--mode=fast') out.mode = 'fast'
    else if (arg.startsWith('--scenario=')) out.scenarios = arg.slice('--scenario='.length).split(',')
    else if (arg.startsWith('--report=')) out.reportPath = arg.slice('--report='.length)
    else if (arg === '--no-web') out.web = false
    else if (arg === '--keep-data-dir') out.keepDataDir = true
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

// Fast mode: point the REAL WorkerPool at the lightweight synthetic worker
// instead of the real ONNX-loading one — same escape hatch
// tests/jobs/graceful-shutdown.test.ts uses. Must be set before pool.ts's
// first spawn() call, so before any job is ever claimed.
if (args.mode === 'fast') {
  process.env.VISION_STUDIO_WORKER_ENTRY_OVERRIDE = path.join(
    process.cwd(),
    'scripts',
    'lib',
    'loadtest-fake-worker-entry.ts'
  )
  process.env.VISION_STUDIO_LOADTEST_DURATIONS_MS = JSON.stringify({ vision: 180, render: 90, background_fill: 300 })
  process.env.VISION_STUDIO_LOADTEST_FAILURE_RATE = '0.03'
  // Fast mode wants real contention to exercise the scheduler meaningfully
  // without needing real CPU/memory headroom — more slots than the
  // conservative dev default (1/1), fewer than a production box.
  process.env.JOB_VISION_CONCURRENCY = process.env.JOB_VISION_CONCURRENCY || '3'
  process.env.JOB_RENDER_CONCURRENCY = process.env.JOB_RENDER_CONCURRENCY || '3'
  process.env.CLOUDINARY_JOB_CONCURRENCY = process.env.CLOUDINARY_JOB_CONCURRENCY || '2'
  // Scenario 7 (chaos) needs a lease short enough that reclaimStale() can
  // actually observe and requeue a SIGKILLed worker's orphaned job within a
  // test-sized wait window — production's 5-minute default is correct for
  // production (not every brief GC pause should look like a dead worker),
  // but would make the chaos scenario's own assertions either wait 5 real
  // minutes or spuriously "fail" on a job that was never actually lost, just
  // not yet reclaimed. Short, not zero, so a claim is still observably
  // "leased" rather than racing reclaimStale() against markRunning().
  process.env.JOB_STALE_CLAIM_MS = process.env.JOB_STALE_CLAIM_MS || '2000'
} else {
  process.env.VISION_STUDIO_LOADTEST_MOCK_AI_EXTEND = '1'
  // Real mode: respect whatever the operator set (production env vars), or
  // config.ts's own production defaults (sized from cores/memory) if unset.
  ;(process.env as any).NODE_ENV = process.env.NODE_ENV || 'production'
}

async function main() {
  // Imported dynamically, AFTER the env vars above are set.
  const { migrateControl } = await import('@/db/migrate')
  const { getControlDb, closeDb } = await import('@/db/client')
  const { getPool } = await import('@/jobs/pool')
  const { generateFixturePhotos, cleanupDir, createLoadTestTenant } = await import('./lib/loadtest-fixtures')
  const { captureMachineSpec, writeMarkdownReport } = await import('./lib/loadtest-metrics')
  const scenarios = await import('./lib/loadtest-scenarios')
  const webScenarios = await import('./lib/loadtest-web-scenarios')

  console.log(`[loadtest] mode=${args.mode} data dir=${tmpDataDir}`)
  migrateControl(getControlDb())

  const fixtureDir = path.join(tmpDataDir, '_fixtures')
  const fixtureCount = args.mode === 'fast' ? 50 : 50
  console.log(`[loadtest] generating ${fixtureCount} fixture photos...`)
  const fixturePaths = await generateFixturePhotos(fixtureDir, fixtureCount)

  const pool = getPool()
  pool.start()
  // Workers spawn staggered (see pool.ts's own comment on why) — without a
  // warmup pause here, scenario 1 (run first) would pay that one-time
  // spin-up cost inside ITS OWN throughput measurement while every later
  // scenario gets already-warm workers for free, making the "within 10% of
  // baseline" comparison against scenario 4 compare a cold start against a
  // warm one rather than two genuinely comparable throughput measurements.
  await new Promise(resolve => setTimeout(resolve, args.mode === 'fast' ? 2000 : 15_000))

  const memorySamples: number[] = []
  const memoryTimer = setInterval(() => {
    memorySamples.push(process.memoryUsage().rss)
  }, 2000)
  memoryTimer.unref()

  const results: ScenarioResult[] = []
  const want = (n: string) => args.scenarios.includes(n) || args.scenarios.includes('all')

  try {
    if (want('1')) results.push(await scenarios.scenario1Baseline(fixturePaths, args.mode))
    if (want('2')) results.push(await scenarios.scenario2Fairness(fixturePaths, args.mode))
    if (want('3')) results.push(await scenarios.scenario3Interactive(fixturePaths, args.mode))
    if (want('4')) results.push(await scenarios.scenario4ConcurrentImports(fixturePaths, args.mode))

    if (args.web && (want('5') || want('6'))) {
      // The spawned `next start` process runs its OWN instrumentation.ts,
      // which starts its OWN in-process worker pool the first time a job is
      // enqueued through it (ensurePoolRunning()) — against the SAME
      // control.db this script's own pool is already polling. Left running,
      // that's two full sets of worker processes competing for the same
      // jobs, which is exactly the kind of CPU oversubscription
      // config.ts's own comments warn against — and it would make scenario
      // 5's web-latency numbers measure contention from a load-test
      // artifact, not real production behavior. Stop this process's pool
      // for the duration of the web scenarios; the spawned server's own
      // pool is the only one active while they run.
      await pool.stop()
      const webTenant = await createLoadTestTenant('WebLoad')
      const port = 3900 + Math.floor(Math.random() * 90)
      console.log(`[loadtest] starting real server on :${port} for web scenarios...`)
      const server = await webScenarios.startRealServer(port)
      try {
        if (want('5')) results.push(await webScenarios.scenario5WebResponsiveness(server, webTenant, fixturePaths, args.mode))
        if (want('6')) results.push(await webScenarios.scenario6BulkDuringSaturation(server, webTenant, fixturePaths, args.mode))
      } finally {
        await webScenarios.stopRealServer(server)
        // Resume this process's own pool for any in-process scenario still
        // to come (scenario 7).
        pool.start()
      }
    } else if (want('5') || want('6')) {
      console.log('[loadtest] --no-web: skipping scenarios 5/6 (require a spawned server)')
    }

    if (want('7')) results.push(await scenarios.scenario7Chaos(fixturePaths, args.mode))
  } finally {
    clearInterval(memoryTimer)
    await pool.stop()
    closeDb()
  }

  // Cross-scenario target: scenario 4's aggregate throughput vs scenario 1's
  // baseline, within 10%.
  const s1 = results.find(r => r.name.startsWith('Scenario 1'))
  const s4 = results.find(r => r.name.startsWith('Scenario 4'))
  if (s1 && s4) {
    const baseline = parseFloat(String(s1.metrics['throughput (images/min)']))
    const aggregate = parseFloat(String(s4.metrics['aggregate throughput (images/min)']))
    const within10pct = Math.abs(aggregate - baseline) / baseline <= 0.1
    const target = s4.targets.find(t => t.description.startsWith('Aggregate throughput'))
    if (target) {
      target.met = within10pct
      target.evidence = `${aggregate.toFixed(1)} img/min aggregate vs ${baseline.toFixed(1)} img/min baseline (${(((aggregate - baseline) / baseline) * 100).toFixed(1)}% difference)`
    }
  }

  // Memory-flat check, appended as its own pseudo-result.
  if (memorySamples.length > 1) {
    const minMb = Math.min(...memorySamples) / 1024 / 1024
    const maxMb = Math.max(...memorySamples) / 1024 / 1024
    const growthPct = ((maxMb - minMb) / minMb) * 100
    results.push({
      name: 'Memory — RSS sampled every 2s across the whole run',
      mode: args.mode,
      durationMs: 0,
      metrics: {
        'min RSS': `${minMb.toFixed(0)} MB`,
        'max RSS': `${maxMb.toFixed(0)} MB`,
        'growth': `${growthPct.toFixed(1)}%`,
        samples: memorySamples.length,
      },
      targets: [{ description: 'Memory stays flat (no unbounded growth) across the run', met: growthPct < 50, evidence: `${growthPct.toFixed(1)}% RSS growth from min to max over ${memorySamples.length} samples` }],
      notes: [
        'This span covers EVERY scenario run (each creating fresh tenants/app.db handles/fixture files), not one sustained steady-state workload — growth here is expected from one-time setup cost (new tenant DB handles entering the LRU, fixture generation), not necessarily a leak.',
        'A single short-lived process sampling its own RSS — not a substitute for a longer soak test (sustained, unchanging workload, hours not minutes) on the target production host, which is the only way to distinguish real leaks from one-time setup growth with confidence.',
      ],
    })
  }

  const machine = captureMachineSpec()
  writeMarkdownReport({ outPath: args.reportPath, mode: args.mode, machine, results })
  console.log(`[loadtest] report written to ${args.reportPath}`)

  for (const r of results) {
    console.log(`\n${r.name}`)
    for (const [k, v] of Object.entries(r.metrics)) console.log(`  ${k}: ${v}`)
    for (const t of r.targets) console.log(`  [${t.met === null ? '—' : t.met ? 'PASS' : 'FAIL'}] ${t.description} — ${t.evidence}`)
  }

  if (!args.keepDataDir) {
    cleanupDir(tmpDataDir)
  } else {
    console.log(`[loadtest] data dir kept at ${tmpDataDir}`)
  }
}

main().catch(err => {
  console.error('[loadtest] fatal:', err)
  if (!args.keepDataDir) fs.rmSync(tmpDataDir, { recursive: true, force: true })
  process.exit(1)
})
