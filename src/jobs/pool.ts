/**
 * Worker pool.
 *
 * Spawns N long-lived child processes that drain the job queue. Started lazily
 * the first time work is enqueued, so a browsing-only session pays for neither
 * idle processes nor loaded models.
 *
 * ── Processes, not threads ───────────────────────────────────────────────────
 * Every worker drives four native addons: ONNX Runtime, sharp, better-sqlite3
 * and skia. In a worker thread they share the web server's address space, so a
 * native fault in any of them takes the server down — which is exactly what
 * happened during development. Separate processes turn that into a non-zero
 * exit the pool can requeue and respawn from.
 *
 * The secondary benefit is that `execArgv: ['--import', 'tsx']` is honoured at
 * process startup, so the worker runs its TypeScript source directly. Worker
 * threads ignore it and fail to resolve `.ts` at all.
 *
 * ── Sizing ───────────────────────────────────────────────────────────────────
 * Vision slots are bounded by MEMORY, not core count. Each one holds ~165 MB of
 * model weights plus activations for a 640² and a 512² graph — call it 700 MB
 * resident. Sizing them by `cores - 1` puts eight such processes on a 12-core
 * laptop and exhausts RAM. Render slots are cheap and bounded by cores.
 *
 * ORT's own intra-op thread count is bounded too. Left at its default each
 * session spawns roughly one thread per core, so a handful of workers becomes
 * a hundred native threads fighting over twelve cores and throughput collapses.
 *
 * Server-only.
 */

import path from 'path'
import type { ChildProcess } from 'child_process'
import { config } from '@/config'
import * as queue from './queue'
import { batches } from '@/db/repositories'
import type { JobKind } from '@/db/types'
import type { WorkerMessage } from './worker-entry'

export interface PoolStatus {
  running: boolean
  workers: { id: string; kinds: JobKind[]; state: 'starting' | 'idle' | 'busy' | 'stopped'; pid: number | null }[]
  completed: number
  failed: number
  startedAt: string | null
}

interface WorkerHandle {
  id: string
  kinds: JobKind[]
  child: ChildProcess
  state: 'starting' | 'idle' | 'busy' | 'stopped'
  restarts: number
}

/** A worker that crashes this many times is not respawned again. */
const MAX_RESTARTS = 5

class WorkerPool {
  private handles: WorkerHandle[] = []
  private started = false
  private startedAt: string | null = null
  private completed = 0
  private failed = 0
  private sweeper: NodeJS.Timeout | null = null

  isRunning(): boolean {
    return this.started
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.startedAt = new Date().toISOString()

    // A previous run may have died mid-job. Return anything abandoned to the
    // queue before workers start competing for it.
    const reclaimed = queue.reclaimStale()
    if (reclaimed > 0) {
      console.log(`[pool] reclaimed ${reclaimed} stale job(s) from a previous run`)
    }

    const visionSlots = config.jobs.visionConcurrency
    const renderSlots = config.jobs.renderConcurrency
    const inpaintSlots = config.inpaint.jobConcurrency

    const plan: { id: string; kinds: JobKind[] }[] = []
    for (let i = 0; i < visionSlots; i++) {
      // Vision-first, but these slots pick up renders once analysis is drained,
      // so a pure-render batch still uses the whole machine.
      plan.push({ id: `vision-${i}`, kinds: ['vision', 'render'] })
    }
    for (let i = 0; i < renderSlots; i++) {
      plan.push({ id: `render-${i}`, kinds: ['render'] })
    }
    // Deliberately its own slot group, never folded into the vision/render
    // groups above: this workload is a network call to a GPU host, not local
    // CPU work, and sizing it off `visionSlots`/`renderSlots` (or letting it
    // share their slots as overflow, the way vision slots pick up renders)
    // would size a remote-GPU-bound queue by local-CPU-bound logic. See
    // `config.inpaint.jobConcurrency` for why CPU test mode hard-caps this
    // at 1 regardless of what's configured.
    for (let i = 0; i < inpaintSlots; i++) {
      plan.push({ id: `inpaint-${i}`, kinds: ['background_fill'] })
    }

    // Spawned one at a time rather than all at once. A vision worker's first
    // job is loading four ONNX graphs from disk — real CPU and I/O cost — and
    // doing that for every worker in the same instant is its own burst of
    // contention stacked on top of whatever running them concurrently costs
    // afterward. Waiting for each to report ready (or an 8s cap, so one that
    // never reports does not stall the rest) spreads that one-time cost out
    // instead of paying all of it in the same second.
    void this.spawnStaggered(plan)

    // Safety net for a worker that dies without reporting.
    this.sweeper = setInterval(() => {
      try {
        queue.reclaimStale()
      } catch {
        // Transient lock contention; the next sweep covers it.
      }
    }, 60_000)
    this.sweeper.unref?.()

    console.log(
      `[pool] starting — ${visionSlots} vision worker(s), ${renderSlots} render worker(s), ` +
      `${inpaintSlots} inpaint worker(s) (${config.inpaint.device}), ` +
      `${config.vision.ortThreads} ORT thread(s) each, staggered`
    )
  }

  private async spawnStaggered(plan: { id: string; kinds: JobKind[] }[]): Promise<void> {
    for (const { id, kinds } of plan) {
      if (!this.started) return
      const handle = this.spawn(id, kinds, 0)
      await this.waitUntilPastStarting(handle, 8000)
    }
  }

  /** Resolves once the worker reports in (ready/idle/busy) or a cap elapses. */
  private waitUntilPastStarting(handle: WorkerHandle, timeoutMs: number): Promise<void> {
    if (handle.state !== 'starting') return Promise.resolve()
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        clearInterval(poll)
        resolve()
      }, timeoutMs)
      const poll = setInterval(() => {
        if (handle.state !== 'starting') {
          clearInterval(poll)
          clearTimeout(timer)
          resolve()
        }
      }, 100)
    })
  }

  private spawn(id: string, kinds: JobKind[], restarts: number): WorkerHandle {
    const { spawn } = require('node:child_process') as typeof import('child_process')

    const entry = path.join(process.cwd(), 'src', 'jobs', 'worker-entry.ts')
    const workerConfig = {
      workerId: id,
      kinds,
      pollIntervalMs: config.jobs.pollIntervalMs,
    }

    // `spawn` rather than `fork`, deliberately. Turbopack treats `fork(<path>)`
    // as a module reference and tries to pull the worker entry into this route's
    // module graph, which fails because the path is computed at runtime. `spawn`
    // takes an EXECUTABLE, so there is nothing for the bundler to resolve — and
    // an 'ipc' stdio slot gives the same `child.send()` / `'message'` channel
    // that `fork` would have provided.
    //
    // tsx lets the worker run its TypeScript source directly, in development and
    // production alike. `next build` compiles route handlers, not arbitrary
    // modules, so there is no compiled entry to point at — and one code path for
    // both modes removes a class of production-only failure from the component
    // doing the actual work.
    const child: ChildProcess = spawn(
      process.execPath,
      ['--import', 'tsx', entry, JSON.stringify(workerConfig)],
      {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        env: {
          ...process.env,
          // Bound ORT's internal parallelism per worker. Unbounded, each session
          // spawns ~one thread per core and the pool oversubscribes the machine
          // several times over.
          VISION_ORT_THREADS: String(config.vision.ortThreads),
        },
      }
    )

    const handle: WorkerHandle = { id, kinds, child, state: 'starting', restarts }

    child.on('message', (message: WorkerMessage) => {
      switch (message.type) {
        case 'ready':
        case 'idle':
          handle.state = 'idle'
          break
        case 'job:done':
          handle.state = 'busy'
          this.completed++
          if (message.batchId) this.refreshBatch(message.batchId)
          break
        case 'job:failed':
          handle.state = 'busy'
          if (!message.retrying) this.failed++
          console.warn(
            `[pool] job ${message.jobId} failed${message.retrying ? ' (will retry)' : ''}: ${message.error}`
          )
          if (message.batchId) this.refreshBatch(message.batchId)
          break
      }
    })

    child.on('error', err => {
      console.error(`[pool] worker ${id} could not be spawned:`, err.message)
      handle.state = 'stopped'
    })

    child.on('exit', (code, signal) => {
      handle.state = 'stopped'
      if (!this.started) return

      // A clean exit means we asked it to stop. Anything else is a crash — a
      // native fault in ONNX, sharp or skia — and the job it held is recovered
      // by the stale sweep.
      if (code === 0 && !signal) return

      console.warn(
        `[pool] worker ${id} exited unexpectedly (code=${code} signal=${signal ?? 'none'})`
      )

      if (handle.restarts >= MAX_RESTARTS) {
        console.error(
          `[pool] worker ${id} crashed ${handle.restarts} times; not respawning. ` +
          `Check for a corrupt image or insufficient memory.`
        )
        return
      }

      // Respawn after a short delay so a reproducible crash does not become a
      // hot loop.
      setTimeout(() => {
        if (!this.started) return
        this.handles = this.handles.filter(h => h !== handle)
        this.spawn(id, kinds, handle.restarts + 1)
      }, 2000)
    })

    // Do not hold the parent process open on the worker's account.
    child.unref()
    this.handles.push(handle)
    return handle
  }

  private refreshBatch(batchId: string): void {
    try {
      batches.refresh(batchId)
    } catch (err) {
      console.warn(`[pool] batch refresh failed for ${batchId}:`, (err as Error).message)
    }
  }

  status(): PoolStatus {
    return {
      running: this.started,
      workers: this.handles.map(h => ({
        id: h.id,
        kinds: h.kinds,
        state: h.state,
        pid: h.child.pid ?? null,
      })),
      completed: this.completed,
      failed: this.failed,
      startedAt: this.startedAt,
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false

    if (this.sweeper) {
      clearInterval(this.sweeper)
      this.sweeper = null
    }

    for (const handle of this.handles) {
      try {
        handle.child.send({ type: 'stop' })
      } catch {
        // Channel already closed.
      }
    }

    // Give workers a moment to finish the job in hand, then kill.
    await Promise.all(
      this.handles.map(
        handle =>
          new Promise<void>(resolve => {
            if (handle.state === 'stopped') return resolve()
            const timer = setTimeout(() => {
              handle.child.kill('SIGKILL')
              resolve()
            }, 8000)
            handle.child.once('exit', () => {
              clearTimeout(timer)
              resolve()
            })
          })
      )
    )

    this.handles = []
  }
}

declare global {
  var __visionStudioPool: WorkerPool | undefined
}

export function getPool(): WorkerPool {
  if (!global.__visionStudioPool) {
    global.__visionStudioPool = new WorkerPool()
  }
  return global.__visionStudioPool
}

/**
 * Ensure workers are running. Call after enqueuing.
 *
 * Idempotent and cheap once started, so route handlers can call it
 * unconditionally rather than tracking pool state themselves.
 */
export function ensurePoolRunning(): void {
  getPool().start()
}
