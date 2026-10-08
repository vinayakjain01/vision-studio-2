/**
 * Scenarios 1-4 and 7 for scripts/loadtest-multitenant.ts — everything that
 * exercises the queue/scheduler/pool DIRECTLY, in-process, with no HTTP
 * server involved. See loadtest-web-scenarios.ts for 5/6, which need a real
 * running server to measure actual request latency and event-loop delay.
 */

import { getControlDb } from '@/db/client'
import * as queue from '@/jobs/queue'
import { getPool } from '@/jobs/pool'
import { createLoadTestTenant, importFixturePhotos, type LoadTestTenant } from './loadtest-fixtures'
import { summarize, Stopwatch, type ScenarioResult, fmtMs } from './loadtest-metrics'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Polls queue.stats() until every job for the given tenant ids has left pending/claimed/running, or timeoutMs elapses. */
async function waitForDrain(tenantIds: string[], timeoutMs: number, pollMs = 200): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const db = getControlDb()
    const placeholders = tenantIds.map(() => '?').join(',')
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM jobs WHERE tenant_id IN (${placeholders}) AND status IN ('pending','claimed','running')`
      )
      .get(...tenantIds) as { n: number }
    if (row.n === 0) return true
    await sleep(pollMs)
  }
  return false
}

/** First-claim latency (ms from created_at to claimed_at) for every job belonging to `tenantId`. */
function firstClaimLatenciesMs(tenantId: string): number[] {
  const db = getControlDb()
  const rows = db
    .prepare(
      `SELECT created_at, claimed_at FROM jobs WHERE tenant_id = ? AND claimed_at IS NOT NULL`
    )
    .all(tenantId) as { created_at: string; claimed_at: string }[]
  return rows.map(r => new Date(r.claimed_at).getTime() - new Date(r.created_at).getTime())
}

function completionLatenciesMs(tenantId: string): number[] {
  const db = getControlDb()
  const rows = db
    .prepare(
      `SELECT created_at, completed_at FROM jobs WHERE tenant_id = ? AND completed_at IS NOT NULL`
    )
    .all(tenantId) as { created_at: string; completed_at: string }[]
  return rows.map(r => new Date(r.completed_at).getTime() - new Date(r.created_at).getTime())
}

function totalCompleted(tenantIds: string[]): number {
  const db = getControlDb()
  const placeholders = tenantIds.map(() => '?').join(',')
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE tenant_id IN (${placeholders}) AND status = 'completed'`)
    .get(...tenantIds) as { n: number }
  return row.n
}

// ─── Scenario 1: single-tenant baseline throughput ─────────────────────────

export async function scenario1Baseline(fixturePaths: string[], mode: 'fast' | 'real'): Promise<ScenarioResult> {
  // Matches scenario 4's TOTAL job count exactly (10 tenants x its
  // per-tenant count) — throughput scales with queue depth/batch size (more
  // queued work keeps every worker slot saturated with less relative idle/
  // poll overhead near the tail), so comparing a small single-tenant batch
  // against scenario 4's large aggregate one would be comparing batch-size
  // effects, not the thing "within 10% of baseline" is actually asking
  // about: does SPLITTING the same total load across many tenants cost
  // throughput versus one tenant doing all of it.
  const imageCount = mode === 'fast' ? 1000 : 150
  const tenant = await createLoadTestTenant('Baseline', { maxQueuedJobs: imageCount + 50 })

  // Stopwatch starts AFTER ingestion (hashing, decode, DB writes for each
  // file) — that cost is real but is import-pipeline cost, not queue/
  // scheduler throughput, and measuring from before it would make this
  // number incomparable with scenario 4's (which ingests 10 tenants
  // CONCURRENTLY via Promise.all, so the same per-file ingestion cost is
  // parallelized away there but not here, biasing any "aggregate vs
  // baseline" comparison that isn't actually about ingestion at all).
  const { importId } = await importFixturePhotos(tenant, fixturePaths, imageCount)
  const sw = new Stopwatch()
  const drained = await waitForDrain([tenant.tenantId], mode === 'fast' ? 120_000 : 20 * 60_000)

  const elapsedMs = sw.elapsedMs()
  const completed = totalCompleted([tenant.tenantId])
  const perMin = (completed / elapsedMs) * 60_000

  return {
    name: 'Scenario 1 — single-tenant baseline throughput',
    mode,
    durationMs: elapsedMs,
    metrics: {
      'images imported': imageCount,
      'import id': importId,
      'jobs completed': completed,
      'drained before timeout': drained,
      'throughput (images/min)': perMin.toFixed(1),
    },
    targets: [],
    notes: [
      'This number is the baseline every other scenario\'s aggregate throughput target (within 10%) is measured against.',
    ],
  }
}

// ─── Scenario 2: one heavy tenant + 5 light tenants, fairness ──────────────

export async function scenario2Fairness(fixturePaths: string[], mode: 'fast' | 'real'): Promise<ScenarioResult> {
  const sw = new Stopwatch()
  const heavyJobCount = mode === 'fast' ? 500 : 60
  const lightJobCounts = [5, 8, 12, 15, 20]

  const heavy = await createLoadTestTenant('Heavy', { maxQueuedJobs: heavyJobCount + 50 })
  await importFixturePhotos(heavy, fixturePaths, heavyJobCount)

  // Heavy tenant's backlog is submitted FIRST and given a moment to actually
  // start claiming, so light tenants are genuinely staggered against a real
  // backlog in progress — not just submitted in the same instant.
  await sleep(mode === 'fast' ? 300 : 3000)

  const lightTenants: LoadTestTenant[] = []
  const lightSubmitTimes: Record<string, number> = {}
  for (let i = 0; i < lightJobCounts.length; i++) {
    const t = await createLoadTestTenant(`Light-${i}`)
    lightTenants.push(t)
    lightSubmitTimes[t.tenantId] = Date.now()
    await importFixturePhotos(t, fixturePaths, lightJobCounts[i])
    await sleep(mode === 'fast' ? 150 : 1500) // staggered submission
  }

  const allTenantIds = [heavy.tenantId, ...lightTenants.map(t => t.tenantId)]
  await waitForDrain(allTenantIds, mode === 'fast' ? 60_000 : 15 * 60_000)

  // "First job starts within ~2x the median job duration" — measured as the
  // light tenant's own first-claim latency vs the median completion latency
  // observed across ALL tenants in this scenario (the fairest available
  // proxy for "a typical job's own duration" without a dedicated solo run).
  const allCompletionLatencies = allTenantIds.flatMap(completionLatenciesMs)
  const medianJobDurationMs = summarize(allCompletionLatencies).p50

  const lightFirstClaimP95: number[] = []
  for (const t of lightTenants) {
    const latencies = firstClaimLatenciesMs(t.tenantId)
    if (latencies.length > 0) lightFirstClaimP95.push(Math.min(...latencies))
  }
  const worstLightFirstClaim = Math.max(...lightFirstClaimP95, 0)
  const targetMs = medianJobDurationMs * 2
  const met = medianJobDurationMs > 0 ? worstLightFirstClaim <= targetMs : null

  return {
    name: 'Scenario 2 — one heavy tenant (fairness vs 5 light tenants)',
    mode,
    durationMs: sw.elapsedMs(),
    metrics: {
      'heavy tenant jobs': heavyJobCount,
      'light tenants': lightTenants.length,
      'light tenant job counts': lightJobCounts.join(', '),
      'median job completion latency': fmtMs(medianJobDurationMs),
      'worst light-tenant first-claim latency': fmtMs(worstLightFirstClaim),
    },
    targets: [
      {
        description: "A light tenant's first job starts within ~2x the median job duration",
        met,
        evidence: `worst first-claim ${fmtMs(worstLightFirstClaim)} vs target ${fmtMs(targetMs)} (2x median ${fmtMs(medianJobDurationMs)})`,
      },
    ],
    notes: [],
  }
}

// ─── Scenario 3: interactive work while a bulk backlog exists ──────────────

export async function scenario3Interactive(fixturePaths: string[], mode: 'fast' | 'real'): Promise<ScenarioResult> {
  const sw = new Stopwatch()
  const bulkJobCount = mode === 'fast' ? 300 : 40

  const bulkTenant = await createLoadTestTenant('BulkBacklog', { maxQueuedJobs: bulkJobCount + 50 })
  await importFixturePhotos(bulkTenant, fixturePaths, bulkJobCount)
  await sleep(mode === 'fast' ? 300 : 3000) // let the backlog actually start running

  const interactiveTenant = await createLoadTestTenant('Interactive')
  const interactiveSubmitAt = Date.now()
  await importFixturePhotos(interactiveTenant, fixturePaths, 1)

  // Poll specifically for the interactive tenant's one job completing.
  const deadline = Date.now() + (mode === 'fast' ? 20_000 : 5 * 60_000)
  let interactiveCompletedAt: number | null = null
  while (Date.now() < deadline) {
    const latencies = completionLatenciesMs(interactiveTenant.tenantId)
    if (latencies.length > 0) {
      interactiveCompletedAt = Date.now()
      break
    }
    await sleep(150)
  }

  const interactiveWaitMs = interactiveCompletedAt ? interactiveCompletedAt - interactiveSubmitAt : -1
  const bulkStats = queue.stats(undefined, bulkTenant.tenantId)
  const bulkStillInFlight = bulkStats.pending + bulkStats.claimed + bulkStats.running > 0

  await waitForDrain([bulkTenant.tenantId, interactiveTenant.tenantId], mode === 'fast' ? 30_000 : 10 * 60_000)

  return {
    name: 'Scenario 3 — interactive single-photo generate during a bulk backlog',
    mode,
    durationMs: sw.elapsedMs(),
    metrics: {
      'bulk backlog size': bulkJobCount,
      'interactive job wait': interactiveWaitMs >= 0 ? fmtMs(interactiveWaitMs) : 'did not complete in time',
      'bulk backlog still in flight when interactive completed': bulkStillInFlight,
    },
    targets: [
      {
        description: 'Interactive work precedes bulk (completes promptly despite a large bulk backlog)',
        met: interactiveWaitMs >= 0 ? interactiveWaitMs < (mode === 'fast' ? 5000 : 60_000) : false,
        evidence: `interactive job completed in ${interactiveWaitMs >= 0 ? fmtMs(interactiveWaitMs) : 'timeout'} while a ${bulkJobCount}-job bulk backlog was active`,
      },
    ],
    notes: [],
  }
}

// ─── Scenario 4: 10 tenants importing 100 photos concurrently ─────────────

export async function scenario4ConcurrentImports(fixturePaths: string[], mode: 'fast' | 'real'): Promise<ScenarioResult> {
  const tenantCount = 10
  const perTenantPhotos = mode === 'fast' ? 100 : 15

  const tenants: LoadTestTenant[] = []
  for (let i = 0; i < tenantCount; i++) {
    tenants.push(await createLoadTestTenant(`Concurrent-${i}`, { maxImagesPerBatch: perTenantPhotos + 10 }))
  }

  // Genuinely concurrent submission — all 10 imports kicked off together,
  // not sequentially staggered like scenario 2. Stopwatch starts only once
  // every import has finished (same reasoning as scenario 1's own comment)
  // so this measures queue/scheduler throughput against the same baseline,
  // not whichever scenario happened to parallelize ingestion more.
  await Promise.all(tenants.map(t => importFixturePhotos(t, fixturePaths, perTenantPhotos)))
  const sw = new Stopwatch()

  const tenantIds = tenants.map(t => t.tenantId)
  const drained = await waitForDrain(tenantIds, mode === 'fast' ? 120_000 : 20 * 60_000)
  const elapsedMs = sw.elapsedMs()
  const completed = totalCompleted(tenantIds)
  const perMin = (completed / elapsedMs) * 60_000

  return {
    name: 'Scenario 4 — 10 tenants importing concurrently',
    mode,
    durationMs: elapsedMs,
    metrics: {
      tenants: tenantCount,
      'photos per tenant': perTenantPhotos,
      'total jobs completed': completed,
      'drained before timeout': drained,
      'aggregate throughput (images/min)': perMin.toFixed(1),
    },
    targets: [
      {
        description: 'Aggregate throughput with many tenants is within 10% of the single-tenant baseline (see scenario 1)',
        met: null,
        evidence: `${perMin.toFixed(1)} images/min aggregate across ${tenantCount} tenants — compare against scenario 1's baseline in this same report`,
      },
    ],
    notes: ['Target comparison against scenario 1 is computed by the report writer once both scenarios have run.'],
  }
}

// ─── Scenario 7: chaos — kill a worker, then simulate a container restart ──

export async function scenario7Chaos(fixturePaths: string[], mode: 'fast' | 'real'): Promise<ScenarioResult> {
  const sw = new Stopwatch()
  const jobCount = mode === 'fast' ? 100 : 15
  const tenant = await createLoadTestTenant('Chaos', { maxQueuedJobs: jobCount + 20 })
  await importFixturePhotos(tenant, fixturePaths, jobCount)

  await sleep(mode === 'fast' ? 400 : 4000) // let some jobs actually start running

  const notes: string[] = []
  const pool = getPool()

  // ── kill -9 a worker ──────────────────────────────────────────────────────
  const before = pool.status()
  const busyWorker = before.workers.find(w => w.state === 'busy' && w.pid)
  if (busyWorker?.pid) {
    process.kill(busyWorker.pid, 'SIGKILL')
    notes.push(`SIGKILL sent to worker ${busyWorker.id} (pid ${busyWorker.pid})`)
  } else {
    notes.push('no busy worker found to kill at the sampled instant — pool may have already drained; chaos coverage reduced for this run')
  }

  // Long enough for the killed worker's job lease to actually EXPIRE
  // (JOB_STALE_CLAIM_MS — the loadtest script sets this short in fast mode
  // specifically so this wait stays test-sized) before the restart below —
  // otherwise reclaimStale() finds nothing to reclaim yet and the job sits
  // orphaned until the next periodic sweep, well past this scenario's own
  // drain timeout, looking like a lost job when it's really just not-yet-
  // expired.
  await sleep(mode === 'fast' ? 2500 : 6 * 60_000)

  // ── restart the whole pool in-process (closest in-process analogue to
  //    "restart the whole container" available without actually spawning a
  //    new OS process — see the script's own doc on this tradeoff) ─────────
  await pool.stop()
  // start() internally calls queue.reclaimStale()/reconcileRunningJobs()
  // first, exactly like a real process restart's pool.start() would.
  pool.start()
  notes.push('pool.stop() + pool.start() — simulates a full process restart; reclaimStale()/reconcileRunningJobs() ran as part of start()')

  const drained = await waitForDrain([tenant.tenantId], mode === 'fast' ? 30_000 : 10 * 60_000)

  const db = getControlDb()
  const corrupt = db
    .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE tenant_id = ? AND status = 'completed' AND error IS NOT NULL`)
    .get(tenant.tenantId) as { n: number }
  const lost = db
    .prepare(
      `SELECT COUNT(*) AS n FROM jobs WHERE tenant_id = ? AND status NOT IN ('completed','failed','cancelled')`
    )
    .get(tenant.tenantId) as { n: number }
  const finalQueueState = db
    .prepare(`SELECT running_jobs FROM tenant_queue_state WHERE tenant_id = ?`)
    .get(tenant.tenantId) as { running_jobs: number } | undefined

  return {
    name: 'Scenario 7 — chaos: kill a worker, restart the pool mid-run',
    mode,
    durationMs: sw.elapsedMs(),
    metrics: {
      'jobs submitted': jobCount,
      'drained after chaos': drained,
      'jobs stuck in a non-terminal status': lost.n,
      'completed jobs with a non-null error (corrupt result)': corrupt.n,
      'running_jobs counter at end': finalQueueState?.running_jobs ?? 'unknown',
    },
    targets: [
      { description: 'No job lost', met: lost.n === 0, evidence: `${lost.n} job(s) stuck in a non-terminal status after chaos + drain` },
      {
        description: 'No job executed with a corrupt result',
        met: corrupt.n === 0,
        evidence: `${corrupt.n} completed job(s) carry a non-null error field`,
      },
      {
        description: 'running_jobs counters back to zero at the end',
        met: (finalQueueState?.running_jobs ?? -1) === 0,
        evidence: `tenant_queue_state.running_jobs = ${finalQueueState?.running_jobs ?? 'missing row'}`,
      },
    ],
    notes,
  }
}
