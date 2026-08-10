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
import { InpaintServiceError } from '@/services/inpaint-client'
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
    } else if (err instanceof InpaintServiceError && err.kind === 'busy') {
      // The GPU is working on someone else's image. Nothing is wrong, so
      // this must not consume an attempt — and critically must not queue
      // behind the running generation, which is what turned a 73-second
      // workload into an hours-long backlog. Step aside and come back.
      queue.defer(job.id, queue.BACKGROUND_FILL_POLL_MS, message, { refundAttempt: true })
      post({
        type: 'job:failed',
        workerId: cfg.workerId,
        jobId: job.id,
        kind: job.kind,
        batchId: job.batchId,
        error: message,
        retrying: true,
      })
    } else if (err instanceof BackgroundNotReadyError) {
      // Not a failure — this render is correctly declining to occupy a
      // worker slot doing nothing while a `background_fill` job (on its own,
      // separate slots) finishes. Deferred rather than failed-and-retried:
      // see `queue.defer` for why attempts are left untouched, and only give
      // up for real once they run out anyway, same ceiling a genuine failure
      // would hit.
      if (job.attempts < job.maxAttempts) {
        queue.defer(job.id, queue.BACKGROUND_FILL_POLL_MS, message)
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
