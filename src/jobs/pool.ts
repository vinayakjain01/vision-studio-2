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
 * ── Per-job tenant binding (P3) ──────────────────────────────────────────────
 * This pool is a singleton living in the WEB process, but it holds NO tenant
 * context of its own (the P1/P2 bridge, `withDefaultTenant`/
 * `resolveDefaultTenantId`, is gone — see the deleted
 * src/jobs/default-tenant.ts). `start()`'s own `reclaimStale()` call and the
 * sweeper are genuinely cross-tenant and need none; `refreshBatch` below binds
 * whichever tenant the job:done/job:failed IPC message actually reported,
 * since control.db's jobs table (where claiming happens) has no notion of
 * "the" tenant the way a single-tenant queue used to.
 *
 * Server-only.
 */

import os from 'os'
import path from 'path'
import type { ChildProcess } from 'child_process'
import { config } from '@/config'
import * as queue from './queue'
import { batches } from '@/db/repositories'
import { runWithTenant } from '@/tenancy/context'
import { tenants } from '@/db/control-repositories'
import { sweepOrphanedMedia } from '@/services/cleanup-service'
import { reconcileStorageUsage, sweepStaleTmpFiles } from '@/storage/media-store'
import { backfillHourlyRollups, pruneHourlyRollups } from './queue-wait-rollup'
import type { JobKind } from '@/db/types'
import type { WorkerMessage } from './worker-entry'

export interface PoolStatus {
  running: boolean
  workers: { id: string; kinds: JobKind[]; state: 'starting' | 'idle' | 'busy' | 'stopped'; pid: number | null }[]
  completed: number
  failed: number
  startedAt: string | null
}

export interface CurrentJob {
  jobId: string
  kind: JobKind
  tenantId: string
  startedAt: number
}

interface WorkerHandle {
  id: string
  kinds: JobKind[]
  child: ChildProcess
  state: 'starting' | 'idle' | 'busy' | 'stopped'
  restarts: number
  currentJob: CurrentJob | null
}

/**
 * The watchdog's decision logic, pulled out as a pure function so it can be
 * unit-tested directly against synthetic `CurrentJob`/`now` values without
 * spawning a real worker process or loading the vision engine — see
 * tests/jobs/pool-watchdog.test.ts. `WorkerPool.checkWatchdog()` is a thin
 * wrapper that calls this, then performs the actual kill + queue.fail() side
 * effects (both already exercised elsewhere: `child.kill()` is a single
 * Node API call, and `queue.fail()` has its own thorough test coverage in
 * tests/jobs/queue.test.ts).
 */
export function isJobHung(
  job: Pick<CurrentJob, 'kind' | 'startedAt'>,
  now: number,
  maxRuntimeMs: Record<JobKind, number>
): boolean {
  return now - job.startedAt > maxRuntimeMs[job.kind]
}

/** A worker that crashes this many times is not respawned again. */
const MAX_RESTARTS = 5

/** How often the watchdog checks for a job that's exceeded its kind's max runtime — tighter than the 60s stale-claim sweep, since a hung job should be caught close to its actual threshold, not up to a minute late. */
const WATCHDOG_INTERVAL_MS = 10_000

class WorkerPool {
  private handles: WorkerHandle[] = []
  private started = false
  private startedAt: string | null = null
  private completed = 0
  private failed = 0
  private sweeper: NodeJS.Timeout | null = null
  private watchdog: NodeJS.Timeout | null = null
  private maintenanceSweeper: NodeJS.Timeout | null = null

  isRunning(): boolean {
    return this.started
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.startedAt = new Date().toISOString()

    // A previous run may have died mid-job. Return anything abandoned to the
    // queue before workers start competing for it. Global — every tenant's
    // stale claims, not just one.
    const reclaimed = queue.reclaimStale()
    if (reclaimed > 0) {
      console.log(`[pool] reclaimed ${reclaimed} stale job(s) from a previous run`)
    }
    queue.reconcileRunningJobs()

    const visionSlots = config.jobs.visionConcurrency
    const renderSlots = config.jobs.renderConcurrency
    const backgroundFillSlots = config.cloudinary.jobConcurrency

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
    // groups above: this workload is a remote API call to Cloudinary, not
    // local CPU work, so sizing it off `visionSlots`/`renderSlots` — or
    // letting it share their slots as overflow, the way vision slots pick up
    // renders — would size a network-bound, rate-limited, PAID queue by
    // local-CPU-bound logic. Kept small by default for the same reason; see
    // `config.cloudinary.jobConcurrency`.
    for (let i = 0; i < backgroundFillSlots; i++) {
      plan.push({ id: `bgfill-${i}`, kinds: ['background_fill'] })
    }

    // Spawned one at a time rather than all at once. A vision worker's first
    // job is loading four ONNX graphs from disk — real CPU and I/O cost — and
    // doing that for every worker in the same instant is its own burst of
    // contention stacked on top of whatever running them concurrently costs
    // afterward. Waiting for each to report ready (or an 8s cap, so one that
    // never reports does not stall the rest) spreads that one-time cost out
    // instead of paying all of it in the same second.
    void this.spawnStaggered(plan)

    // Safety net for a worker that dies without reporting, plus the periodic
    // scheduler reconciliation the design note calls for.
    this.sweeper = setInterval(() => {
      try {
        queue.reclaimStale()
        queue.reconcileRunningJobs()
        queue.promoteAgedBulkJobs()
      } catch {
        // Transient lock contention; the next sweep covers it.
      }
    }, 60_000)
    this.sweeper.unref?.()

    this.watchdog = setInterval(() => this.checkWatchdog(), WATCHDOG_INTERVAL_MS)
    this.watchdog.unref?.()

    // Slower sweep: job retention pruning (control.db only, no tenant
    // context needed) plus, per tenant, the media orphan sweep and storage-
    // usage reconciliation — both a real disk walk, which is why this runs
    // on its own much longer interval rather than piggybacking on the fast
    // sweep above. Runs once at startup too, not just after the first
    // interval elapses, so a long-idle install doesn't wait
    // `maintenanceSweepIntervalMs` for its first prune.
    void this.runMaintenanceSweep()
    this.maintenanceSweeper = setInterval(
      () => void this.runMaintenanceSweep(),
      config.jobs.maintenanceSweepIntervalMs
    )
    this.maintenanceSweeper.unref?.()

    console.log(
      `[pool] starting — ${visionSlots} vision worker(s), ${renderSlots} render worker(s), ` +
      `${backgroundFillSlots} background-fill worker(s), ` +
      `${config.vision.ortThreads} ORT thread(s) each, staggered`
    )
  }

  /**
   * Job retention pruning, the P5 admin page's hourly queue-wait rollup
   * backfill (see queue-wait-rollup.ts), plus, per tenant, the media orphan
   * sweep, storage-usage reconciliation (see media-store.ts's
   * `reconcileStorageUsage` doc comment for why the incremental counter
   * needs this backstop), and a stale-upload-tmp-file sweep (see
   * `sweepStaleTmpFiles`'s doc comment). Each tenant's media walk runs
   * under its own `runWithTenant` — these are the operations in this file
   * that actually need tenant context, unlike the fast sweep's queue
   * functions, which are deliberately global. One tenant's sweep failing (a
   * locked file, a mid-flight write) is caught and logged per-tenant so it
   * never skips every OTHER tenant's sweep in the same pass.
   */
  private async runMaintenanceSweep(): Promise<void> {
    try {
      const pruned = queue.prune()
      if (pruned > 0) console.log(`[pool] pruned ${pruned} job row(s) past retention`)
    } catch (err) {
      console.warn('[pool] job retention prune failed:', (err as Error).message)
    }

    try {
      const backfilled = backfillHourlyRollups()
      if (backfilled > 0) console.log(`[pool] backfilled ${backfilled} hourly queue-wait rollup bucket(s)`)
      pruneHourlyRollups()
    } catch (err) {
      console.warn('[pool] queue-wait rollup backfill failed:', (err as Error).message)
    }

    for (const tenant of tenants.list()) {
      try {
        await runWithTenant({ tenantId: tenant.id, userId: 'system', role: 'owner' }, async () => {
          const swept = await sweepOrphanedMedia()
          await reconcileStorageUsage()
          const staleTmp = await sweepStaleTmpFiles(config.jobs.uploadTmpTtlMs)
          if (swept.orphanedOriginals + swept.orphanedDerived + swept.orphanedCreatives > 0) {
            console.log(`[pool] tenant ${tenant.id}: swept ${JSON.stringify(swept)}`)
          }
          if (staleTmp > 0) {
            console.log(`[pool] tenant ${tenant.id}: removed ${staleTmp} stale upload tmp file(s)`)
          }
        })
      } catch (err) {
        console.warn(`[pool] maintenance sweep failed for tenant ${tenant.id}:`, (err as Error).message)
      }
    }
  }

  /**
   * A job whose 'running' status has outlived its kind's configured max
   * runtime is presumed hung — not merely slow (see `config.jobs.maxRuntimeMs`'s
   * doc comment on why `background_fill`'s wait-for-dependency pattern never
   * triggers this). The worker holding it is killed and respawned, and the
   * job is explicitly failed (counting an attempt) rather than left for the
   * much-slower stale-claim sweep to eventually notice via a missed
   * heartbeat — the worker is still alive and heartbeating just fine; it is
   * the JOB that is stuck, e.g. in a native call with no cooperative
   * cancellation point.
   */
  private checkWatchdog(): void {
    const now = Date.now()
    for (const handle of this.handles) {
      const job = handle.currentJob
      if (!job || !isJobHung(job, now, config.jobs.maxRuntimeMs)) continue
      const maxRuntimeMs = config.jobs.maxRuntimeMs[job.kind]

      console.warn(
        `[pool] worker ${handle.id} job ${job.jobId} (${job.kind}) exceeded ${maxRuntimeMs}ms — killing and respawning`
      )

      try {
        queue.fail(job.jobId, handle.id, `watchdog: exceeded max runtime (${maxRuntimeMs}ms) for kind '${job.kind}'`)
      } catch (err) {
        console.warn(`[pool] watchdog fail() call errored for job ${job.jobId}:`, (err as Error).message)
      }

      handle.currentJob = null
      // The 'exit' handler's existing crash-recovery path (below) respawns
      // this slot the same way a native crash would.
      handle.child.kill('SIGKILL')
    }
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

    // Below-normal priority. Workers are CPU-bound for their whole life; at equal
    // priority they compete with this web process for the same cores, and an
    // import's upload requests (and the UI polling them) queue behind analysis —
    // the progress bar stalls while the machine is busy doing the very work the
    // upload is feeding. Workers lose nothing: on an otherwise idle CPU they
    // still get all of it, and only yield when the web process needs a slice.
    if (child.pid) {
      try {
        os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
      } catch {
        // Not permitted on this host; run at normal priority.
      }
    }

    const handle: WorkerHandle = { id, kinds, child, state: 'starting', restarts, currentJob: null }

    child.on('message', (message: WorkerMessage) => {
      switch (message.type) {
        case 'ready':
        case 'idle':
          handle.state = 'idle'
          handle.currentJob = null
          break
        case 'job:started':
          handle.state = 'busy'
          handle.currentJob = {
            jobId: message.jobId,
            kind: message.kind,
            tenantId: message.tenantId,
            startedAt: new Date(message.startedAt).getTime(),
          }
          break
        case 'job:done':
          handle.state = 'busy'
          handle.currentJob = null
          this.completed++
          if (message.batchId) this.refreshBatch(message.tenantId, message.batchId)
          break
        case 'job:failed':
          handle.state = 'busy'
          handle.currentJob = null
          if (!message.retrying) this.failed++
          console.warn(
            `[pool] job ${message.jobId} failed${message.retrying ? ' (will retry)' : ''}: ${message.error}`
          )
          if (message.batchId) this.refreshBatch(message.tenantId, message.batchId)
          break
      }
    })

    child.on('error', err => {
      console.error(`[pool] worker ${id} could not be spawned:`, err.message)
      handle.state = 'stopped'
    })

    child.on('exit', (code, signal) => {
      handle.state = 'stopped'
      handle.currentJob = null
      if (!this.started) return

      // A clean exit means we asked it to stop. Anything else is a crash — a
      // native fault in ONNX, sharp or skia, or the watchdog killing a hung
      // job — and the job it held is recovered by the stale sweep (or was
      // already explicitly failed by the watchdog before the kill).
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

  private refreshBatch(tenantId: string, batchId: string): void {
    try {
      runWithTenant({ tenantId, userId: 'system', role: 'owner' }, () => {
        batches.refresh(batchId, queue.batchJobCounts(tenantId, batchId))
      })
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
    if (this.watchdog) {
      clearInterval(this.watchdog)
      this.watchdog = null
    }
    if (this.maintenanceSweeper) {
      clearInterval(this.maintenanceSweeper)
      this.maintenanceSweeper = null
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
