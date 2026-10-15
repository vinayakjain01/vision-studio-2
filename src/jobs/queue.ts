/**
 * Job queue, backed by control.db's `jobs` table — global across every
 * tenant (see docs/MULTI_TENANCY.md §3.1/§3.2/§5 and control-schema.sql's
 * module doc for why it moved out of each tenant's own app.db).
 *
 * ── Tenant scoping ───────────────────────────────────────────────────────────
 * Every function that reads or writes a SPECIFIC tenant's jobs takes
 * `tenantId` as an explicit parameter — never ambient `currentTenant()` the
 * way `getDb()` works. That's deliberate: this table is the one place in the
 * app where code legitimately needs to reason ACROSS tenants (the scheduler),
 * so a function signature that silently assumed "whichever tenant is
 * currently in context" would be the wrong default here, unlike every
 * tenant-local repository. `claim()` is the one function with no tenant
 * parameter at all — picking which tenant's job to run IS its job.
 *
 * ── Claiming ─────────────────────────────────────────────────────────────────
 * One `BEGIN IMMEDIATE` transaction per claim: probe each tenant (in fairness
 * order) for an eligible job, then a conditional `UPDATE ... WHERE
 * status = 'pending'` on the one found. IMMEDIATE takes the write lock up
 * front, so there is no race to lose between the probe and the update the
 * way a `DEFERRED` transaction would allow — `changes` is always 1 if a
 * candidate was found. See `claim()`'s own doc comment for why this is a
 * bounded number of indexed point-lookups (cost ~ number of tenants), not a
 * scan of the whole table (cost ~ number of pending jobs).
 *
 * ── Crash recovery ───────────────────────────────────────────────────────────
 * `lease_expires_at` is set at claim time and refreshed on every heartbeat.
 * `reclaimStale()` returns anything whose lease has expired to `pending` (or
 * fails it outright if `max_attempts` is already exhausted), and decrements
 * the owning tenant's `running_jobs`.
 *
 * ── Stale writers ────────────────────────────────────────────────────────────
 * `complete()`/`fail()`/`defer()`/`park()`/`markRunning()`/`heartbeat()` all
 * check `worker_id` AND current `status` before writing. A worker reclaimed
 * for going silent that turns out to still be alive (a long GC pause, not a
 * crash) finds its own write rejected as stale rather than overwriting
 * whatever the NEW claimant already did — logged, not thrown, since this is
 * an expected race under lease-based recovery, not a bug.
 *
 * ── Idempotency ──────────────────────────────────────────────────────────────
 * `dedupeKey` has a partial unique index over live statuses, scoped to
 * `(tenant_id, dedupe_key)` — re-requesting analysis for an image already
 * queued is a no-op, and two tenants with byte-identical photos can never
 * suppress each other's jobs.
 *
 * Server-only.
 */

import { getControlDb, getDb, nowIso, transactionOn, parseJson, type Db } from '@/db/client'
import { newId } from '@/db/repositories'
import { config } from '@/config'
import type { JobKind, JobPayload, JobPriorityClass, JobRecord, JobStatus, RenderJobPayload } from '@/db/types'

export const BACKGROUND_FILL_POLL_MS = 5_000
export const BACKGROUND_FILL_RETRY_COOLDOWN_MS = 20_000

/** A user-initiated batch at or under this size is 'interactive' class — see JobPriorityClass's doc comment. */
export const INTERACTIVE_BATCH_MAX_JOBS = 20

export function classifyBatchPriority(jobCount: number): JobPriorityClass {
  return jobCount <= INTERACTIVE_BATCH_MAX_JOBS ? 'interactive' : 'bulk'
}

function controlTx<T>(fn: (db: Db) => T): T {
  return transactionOn(getControlDb(), fn)
}

function toJob<P = JobPayload>(row: any): JobRecord<P> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind,
    priorityClass: row.priority_class,
    status: row.status,
    priority: row.priority,
    batchId: row.batch_id,
    dedupeKey: row.dedupe_key,
    payload: parseJson(row.payload, {} as P),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    workerId: row.worker_id,
    claimedAt: row.claimed_at,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    availableAt: row.available_at,
    error: row.error,
    result: parseJson<Record<string, unknown> | null>(row.result, null),
    createdAt: row.created_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

/**
 * Exponential backoff with jitter for a retried job. `attempts` has already
 * been incremented at claim time, so attempt 1 waits ~2x the base, not the
 * base itself — deliberately a little conservative, since the thing being
 * protected against (a hot retry loop against a transient problem) costs
 * more than a slightly longer first wait.
 */
function retryBackoffMs(attempts: number): number {
  const base = 2_000
  const max = 60_000
  const exp = Math.min(max, base * 2 ** Math.max(0, attempts))
  return Math.round(exp + Math.random() * exp * 0.2)
}

// ─── Enqueue ─────────────────────────────────────────────────────────────────

export interface EnqueueInput {
  kind: JobKind
  payload: JobPayload
  /** Lower runs sooner, within this tenant's own queue. Default 100. */
  priority?: number
  /** Default 'bulk' — see classifyBatchPriority() for the usual way this is decided. */
  priorityClass?: JobPriorityClass
  batchId?: string | null
  /** Suppresses a duplicate while an identical job (same tenant) is still live. */
  dedupeKey?: string | null
  maxAttempts?: number
}

export interface EnqueueResult {
  inserted: number
  deduplicated: number
  ids: string[]
}

/**
 * Insert jobs for ONE tenant, skipping any whose dedupe key is already live.
 * One transaction for the whole batch — see the original single-tenant
 * version's doc comment on why (thousands of individual fsyncs vs. one).
 */
export function enqueue(tenantId: string, inputs: EnqueueInput[]): EnqueueResult {
  if (inputs.length === 0) return { inserted: 0, deduplicated: 0, ids: [] }

  return controlTx(db => {
    const insert = db.prepare(
      `INSERT INTO jobs (id, tenant_id, kind, priority_class, status, priority, batch_id, dedupe_key,
                         payload, attempts, max_attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, 0, ?, ?, ?)`
    )

    const ids: string[] = []
    let deduplicated = 0

    for (const input of inputs) {
      const id = newId('job')
      const ts = nowIso()
      try {
        insert.run(
          id,
          tenantId,
          input.kind,
          input.priorityClass ?? 'bulk',
          input.priority ?? 100,
          input.batchId ?? null,
          input.dedupeKey ?? null,
          JSON.stringify(input.payload),
          input.maxAttempts ?? config.jobs.maxAttempts,
          ts,
          ts
        )
        ids.push(id)
      } catch (err: any) {
        if (typeof err?.message === 'string' && err.message.includes('UNIQUE constraint failed')) {
          deduplicated++
          continue
        }
        throw err
      }
    }

    return { inserted: ids.length, deduplicated, ids }
  })
}

// ─── Claiming ────────────────────────────────────────────────────────────────

/**
 * One tenant's oldest eligible job of `kind`/`priorityClass`, or undefined.
 * An index seek on `idx_jobs_tenant_claim (tenant_id, kind, status,
 * priority_class, priority, created_at)` — cost is independent of how many
 * OTHER tenants' jobs exist, which is what makes probing every tenant in
 * `claimCandidate` below cheap even at a large total job count.
 */
function probeTenant(
  db: Db,
  tenantId: string,
  kind: JobKind,
  priorityClass: JobPriorityClass,
  now: string
): string | undefined {
  const row = db
    .prepare(
      `SELECT id FROM jobs
       WHERE tenant_id = ? AND kind = ? AND status = 'pending' AND priority_class = ?
         AND (available_at IS NULL OR available_at <= ?)
       ORDER BY priority ASC, created_at ASC
       LIMIT 1`
    )
    .get(tenantId, kind, priorityClass, now) as { id: string } | undefined
  return row?.id
}

/**
 * Among tenants with at least one eligible `kind`/`priorityClass` job, the
 * one with the lowest `running_jobs / weight` — ties broken by that tenant's
 * own oldest/highest-priority job, which `probeTenant` already returns.
 *
 * `tenant_queue_state` has at most a few dozen rows in any real deployment,
 * so ordering it fully and then probing each tenant in turn (stopping at the
 * first hit) is a handful of cheap index seeks, never a scan proportional to
 * the jobs table's total size — see this module's doc comment and the P3
 * benchmark script (scripts/bench-claim.ts) for the measured numbers.
 */
function claimCandidate(
  db: Db,
  kind: JobKind,
  priorityClass: JobPriorityClass,
  now: string
): { tenantId: string; jobId: string } | null {
  // Joined against `tenants` so a suspended or pending-deletion tenant's
  // jobs are never claimed — both tables are sized by TENANT count, not job
  // count, so this join costs nothing like the `jobs` table scans this
  // function exists to avoid (see docs/MULTI_TENANCY.md §3.2 and
  // scripts/bench-claim.ts). A suspended tenant's queued jobs stay queued
  // (not deleted) and simply never surface here; a resume makes them
  // claimable again with no other change needed.
  const tenants = db
    .prepare(
      `SELECT tqs.tenant_id AS tenant_id FROM tenant_queue_state tqs
       JOIN tenants t ON t.id = tqs.tenant_id
       WHERE t.status = 'active'
       ORDER BY (CAST(tqs.running_jobs AS REAL) / tqs.weight) ASC`
    )
    .all() as { tenant_id: string }[]

  for (const { tenant_id: tenantId } of tenants) {
    const jobId = probeTenant(db, tenantId, kind, priorityClass, now)
    if (jobId) return { tenantId, jobId }
  }
  return null
}

/**
 * Claim exactly one job of `kind`, across every tenant, fairly.
 *
 * Interactive-class work is tried FIRST, across all tenants (fairness-ordered
 * among tenants that have any) — a tenant's own interactive job jumps its own
 * bulk backlog, and interactive work is ALSO fair-shared across tenants, so
 * one tenant spamming interactive requests cannot starve another's. Only
 * when no interactive job of this kind exists anywhere does a bulk job get
 * claimed, same fairness ordering.
 *
 * This is how "reserve at least one render slot for interactive" is
 * satisfied: every worker slot (not just one reserved one) checks interactive
 * first on every claim, so the instant an interactive job is enqueued, the
 * very next slot to finish its current job (there is no preemption — jobs
 * are short) picks it up ahead of any bulk work, regardless of which tenant
 * either belongs to.
 */
export function claim(kind: JobKind, workerId: string): JobRecord | null {
  return controlTx(db => {
    const now = nowIso()
    const picked = claimCandidate(db, kind, 'interactive', now) ?? claimCandidate(db, kind, 'bulk', now)
    if (!picked) return null

    const leaseExpiresAt = new Date(Date.now() + config.jobs.staleClaimMs).toISOString()
    const info = db
      .prepare(
        `UPDATE jobs
         SET status = 'claimed', worker_id = ?, claimed_at = ?, lease_expires_at = ?, heartbeat_at = ?,
             attempts = attempts + 1, updated_at = ?
         WHERE id = ? AND status = 'pending'`
      )
      .run(workerId, now, leaseExpiresAt, now, now, picked.jobId)

    // Always 1 under BEGIN IMMEDIATE — we hold the write lock for the whole
    // probe-then-update, so nothing else could have claimed it in between.
    // Treated as a hard invariant rather than silently returning a job that
    // was not actually (re-)claimed.
    if (info.changes !== 1) {
      throw new Error(`claim(): expected to claim job ${picked.jobId} but it was not pending`)
    }

    db.prepare('UPDATE tenant_queue_state SET running_jobs = running_jobs + 1 WHERE tenant_id = ?').run(
      picked.tenantId
    )

    return toJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(picked.jobId))
  })
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export function markRunning(jobId: string, workerId: string): void {
  const now = nowIso()
  getControlDb()
    .prepare(
      `UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?),
                       heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND worker_id = ? AND status IN ('claimed', 'running')`
    )
    .run(now, now, new Date(Date.now() + config.jobs.staleClaimMs).toISOString(), now, jobId, workerId)
}

export function heartbeat(jobId: string, workerId: string): void {
  const now = nowIso()
  getControlDb()
    .prepare(
      `UPDATE jobs SET heartbeat_at = ?, lease_expires_at = ?
       WHERE id = ? AND worker_id = ? AND status IN ('claimed', 'running')`
    )
    .run(now, new Date(Date.now() + config.jobs.staleClaimMs).toISOString(), jobId, workerId)
}

/** Reads the row and checks worker_id/status ownership; returns null (and logs) when a caller is no longer the current claimant. */
function ownedRow(
  db: Db,
  jobId: string,
  workerId: string
): { tenantId: string; attempts: number; maxAttempts: number } | null {
  const row = db
    .prepare('SELECT tenant_id, worker_id, status, attempts, max_attempts FROM jobs WHERE id = ?')
    .get(jobId) as any
  if (!row) return null
  if (row.worker_id !== workerId || !['claimed', 'running'].includes(row.status)) {
    console.warn(
      `[queue] stale write for job ${jobId} ignored (caller=${workerId}, owner=${row.worker_id}, status=${row.status})`
    )
    return null
  }
  return { tenantId: row.tenant_id, attempts: row.attempts, maxAttempts: row.max_attempts }
}

function decrementRunning(db: Db, tenantId: string): void {
  db.prepare('UPDATE tenant_queue_state SET running_jobs = MAX(0, running_jobs - 1) WHERE tenant_id = ?').run(
    tenantId
  )
}

export function complete(jobId: string, workerId: string, result?: Record<string, unknown>): { ok: boolean } {
  return controlTx(db => {
    const owned = ownedRow(db, jobId, workerId)
    if (!owned) return { ok: false }

    const ts = nowIso()
    db.prepare(
      `UPDATE jobs SET status = 'completed', result = ?, error = NULL, completed_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(result ? JSON.stringify(result) : null, ts, ts, jobId)
    decrementRunning(db, owned.tenantId)
    return { ok: true }
  })
}

/**
 * Record a failure. Returns to `pending` (after an exponential backoff, with
 * jitter) when attempts remain, else parks it as `failed`.
 */
export function fail(jobId: string, workerId: string, error: string): { ok: boolean; retrying: boolean } {
  return controlTx(db => {
    const owned = ownedRow(db, jobId, workerId)
    if (!owned) return { ok: false, retrying: false }

    const retrying = owned.attempts < owned.maxAttempts
    const ts = nowIso()

    if (retrying) {
      const availableAt = new Date(Date.now() + retryBackoffMs(owned.attempts)).toISOString()
      db.prepare(
        `UPDATE jobs SET status = 'pending', error = ?, available_at = ?, worker_id = NULL,
                         claimed_at = NULL, heartbeat_at = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ?`
      ).run(error.slice(0, 2000), availableAt, ts, jobId)
    } else {
      db.prepare(
        `UPDATE jobs SET status = 'failed', error = ?, completed_at = ?, updated_at = ? WHERE id = ?`
      ).run(error.slice(0, 2000), ts, ts, jobId)
    }

    decrementRunning(db, owned.tenantId)
    return { ok: true, retrying }
  })
}

/** Reschedule without consuming an attempt (unless explicitly refunded already) — see BackgroundNotReadyError in src/jobs/worker.ts. */
export function defer(
  jobId: string,
  workerId: string,
  delayMs: number,
  note: string,
  options: { refundAttempt?: boolean } = {}
): void {
  controlTx(db => {
    const owned = ownedRow(db, jobId, workerId)
    if (!owned) return

    const ts = nowIso()
    const availableAt = new Date(Date.now() + delayMs).toISOString()
    const refund = options.refundAttempt ? ', attempts = MAX(0, attempts - 1)' : ''
    db.prepare(
      `UPDATE jobs SET status = 'pending', available_at = ?, error = ?, worker_id = NULL,
                       claimed_at = NULL, heartbeat_at = NULL, lease_expires_at = NULL, updated_at = ?${refund}
       WHERE id = ?`
    ).run(availableAt, note.slice(0, 2000), ts, jobId)
    decrementRunning(db, owned.tenantId)
  })
}

/**
 * Phase 1.4 (docs/ISSUES.md issue 4): a `background_fill` job just completed
 * for (sourceHash, templateId) — immediately un-defer any `render` jobs in
 * this tenant that are sitting out `BACKGROUND_FILL_POLL_MS` waiting on
 * exactly this fill (see `BackgroundNotReadyError`/`ensureBackgroundFillQueued`
 * in `src/jobs/worker.ts`), instead of leaving them to discover it on their
 * own next poll. Reproduction evidence (docs/evidence/issue4-repro-30img-12s*)
 * showed 1,197 defer/reclaim cycles for a 30-image batch — this removes the
 * tail wait on the LAST poll before a fill was already done, which is the
 * only part of that cost an event-driven wake-up can actually remove (the
 * cycles themselves are cheap; the wait they represent is the real cost).
 *
 * Payload is matched in application code, not SQL — the jobs table has no
 * JSON index on `payload` and the candidate set (pending jobs currently
 * deferred for one tenant) is always small, so a per-tenant scan plus a JS
 * filter is simpler and safer than introducing `json_extract` for the first
 * time in this codebase.
 */
export function wakeRenderJobsWaitingOn(tenantId: string, sourceHash: string, templateId: string): number {
  const now = nowIso()
  const candidates = getControlDb()
    .prepare(
      `SELECT * FROM jobs WHERE tenant_id = ? AND kind = 'render' AND status = 'pending' AND available_at IS NOT NULL AND available_at > ?`
    )
    .all(tenantId, now) as any[]

  let woken = 0
  for (const row of candidates) {
    const payload = parseJson<RenderJobPayload>(row.payload, {} as RenderJobPayload)
    if (payload.sourceHash !== sourceHash || payload.templateId !== templateId) continue
    const info = getControlDb()
      .prepare(`UPDATE jobs SET available_at = NULL, updated_at = ? WHERE id = ? AND status = 'pending'`)
      .run(now, row.id)
    if (info.changes > 0) woken++
  }
  return woken
}

/** Fail immediately without consuming remaining attempts — an environment problem, not a per-job one. See the original's doc comment. */
export function park(jobId: string, workerId: string, error: string): void {
  controlTx(db => {
    const owned = ownedRow(db, jobId, workerId)
    if (!owned) return

    const ts = nowIso()
    db.prepare(
      `UPDATE jobs SET status = 'failed', error = ?, attempts = max_attempts, completed_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(error.slice(0, 2000), ts, ts, jobId)
    decrementRunning(db, owned.tenantId)
  })
}

export function retry(tenantId: string, jobId: string): boolean {
  const info = getControlDb()
    .prepare(
      `UPDATE jobs SET status = 'pending', attempts = 0, error = NULL, available_at = NULL,
                       worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL, lease_expires_at = NULL,
                       completed_at = NULL, updated_at = ?
       WHERE id = ? AND tenant_id = ? AND status IN ('failed', 'cancelled')`
    )
    .run(nowIso(), jobId, tenantId)
  return info.changes > 0
}

export function retryBatch(tenantId: string, batchId: string): number {
  const info = getControlDb()
    .prepare(
      `UPDATE jobs SET status = 'pending', attempts = 0, error = NULL, available_at = NULL,
                       worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL, lease_expires_at = NULL,
                       completed_at = NULL, updated_at = ?
       WHERE tenant_id = ? AND batch_id = ? AND status = 'failed'`
    )
    .run(nowIso(), tenantId, batchId)
  return info.changes
}

/**
 * Cancel everything not yet finished in a batch. Only `pending`/`claimed` —
 * a `running` job cannot be interrupted safely and is left to finish; the
 * worker checks `isBatchCancelled` before writing output either way.
 */
export function cancelBatch(tenantId: string, batchId: string): number {
  return controlTx(db => {
    const claimedCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM jobs WHERE tenant_id = ? AND batch_id = ? AND status = 'claimed'`
        )
        .get(tenantId, batchId) as { n: number }
    ).n

    const ts = nowIso()
    const info = db
      .prepare(
        `UPDATE jobs SET status = 'cancelled', completed_at = ?, updated_at = ?
         WHERE tenant_id = ? AND batch_id = ? AND status IN ('pending', 'claimed')`
      )
      .run(ts, ts, tenantId, batchId)

    if (claimedCount > 0) {
      db.prepare(
        'UPDATE tenant_queue_state SET running_jobs = MAX(0, running_jobs - ?) WHERE tenant_id = ?'
      ).run(claimedCount, tenantId)
    }

    return info.changes
  })
}

/**
 * Permanently delete every job row for a batch — not just cancel the live
 * ones. For when the BATCH ITSELF is being deleted (see
 * `cleanup-service.ts`'s `deleteBatch`): with no FK from `jobs` to
 * `batches` across the control.db/app.db split (docs/MULTI_TENANCY.md
 * §3.1), nothing else removes these rows, and leaving them behind orphans
 * them — pointing at a `batch_id` that no longer exists in any tenant's
 * app.db. MUST be called BEFORE the batch row itself is deleted, so a crash
 * in between leaves an orphaned-looking but still-visible batch (discoverable,
 * re-deletable) rather than orphaned jobs with no batch left to find them
 * through at all.
 */
export function deleteJobsForBatch(tenantId: string, batchId: string): number {
  return controlTx(db => {
    const activeCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM jobs WHERE tenant_id = ? AND batch_id = ? AND status IN ('claimed', 'running')`
        )
        .get(tenantId, batchId) as { n: number }
    ).n

    const info = db.prepare(`DELETE FROM jobs WHERE tenant_id = ? AND batch_id = ?`).run(tenantId, batchId)

    if (activeCount > 0) {
      db.prepare(
        'UPDATE tenant_queue_state SET running_jobs = MAX(0, running_jobs - ?) WHERE tenant_id = ?'
      ).run(activeCount, tenantId)
    }

    return info.changes
  })
}

/**
 * Ops escape hatch: cancel EVERY not-yet-finished job — including 'running'
 * ones, unlike `cancelBatch` (which deliberately leaves 'running' jobs alone
 * to finish normally). For when the queue is genuinely stuck (a crashed or
 * wedged worker that will never call back `complete()`/`fail()` for the job
 * it was holding) and someone needs it cleared regardless of what was
 * mid-flight — a late, stale call from a zombie worker afterward is a no-op
 * either way (`ownedRow` no longer matches a cancelled job's status).
 *
 * Scoped to one tenant if `tenantId` is given, every tenant otherwise.
 * `tenant_queue_state.running_jobs` is reset to exactly 0 for each affected
 * tenant rather than decremented by a counted amount — correct here
 * specifically because EVERY in-flight job for that tenant is being
 * cancelled, so 0 is the right answer regardless of what the counter drifted
 * to beforehand.
 */
export function cancelAll(tenantId?: string): { cancelled: number; tenantsAffected: string[] } {
  return controlTx(db => {
    const ts = nowIso()
    const where = tenantId
      ? `WHERE tenant_id = ? AND status IN ('pending', 'claimed', 'running')`
      : `WHERE status IN ('pending', 'claimed', 'running')`
    const params = tenantId ? [ts, ts, tenantId] : [ts, ts]

    const affected = (
      db.prepare(`SELECT DISTINCT tenant_id FROM jobs ${where}`).all(...(tenantId ? [tenantId] : []))
    ).map((r: any) => r.tenant_id as string)

    const info = db
      .prepare(`UPDATE jobs SET status = 'cancelled', completed_at = ?, updated_at = ? ${where}`)
      .run(...params)

    for (const t of affected) {
      db.prepare('UPDATE tenant_queue_state SET running_jobs = 0 WHERE tenant_id = ?').run(t)
    }

    return { cancelled: info.changes, tenantsAffected: affected }
  })
}

/**
 * P6 graceful shutdown: hand a still-in-flight job back to 'pending'
 * WITHOUT consuming an attempt — unlike `fail()` (which always counts one)
 * or the stale-claim sweep's `reclaimStale()` (which treats an expired
 * lease as evidence of a crash and counts one there too). This is neither:
 * it's an orderly shutdown deliberately choosing not to wait for this one
 * job, through no fault of the job itself. A worker holding a job it never
 * got to finish calls this right before being killed (see `pool.stop()`).
 * A no-op (returns false) if the job already finished or was claimed by
 * someone else in the meantime — same "stale write ignored" guard every
 * other mutating queue function uses.
 */
export function returnToPending(jobId: string, workerId: string): boolean {
  return controlTx(db => {
    const owned = ownedRow(db, jobId, workerId)
    if (!owned) return false

    const ts = nowIso()
    // `claim()` increments `attempts` the moment a job is claimed, not on
    // failure — so "without counting an attempt" means undoing THAT
    // increment here, the same `MAX(0, attempts - 1)` refund `defer()` uses.
    // Skipping this would silently count the attempt anyway.
    db.prepare(
      `UPDATE jobs SET status = 'pending', worker_id = NULL, claimed_at = NULL,
                       heartbeat_at = NULL, lease_expires_at = NULL, available_at = NULL,
                       attempts = MAX(0, attempts - 1), updated_at = ?
       WHERE id = ?`
    ).run(ts, jobId)
    decrementRunning(db, owned.tenantId)
    return true
  })
}

/** Reads the TENANT's own `batches` table (app.db) — nothing to do with control.db's jobs table; kept here because every worker call site already imports this module as `queue`. */
export function isBatchCancelled(batchId: string): boolean {
  const row = getDb().prepare('SELECT status FROM batches WHERE id = ?').get(batchId) as any
  return row?.status === 'cancelled'
}

// ─── Sweeps (pool-level, cross-tenant, no ambient context) ──────────────────

/**
 * Return jobs abandoned by a dead worker to the queue — or fail them
 * outright if they have already exhausted their attempts, so a job that
 * reliably kills its worker cannot loop through reclaim forever. Decrements
 * `running_jobs` for whichever tenant owned each one.
 */
export function reclaimStale(): number {
  return controlTx(db => {
    const now = nowIso()
    const stale = db
      .prepare(
        `SELECT id, tenant_id, attempts, max_attempts FROM jobs
         WHERE status IN ('claimed', 'running') AND (lease_expires_at IS NULL OR lease_expires_at < ?)`
      )
      .all(now) as { id: string; tenant_id: string; attempts: number; max_attempts: number }[]

    for (const job of stale) {
      if (job.attempts < job.max_attempts) {
        db.prepare(
          `UPDATE jobs SET status = 'pending', worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL,
                           lease_expires_at = NULL, updated_at = ?, error = 'reclaimed after worker went silent'
           WHERE id = ?`
        ).run(now, job.id)
      } else {
        db.prepare(
          `UPDATE jobs SET status = 'failed', updated_at = ?, completed_at = ?,
                           error = 'reclaimed after worker went silent; max attempts reached'
           WHERE id = ?`
        ).run(now, now, job.id)
      }
      decrementRunning(db, job.tenant_id)
    }

    return stale.length
  })
}

/** Safety net against any drift between `tenant_queue_state.running_jobs` and reality — run periodically alongside reclaimStale(). */
export function reconcileRunningJobs(): void {
  getControlDb().exec(
    `UPDATE tenant_queue_state
     SET running_jobs = (
       SELECT COUNT(*) FROM jobs WHERE jobs.tenant_id = tenant_queue_state.tenant_id AND jobs.status IN ('claimed', 'running')
     )`
  )
}

/** A 'bulk' job pending longer than `maxWaitSeconds` is promoted to 'interactive' — see JobPriorityClass's doc comment. Run periodically. */
export function promoteAgedBulkJobs(maxWaitSeconds = config.jobs.bulkMaxWaitSeconds): number {
  const cutoff = new Date(Date.now() - maxWaitSeconds * 1000).toISOString()
  const info = getControlDb()
    .prepare(
      `UPDATE jobs SET priority_class = 'interactive', updated_at = ?
       WHERE priority_class = 'bulk' AND status = 'pending' AND created_at < ?`
    )
    .run(nowIso(), cutoff)
  return info.changes
}

/**
 * Delete finished jobs older than a cutoff, globally (not tenant-scoped —
 * this is pool-level housekeeping). Each batch's own summary counters are
 * persisted onto its `batches` row well before `JOB_RETENTION_DAYS` elapses
 * (see generation-service.ts calling `applyBatchProgress` on every
 * completion), so pruning the underlying job rows afterward loses no
 * information a caller still needed.
 */
export function prune(olderThanMs = config.jobs.retentionDays * 24 * 60 * 60 * 1000): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString()
  const info = getControlDb()
    .prepare(
      `DELETE FROM jobs WHERE status IN ('completed', 'cancelled', 'failed')
       AND completed_at IS NOT NULL AND completed_at < ?`
    )
    .run(cutoff)
  return info.changes
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export function get(tenantId: string, jobId: string): JobRecord | null {
  const row = getControlDb().prepare('SELECT * FROM jobs WHERE id = ? AND tenant_id = ?').get(jobId, tenantId)
  return row ? toJob(row) : null
}

export function findLatestByDedupeKey(tenantId: string, dedupeKey: string): JobRecord | null {
  const row = getControlDb()
    .prepare(`SELECT * FROM jobs WHERE tenant_id = ? AND dedupe_key = ? ORDER BY updated_at DESC LIMIT 1`)
    .get(tenantId, dedupeKey)
  return row ? toJob(row) : null
}

export function findRecent(tenantId: string, dedupeKey: string, withinMs: number): JobRecord | null {
  const cutoff = new Date(Date.now() - withinMs).toISOString()
  const row = getControlDb()
    .prepare(
      `SELECT * FROM jobs WHERE tenant_id = ? AND dedupe_key = ? AND updated_at >= ?
       ORDER BY updated_at DESC LIMIT 1`
    )
    .get(tenantId, dedupeKey, cutoff)
  return row ? toJob(row) : null
}

export interface QueueStats {
  pending: number
  claimed: number
  running: number
  completed: number
  failed: number
  cancelled: number
}

/** Omit `tenantId` for a global (every-tenant) count — e.g. the standalone runner's own console monitor. */
export function stats(kind?: JobKind, tenantId?: string): QueueStats {
  const clauses: string[] = []
  const params: unknown[] = []
  if (kind) {
    clauses.push('kind = ?')
    params.push(kind)
  }
  if (tenantId) {
    clauses.push('tenant_id = ?')
    params.push(tenantId)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = getControlDb()
    .prepare(`SELECT status, COUNT(*) AS n FROM jobs ${where} GROUP BY status`)
    .all(...params) as { status: JobStatus; n: number }[]

  const out: QueueStats = { pending: 0, claimed: 0, running: 0, completed: 0, failed: 0, cancelled: 0 }
  for (const row of rows) out[row.status] = row.n
  return out
}

export interface BatchJobCounts {
  total: number
  completed: number
  failed: number
  cancelled: number
  active: number
}

/** Replaces `batches.refresh()`'s own `FROM jobs` query — that table lives in control.db now, a different file than the tenant's `batches` row this feeds into. */
export function batchJobCounts(tenantId: string, batchId: string): BatchJobCounts {
  const row = getControlDb()
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
         SUM(CASE WHEN status IN ('pending','claimed','running') THEN 1 ELSE 0 END) AS active
       FROM jobs WHERE tenant_id = ? AND batch_id = ?`
    )
    .get(tenantId, batchId) as any

  return {
    total: row?.total ?? 0,
    completed: row?.completed ?? 0,
    failed: row?.failed ?? 0,
    cancelled: row?.cancelled ?? 0,
    active: row?.active ?? 0,
  }
}

export function listByBatch(
  tenantId: string,
  batchId: string,
  options: { status?: JobStatus; limit?: number } = {}
): JobRecord[] {
  const where = ['tenant_id = ?', 'batch_id = ?']
  const params: unknown[] = [tenantId, batchId]
  if (options.status) {
    where.push('status = ?')
    params.push(options.status)
  }
  params.push(options.limit ?? 500)

  return getControlDb()
    .prepare(`SELECT * FROM jobs WHERE ${where.join(' AND ')} ORDER BY created_at ASC LIMIT ?`)
    .all(...params)
    .map(r => toJob(r))
}

export function listFailed(tenantId: string, kind?: JobKind, limit = 100): JobRecord[] {
  const clause = kind ? 'AND kind = ?' : ''
  const params: unknown[] = kind ? [tenantId, kind, limit] : [tenantId, limit]
  return getControlDb()
    .prepare(
      `SELECT * FROM jobs WHERE tenant_id = ? AND status = 'failed' ${clause}
       ORDER BY updated_at DESC LIMIT ?`
    )
    .all(...params)
    .map(r => toJob(r))
}

export function hasPending(kind?: JobKind, tenantId?: string): boolean {
  const clauses = ["status = 'pending'"]
  const params: unknown[] = []
  if (kind) {
    clauses.push('kind = ?')
    params.push(kind)
  }
  if (tenantId) {
    clauses.push('tenant_id = ?')
    params.push(tenantId)
  }
  const row = getControlDb()
    .prepare(`SELECT 1 FROM jobs WHERE ${clauses.join(' AND ')} LIMIT 1`)
    .get(...params)
  return !!row
}
