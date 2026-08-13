/**
 * Worker process entry point.
 *
 * One long-lived child process per pool slot. It loops: claim a job, run it,
 * report over IPC, repeat. ONNX sessions load once per process on the first
 * vision job and stay resident — the ~2s model load would otherwise be paid on
 * every image.
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
 * Each process owns its own SQLite handle (WAL makes concurrent access safe) and
 * its own ONNX sessions. Coordination happens entirely through the jobs table.
 *
 * Spawned by `pool.ts` via `child_process.fork`.
 */

import * as queue from './queue'
import { handleVisionJob, handleRenderJob, handleBackgroundFillJob, BackgroundNotReadyError } from './worker'
import { CloudinaryServiceError } from '@/services/cloudinary-service'
import { closeDb } from '@/db/client'
import { VisionUnavailableError } from '@/vision/types'
import type { BackgroundFillJobPayload, JobKind, RenderJobPayload, VisionJobPayload } from '@/db/types'

interface WorkerConfig {
  workerId: string
  kinds: JobKind[]
  pollIntervalMs: number
}

export type WorkerMessage =
  | { type: 'ready'; workerId: string }
  | {
      type: 'job:done'
      workerId: string
      jobId: string
      kind: JobKind
      batchId: string | null
      result: unknown
    }
  | {
      type: 'job:failed'
      workerId: string
      jobId: string
      kind: JobKind
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
  const [job] = queue.claim(kind, cfg.workerId, 1)
  if (!job) return false

  queue.markRunning(job.id)

  // Vision analysis runs for seconds; without a heartbeat the stale-claim
  // sweeper would reclaim a job that is progressing normally.
  const beat = setInterval(() => {
    try {
      queue.heartbeat(job.id)
    } catch {
      // Transient lock contention — the next beat covers it.
    }
  }, 5000)

  try {
    const result =
      job.kind === 'vision'
        ? await handleVisionJob(job.payload as VisionJobPayload)
        : job.kind === 'background_fill'
          ? await handleBackgroundFillJob(job.payload as BackgroundFillJobPayload)
          : await handleRenderJob(job.payload as RenderJobPayload, { batchId: job.batchId })

    queue.complete(job.id, result as Record<string, unknown>)
    post({
      type: 'job:done',
      workerId: cfg.workerId,
      jobId: job.id,
      kind: job.kind,
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
      queue.park(job.id, message)
      post({
        type: 'job:failed',
        workerId: cfg.workerId,
        jobId: job.id,
        kind: job.kind,
        batchId: job.batchId,
        error: message,
        retrying: false,
      })
    } else if (err instanceof CloudinaryServiceError && err.kind === 'rate_limited') {
      // Cloudinary throttled us, which says nothing about this job — the
      // work is still valid and will succeed shortly. Backing off without
      // consuming an attempt keeps a burst from converting a temporary rate
      // limit into permanently failed renders across a whole batch.
      queue.defer(job.id, queue.BACKGROUND_FILL_POLL_MS * 4, message, { refundAttempt: true })
      post({
        type: 'job:failed',
        workerId: cfg.workerId,
        jobId: job.id,
        kind: job.kind,
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
      queue.park(job.id, message)
      post({
        type: 'job:failed',
        workerId: cfg.workerId,
        jobId: job.id,
        kind: job.kind,
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
        queue.defer(job.id, queue.BACKGROUND_FILL_POLL_MS, message, {
          refundAttempt: err.dependencyActive,
        })
        post({
          type: 'job:failed',
          workerId: cfg.workerId,
          jobId: job.id,
          kind: job.kind,
          batchId: job.batchId,
          error: message,
          retrying: true,
        })
      } else {
        queue.park(job.id, `gave up waiting: ${message}`)
        post({
          type: 'job:failed',
          workerId: cfg.workerId,
          jobId: job.id,
          kind: job.kind,
          batchId: job.batchId,
          error: `gave up waiting: ${message}`,
          retrying: false,
        })
      }
    } else {
      const { retrying } = queue.fail(job.id, message)
      post({
        type: 'job:failed',
        workerId: cfg.workerId,
        jobId: job.id,
        kind: job.kind,
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
