/**
 * Fast/CI-mode worker entry for `scripts/loadtest-multitenant.ts` — same
 * claim/bind-tenant/report loop shape as the real `src/jobs/worker-entry.ts`
 * and `tests/helpers/fake-worker-entry.ts`, but driven by the job's `kind`
 * rather than a scripted `payload.action`: it simulates each kind's
 * approximate relative duration (vision slower than render, background_fill
 * slowest with an occasional 429-and-retry) WITHOUT loading ONNX models or
 * calling Cloudinary, so the whole load-test matrix runs in seconds against
 * the REAL queue/scheduler/pool code, deterministically, in CI.
 *
 * This is for measuring SCHEDULER behavior (fairness, interactive-before-
 * bulk, throughput under contention) — not real wall-clock job duration.
 * Real-mode (`scripts/loadtest-multitenant.ts --mode=real`) uses the actual
 * worker-entry.ts and real ONNX inference for that.
 *
 * Config arrives as a JSON CLI arg, same convention as every other
 * worker-entry variant in this repo.
 */

import * as queue from '../../src/jobs/queue'
import { closeDb } from '../../src/db/client'
import { runWithTenant } from '../../src/tenancy/context'
import type { JobKind } from '../../src/db/types'

interface FakeWorkerConfig {
  workerId: string
  kinds: JobKind[]
  pollIntervalMs: number
}

// This is spawned by the REAL WorkerPool (src/jobs/pool.ts's spawn()), which
// only ever passes {workerId, kinds, pollIntervalMs} as the CLI JSON arg —
// there is no room to extend that shape without editing the pool itself. The
// pool DOES pass its own full `process.env` through to the child, though, so
// per-kind durations and the simulated failure rate travel as env vars set
// by scripts/loadtest-multitenant.ts before calling getPool().start(),
// instead.
const cfg: FakeWorkerConfig = JSON.parse(process.argv[2] ?? '{}')
if (!cfg.workerId) {
  console.error('[loadtest-fake-worker] missing configuration argument')
  process.exit(1)
}

const DEFAULT_DURATIONS_MS: Record<JobKind, number> = {
  vision: 180,
  render: 90,
  background_fill: 300,
}

const durationsMs: Partial<Record<JobKind, number>> = process.env.VISION_STUDIO_LOADTEST_DURATIONS_MS
  ? JSON.parse(process.env.VISION_STUDIO_LOADTEST_DURATIONS_MS)
  : {}
const transientFailureRate = Number(process.env.VISION_STUDIO_LOADTEST_FAILURE_RATE ?? '0')

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function post(message: unknown): void {
  process.send?.(message)
}

function jittered(baseMs: number): number {
  const jitter = baseMs * 0.3
  return Math.max(1, baseMs + (Math.random() * 2 - 1) * jitter)
}

let running = true

async function runOne(kind: JobKind): Promise<boolean> {
  const job = queue.claim(kind, cfg.workerId)
  if (!job) return false

  queue.markRunning(job.id, cfg.workerId)
  post({
    type: 'job:started',
    workerId: cfg.workerId,
    jobId: job.id,
    kind,
    tenantId: job.tenantId,
    startedAt: new Date().toISOString(),
  })

  const beat = setInterval(() => {
    try {
      queue.heartbeat(job.id, cfg.workerId)
    } catch {
      // Transient — next beat covers it.
    }
  }, 200)

  try {
    await runWithTenant({ tenantId: job.tenantId, userId: 'system', role: 'owner' }, async () => {
      const duration = jittered(durationsMs[kind] ?? DEFAULT_DURATIONS_MS[kind])
      await sleep(duration)

      // Deterministic within one attempt's lifetime: fail only on the FIRST
      // attempt (job.attempts === 1, since claim() already incremented it),
      // so every job eventually succeeds on retry rather than looping
      // forever — mirrors a real transient provider hiccup, not a poison job.
      if (job.attempts === 1 && Math.random() < transientFailureRate) {
        throw new Error('(loadtest) simulated transient failure')
      }
    })
    queue.complete(job.id, cfg.workerId, { ok: true, loadtest: true })
    post({ type: 'job:done', jobId: job.id, batchId: job.batchId })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const { retrying } = queue.fail(job.id, cfg.workerId, message)
    post({
      type: 'job:failed',
      workerId: cfg.workerId,
      jobId: job.id,
      kind,
      tenantId: job.tenantId,
      batchId: job.batchId,
      error: message,
      retrying,
    })
  } finally {
    clearInterval(beat)
  }

  return true
}

async function loop(): Promise<void> {
  post({ type: 'ready' })
  while (running) {
    let didWork = false
    for (const kind of cfg.kinds) {
      if (!running) break
      if (await runOne(kind)) {
        didWork = true
        break
      }
    }
    if (!didWork) {
      post({ type: 'idle' })
      await sleep(cfg.pollIntervalMs)
    }
  }
}

process.on('message', (message: { type: string }) => {
  if (message?.type === 'stop') running = false
})

loop()
  .catch(err => {
    console.error('[loadtest-fake-worker] fatal:', err)
    process.exitCode = 1
  })
  .finally(() => {
    closeDb()
    process.exit(process.exitCode ?? 0)
  })
