/**
 * Worker process entry point.
 *
 * One long-lived child process per pool slot. It loops: claim a job (from
 * across EVERY tenant — see queue.claim()'s doc comment), bind that job's own
 * tenant context, run it, report over IPC, repeat. ONNX sessions load once
 * per process on the first vision job and stay resident.
 *
 * ── Per-job tenant binding (P3) ──────────────────────────────────────────────
 * Removed in P3: the P1/P2 bridge that ran this whole process as ONE tenant
 * for its entire lifetime (see the deleted src/jobs/default-tenant.ts). Each
 * claimed job now carries its own `tenantId`, and `runWithTenant` wraps ONLY
 * that job's handler call — a vision worker can process tenant A's image,
 * then tenant B's, in consecutive loop iterations, each fully isolated.
 * AsyncLocalStorage does not leak between them because nothing outlives the
 * `await` inside `runOne`'s `runWithTenant(...)` call.
 *
 * ── Process, not thread ──────────────────────────────────────────────────────
 * A separate process rather than a `worker_thread`, for two reasons that both
 * showed up in practice:
 *
 *  1. Crash isolation. This process drives four native addons (ONNX Runtime,
 *     sharp, better-sqlite3, skia). A native fault in any of them must not take
 *     the web server down with it — and in a worker thread it does, because the
 *     address space is shared. The pool sees a non-zero exit, requeues the job
 *     and respawns.
 *
 *  2. Loader support. `execArgv: ['--import', 'tsx']` is honoured at process
 *     startup, so this TypeScript file runs directly. Worker threads do not
 *     apply it and fail with "Unknown file extension .ts".
 *
 * Each process owns its own tenant DB handles (via the same bounded LRU
 * `db/client.ts` uses everywhere — `openTenantDbById`/`getDb`) and its own
 * ONNX sessions. Coordination happens entirely through control.db's `jobs`
 * table.
 *
 * Spawned by `pool.ts` via `child_process.spawn`.
 */

import * as queue from './queue'
import { logStageTiming } from '@/lib/stage-timer'
import { handleVisionJob, handleRenderJob, handleBackgroundFillJob, BackgroundNotReadyError } from './worker'
import { CloudinaryServiceError } from '@/services/cloudinary-service'
import { AiExtendQuotaExceededError, AiExtendBusyError } from './ai-extend-dispatcher'
import { closeDb } from '@/db/client'
import { VisionUnavailableError } from '@/vision/types'
import { runWithTenant } from '@/tenancy/context'
import type { BackgroundFillJobPayload, JobKind, RenderJobPayload, VisionJobPayload } from '@/db/types'

interface WorkerConfig {
  workerId: string
  kinds: JobKind[]
  pollIntervalMs: number
}

export type WorkerMessage =
  | { type: 'ready'; workerId: string }
  | {
      type: 'job:started'
      workerId: string
      jobId: string
      kind: JobKind
      tenantId: string
      startedAt: string
    }
  | {
      type: 'job:done'
      workerId: string
      jobId: string
      kind: JobKind
      tenantId: string
      batchId: string | null
      result: unknown
    }
  | {
      type: 'job:failed'
      workerId: string
      jobId: string
      kind: JobKind
      tenantId: string
      batchId: string | null
      error: string
      retrying: boolean
    }
  | { type: 'idle'; workerId: string }

export type PoolCommand = { type: 'stop' }

/**
 * Configuration arrives as a JSON argument rather than through the environment
 * so a pool slot's identity is visible in the process list — useful when
 * diagnosing which worker is pinning a core.
 */
const cfg: WorkerConfig = JSON.parse(process.argv[2] ?? '{}')

if (!cfg.workerId) {
  console.error('[worker] missing configuration argument')
  process.exit(1)
}

/**
 * Backoff when the queue is empty.
 *
 * A flat poll interval means a mostly-idle pool wakes every 250ms forever,
 * which is measurable battery drain and lock churn on a laptop. Backing off to
 * ~2s costs at most that much latency on the first job of a new batch, and the
 * API asks the pool to start the moment it enqueues, so in practice there is no
 * perceived delay.
 */
const MAX_IDLE_INTERVAL_MS = 2000

let running = true

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function post(message: WorkerMessage): void {
  process.send?.(message)
}

async function runOne(kind: JobKind): Promise<boolean> {
  const job = queue.claim(kind, cfg.workerId)
  if (!job) return false

  const jobStart = performance.now()
  logStageTiming({
    tenantId: job.tenantId,
    jobId: job.id,
    stage: 'queue_wait',
    durationMs: Date.now() - new Date(job.createdAt).getTime(),
    kind: job.kind,
    attempt: job.attempts,
  })

  queue.markRunning(job.id, cfg.workerId)
  post({
    type: 'job:started',
    workerId: cfg.workerId,
    jobId: job.id,
    kind: job.kind,
    tenantId: job.tenantId,
    startedAt: new Date().toISOString(),
  })

  // Vision analysis runs for seconds; without a heartbeat the stale-claim
  // sweeper would reclaim a job that is progressing normally.
  const beat = setInterval(() => {
    try {
      queue.heartbeat(job.id, cfg.workerId)
    } catch {
      // Transient lock contention — the next beat covers it.
    }
  }, 5000)

  const tenantCtx = { tenantId: job.tenantId, userId: 'system', role: 'owner' as const }

  try {
    const result = await runWithTenant(tenantCtx, () =>
      job.kind === 'vision'
        ? handleVisionJob(job.payload as VisionJobPayload)
        : job.kind === 'background_fill'
          ? handleBackgroundFillJob(job.payload as BackgroundFillJobPayload, { jobId: job.id })
          : handleRenderJob(job.payload as RenderJobPayload, { batchId: job.batchId })
    )

    queue.complete(job.id, cfg.workerId, result as Record<string, unknown>)

    logStageTiming({
      tenantId: job.tenantId,
      jobId: job.id,
      stage: `${job.kind}:total`,
      durationMs: performance.now() - jobStart,
    })
    // Vision analysis's own sub-stage breakdown (decode/analysis/mask_persist
    // — see src/vision/engine.ts) rides along on the handler's result rather
    // than being logged from inside the engine itself, same reasoning
    // `durationMs` already followed before this change: the engine has no
    // jobId/tenantId of its own to attach to a log line.
    const timings = (result as { timings?: Record<string, number> } | null)?.timings
    if (timings) {
      for (const [stage, ms] of Object.entries(timings)) {
        logStageTiming({ tenantId: job.tenantId, jobId: job.id, stage: `vision:${stage}`, durationMs: ms })
      }
    }

    post({
      type: 'job:done',
      workerId: cfg.workerId,
      jobId: job.id,
      kind: job.kind,
      tenantId: job.tenantId,
      batchId: job.batchId,
      result,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    // Missing models are an environment problem, not a per-image one. Retrying
    // would burn every attempt on every image in the catalog for the same
    // reason and bury the real cause in thousands of identical failures, so
    // park it for an operator to retry once models are installed.
    if (err instanceof VisionUnavailableError) {
      queue.park(job.id, cfg.workerId, message)
      post({
        type: 'job:failed',
        workerId: cfg.workerId,
        jobId: job.id,
        kind: job.kind,
        tenantId: job.tenantId,
        batchId: job.batchId,
        error: message,
        retrying: false,
      })
    } else if (err instanceof AiExtendQuotaExceededError) {
      // A quota (per-tenant or the whole account's circuit breaker) needs a
      // human to raise it or for the next billing period to arrive — not
      // something a retry can fix, and retrying would just restate the same
      // rejection on every attempt across every queued fill for this tenant.
      queue.park(job.id, cfg.workerId, message)
      post({
        type: 'job:failed',
        workerId: cfg.workerId,
        jobId: job.id,
        kind: job.kind,
        tenantId: job.tenantId,
        batchId: job.batchId,
        error: message,
        retrying: false,
      })
    } else if (err instanceof AiExtendBusyError) {
      // Capacity (concurrency or the rate limiter), not the request, was the
      // problem — identical in spirit to a Cloudinary rate-limit response,
      // so it gets the same short, attempt-refunded defer.
      logStageTiming({ tenantId: job.tenantId, jobId: job.id, stage: 'defer:ai_extend_busy', durationMs: queue.BACKGROUND_FILL_POLL_MS })
      queue.defer(job.id, cfg.workerId, queue.BACKGROUND_FILL_POLL_MS, message, { refundAttempt: true })
      post({
        type: 'job:failed',
        workerId: cfg.workerId,
        jobId: job.id,
        kind: job.kind,
        tenantId: job.tenantId,
        batchId: job.batchId,
        error: message,
        retrying: true,
      })
    } else if (err instanceof CloudinaryServiceError && err.kind === 'rate_limited') {
      // Cloudinary throttled us, which says nothing about this job — the
      // work is still valid and will succeed shortly. Backing off without
      // consuming an attempt keeps a burst from converting a temporary rate
      // limit into permanently failed renders across a whole batch. Honor
      // Retry-After when Cloudinary sent one.
      const delayMs = err.retryAfterMs ?? queue.BACKGROUND_FILL_POLL_MS * 4
      logStageTiming({ tenantId: job.tenantId, jobId: job.id, stage: 'defer:rate_limited', durationMs: delayMs })
      queue.defer(job.id, cfg.workerId, delayMs, message, { refundAttempt: true })
      post({
        type: 'job:failed',
        workerId: cfg.workerId,
        jobId: job.id,
        kind: job.kind,
        tenantId: job.tenantId,
        batchId: job.batchId,
        error: message,
        retrying: true,
      })
    } else if (
      err instanceof CloudinaryServiceError &&
      (err.kind === 'auth' || err.kind === 'credits')
    ) {
      // Neither of these can be fixed by trying again — missing credentials
      // or an exhausted generative-credit balance need a person. Retrying
      // would burn every attempt on every image in the batch against the
      // same wall and bury the real cause in identical failures, so park it
      // the way a missing model does.
      queue.park(job.id, cfg.workerId, message)
      post({
        type: 'job:failed',
        workerId: cfg.workerId,
        jobId: job.id,
        kind: job.kind,
        tenantId: job.tenantId,
        batchId: job.batchId,
        error: message,
        retrying: false,
      })
    } else if (err instanceof BackgroundNotReadyError) {
      // Not a failure — this render is correctly declining to occupy a
      // worker slot doing nothing while a `background_fill` job (on its own,
      // separate slots) finishes.
      //
      // Whether this costs an attempt depends on whether that dependency is
      // actually alive. While it is, waiting is free: a bulk run's fill queue
      // can be far deeper than any fixed patience budget, and charging a
      // retry per check is what failed 469 healthy renders on a 554-photo
      // catalogue while every fill was still succeeding. The dependency's own
      // `maxAttempts` guarantees it resolves either way, so this cannot wait
      // forever. If it is NOT alive, the attempt is charged as before, so a
      // render that can never find its dependency still terminates.
      if (err.dependencyActive || job.attempts < job.maxAttempts) {
        logStageTiming({
          tenantId: job.tenantId,
          jobId: job.id,
          stage: 'defer:background_not_ready',
          durationMs: queue.BACKGROUND_FILL_POLL_MS,
          dependencyActive: err.dependencyActive ? 1 : 0,
        })
        queue.defer(job.id, cfg.workerId, queue.BACKGROUND_FILL_POLL_MS, message, {
          refundAttempt: err.dependencyActive,
        })
        post({
          type: 'job:failed',
          workerId: cfg.workerId,
          jobId: job.id,
          kind: job.kind,
          tenantId: job.tenantId,
          batchId: job.batchId,
          error: message,
          retrying: true,
        })
      } else {
        queue.park(job.id, cfg.workerId, `gave up waiting: ${message}`)
        post({
          type: 'job:failed',
          workerId: cfg.workerId,
          jobId: job.id,
          kind: job.kind,
          tenantId: job.tenantId,
          batchId: job.batchId,
          error: `gave up waiting: ${message}`,
          retrying: false,
        })
      }
    } else {
      const { retrying } = queue.fail(job.id, cfg.workerId, message)
      post({
        type: 'job:failed',
        workerId: cfg.workerId,
        jobId: job.id,
        kind: job.kind,
        tenantId: job.tenantId,
        batchId: job.batchId,
        error: message,
        retrying,
      })
    }
  } finally {
    clearInterval(beat)
  }

  return true
}

async function loop(): Promise<void> {
  post({ type: 'ready', workerId: cfg.workerId })

  let idleFor = cfg.pollIntervalMs

  while (running) {
    let didWork = false

    // Kinds are tried in the configured order, so a slot dedicated to vision
    // drains vision first and only helps with renders once analysis is clear.
    for (const kind of cfg.kinds) {
      if (!running) break
      try {
        if (await runOne(kind)) {
          didWork = true
          break
        }
      } catch (err) {
        // A throw here is a queue/database problem, not a job problem. Log and
        // stay alive; losing the worker would be worse.
        console.error(`[worker ${cfg.workerId}] queue error:`, err)
        await sleep(1000)
      }
    }

    if (didWork) {
      idleFor = cfg.pollIntervalMs
    } else {
      post({ type: 'idle', workerId: cfg.workerId })
      await sleep(idleFor)
      idleFor = Math.min(MAX_IDLE_INTERVAL_MS, Math.round(idleFor * 1.5))
    }
  }
}

process.on('message', (message: PoolCommand) => {
  if (message?.type === 'stop') running = false
})

// A pool that dies should not leave orphaned workers holding model weights.
process.on('disconnect', () => {
  running = false
})

loop()
  .catch(err => {
    console.error(`[worker ${cfg.workerId}] fatal:`, err)
    process.exitCode = 1
  })
  .finally(() => {
    closeDb()
    process.exit(process.exitCode ?? 0)
  })
