/**
 * Job queue, backed by the `jobs` table.
 *
 * Chosen over Redis/BullMQ because Vision Studio is a single-node application
 * processing local folders: the database is already open, already durable, and
 * already the source of truth. Adding a broker would mean a second store that
 * can disagree with the first — the failure mode where a job exists in Redis
 * but not in Postgres, or completes in one and not the other.
 *
 * ── Claiming ─────────────────────────────────────────────────────────────────
 * A worker claims by conditional UPDATE inside an IMMEDIATE transaction:
 *
 *   UPDATE jobs SET status = 'claimed' WHERE id = ? AND status = 'pending'
 *
 * The `AND status = 'pending'` is the entire concurrency control. SQLite
 * serialises writers, so of N workers racing for one row exactly one sees
 * `changes === 1` and the rest see 0 and move on. No locks to lease, no
 * heartbeat protocol needed for correctness.
 *
 * ── Crash recovery ───────────────────────────────────────────────────────────
 * A worker that dies mid-job leaves the row `running`. `reclaimStale()` returns
 * anything whose heartbeat has gone quiet to `pending`, so a killed process
 * costs one retry rather than a stuck job. Workers heartbeat while running.
 *
 * ── Idempotency ──────────────────────────────────────────────────────────────
 * `dedupeKey` has a partial unique index over live statuses only, so
 * re-requesting analysis for an image already queued is a no-op, while a
 * completed job can legitimately be re-run later.
 *
 * Server-only.
 */

import { getDb, nowIso, transaction, parseJson } from '@/db/client'
import { newId } from '@/db/repositories'
import { config } from '@/config'
import type { JobKind, JobPayload, JobRecord, JobStatus } from '@/db/types'

/**
 * How long a render job waiting on a `background_fill` job steps aside for
 * before checking again (`defer()`, below). Shared between
 * `src/jobs/worker-entry.ts` (uses it to reschedule) and
 * `src/services/generation-service.ts` (uses it to size how many attempts an
 * `ai_extend` render job needs to outlast one `CLOUDINARY_TIMEOUT_MS`-long wait)
 * so the two stay in sync without one importing the other's module — a few
 * seconds: short enough that a cached or fast derivation doesn't add
 * noticeable latency once it lands, long enough that a first-time Cloudinary
 * render (tens of seconds) isn't polled hundreds of times for nothing.
 */
export const BACKGROUND_FILL_POLL_MS = 5_000

/**
 * How long a render job waits after a `background_fill` attempt fails before
 * asking for another one (`worker.ts`'s `ensureBackgroundFillQueued`, via
 * `findRecent` below). Several `BACKGROUND_FILL_POLL_MS` cycles, not one —
 * this bounds retry FREQUENCY against a down service; the render job's own
 * `maxAttempts` (computed in `generation-service.ts`) separately bounds how
 * long it keeps trying in total before giving up for good.
 */
export const BACKGROUND_FILL_RETRY_COOLDOWN_MS = 20_000

function toJob<P = JobPayload>(row: any): JobRecord<P> {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    priority: row.priority,
    batchId: row.batch_id,
    dedupeKey: row.dedupe_key,
    payload: parseJson(row.payload, {} as P),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    workerId: row.worker_id,
    claimedAt: row.claimed_at,
    heartbeatAt: row.heartbeat_at,
    availableAt: row.available_at,
    error: row.error,
    result: parseJson<Record<string, unknown> | null>(row.result, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

export interface EnqueueInput {
  kind: JobKind
  payload: JobPayload
  /** Lower runs sooner. Default 100. */
  priority?: number
  batchId?: string | null
  /** Suppresses a duplicate while an identical job is still live. */
  dedupeKey?: string | null
  maxAttempts?: number
}

export interface EnqueueResult {
  /** Jobs actually inserted. */
  inserted: number
  /** Requests suppressed because an identical job was already live. */
  deduplicated: number
  ids: string[]
}

/**
 * Insert jobs, skipping any whose dedupe key is already live.
 *
 * One transaction for the whole batch: enqueuing 5,000 render jobs as 5,000
 * separate transactions means 5,000 fsyncs, which takes minutes. Batched, it
 * takes well under a second.
 */
export function enqueue(inputs: EnqueueInput[]): EnqueueResult {
  if (inputs.length === 0) return { inserted: 0, deduplicated: 0, ids: [] }

  return transaction(db => {
    const insert = db.prepare(
      `INSERT INTO jobs (id, kind, status, priority, batch_id, dedupe_key, payload,
                         attempts, max_attempts, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, 0, ?, ?, ?)`
    )

    const ids: string[] = []
    let deduplicated = 0

    for (const input of inputs) {
      const id = newId('job')
      const ts = nowIso()
      try {
        insert.run(
          id,
          input.kind,
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
        // The partial unique index on dedupe_key rejected it — an identical job
        // is already pending or running. That is the intended outcome, not an
        // error to propagate.
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

/**
 * Atomically claim up to `limit` pending jobs of one kind.
 *
 * Select-then-conditionally-update, all inside one IMMEDIATE transaction. The
 * select picks candidates; the update is what actually claims, and only rows
 * still `pending` at write time are taken.
 */
export function claim(kind: JobKind, workerId: string, limit = 1): JobRecord[] {
  return transaction(db => {
    const now = nowIso()
    const candidates = db
      .prepare(
        `SELECT id FROM jobs
         WHERE kind = ? AND status = 'pending' AND (available_at IS NULL OR available_at <= ?)
         ORDER BY priority ASC, created_at ASC
         LIMIT ?`
      )
      .all(kind, now, limit) as { id: string }[]

    if (candidates.length === 0) return []

    const ts = nowIso()
    const take = db.prepare(
      `UPDATE jobs
       SET status = 'claimed', worker_id = ?, claimed_at = ?, heartbeat_at = ?,
           available_at = NULL, attempts = attempts + 1, updated_at = ?
       WHERE id = ? AND status = 'pending'`
    )
    const read = db.prepare('SELECT * FROM jobs WHERE id = ?')

    const claimed: JobRecord[] = []
    for (const { id } of candidates) {
      const info = take.run(workerId, ts, ts, ts, id)
      // changes === 0 means another worker won the race for this row.
      if (info.changes === 1) claimed.push(toJob(read.get(id)))
    }

    return claimed
  })
}

export function markRunning(jobId: string): void {
  const ts = nowIso()
  getDb()
    .prepare(
      `UPDATE jobs SET status = 'running', heartbeat_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('claimed', 'running')`
    )
    .run(ts, ts, jobId)
}

export function heartbeat(jobId: string): void {
  getDb()
    .prepare(`UPDATE jobs SET heartbeat_at = ? WHERE id = ? AND status IN ('claimed','running')`)
    .run(nowIso(), jobId)
}

export function complete(jobId: string, result?: Record<string, unknown>): void {
  const ts = nowIso()
  getDb()
    .prepare(
      `UPDATE jobs SET status = 'completed', result = ?, error = NULL,
                       completed_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(result ? JSON.stringify(result) : null, ts, ts, jobId)
}

/**
 * Record a failure. Returns the job to `pending` when attempts remain, else
 * parks it as `failed` for manual retry.
 *
 * `attempts` was already incremented at claim time — counting there rather than
 * here means a worker that dies before reporting still burns an attempt, so a
 * job that reliably crashes its worker cannot loop forever.
 */
export function fail(jobId: string, error: string): { retrying: boolean } {
  return transaction(db => {
    const row = db.prepare('SELECT attempts, max_attempts FROM jobs WHERE id = ?').get(jobId) as any
    if (!row) return { retrying: false }

    const retrying = row.attempts < row.max_attempts
    const ts = nowIso()

    if (retrying) {
      db.prepare(
        `UPDATE jobs SET status = 'pending', error = ?, worker_id = NULL,
                         claimed_at = NULL, heartbeat_at = NULL, updated_at = ?
         WHERE id = ?`
      ).run(error.slice(0, 2000), ts, jobId)
    } else {
      db.prepare(
        `UPDATE jobs SET status = 'failed', error = ?, completed_at = ?, updated_at = ?
         WHERE id = ?`
      ).run(error.slice(0, 2000), ts, ts, jobId)
    }

    return { retrying }
  })
}

/**
 * Reschedule a job to become claimable again after `delayMs`, without
 * touching its attempt count.
 *
 * For a render job waiting on a `background_fill` job it does not own and
 * cannot block on — see `BackgroundNotReadyError` in `src/jobs/worker.ts`.
 * Deliberately distinct from `fail()`: this is not the job going wrong, it is
 * the job correctly declining to occupy a worker slot doing nothing while it
 * waits, so `attempts` (which gates real retries) is left alone. The caller
 * is still expected to give up eventually — `runOne` in `worker-entry.ts`
 * checks `attempts` against `maxAttempts` itself before calling this again,
 * rather than this function silently rescheduling forever.
 */
export function defer(
  jobId: string,
  delayMs: number,
  note: string,
  options: { refundAttempt?: boolean } = {}
): void {
  const ts = nowIso()
  const availableAt = new Date(Date.now() + delayMs).toISOString()
  // `attempts` is incremented at CLAIM time, so a job that was claimed only
  // to discover it should not run yet has already been charged for it.
  // `refundAttempt` gives that back, for the cases where the job never
  // actually attempted its work — a busy GPU, a dependency not ready. Without
  // it, a service that stays busy for a few minutes silently exhausts every
  // waiting job's retry budget and fails work that was never tried.
  const refund = options.refundAttempt ? ', attempts = MAX(0, attempts - 1)' : ''
  getDb()
    .prepare(
      `UPDATE jobs SET status = 'pending', available_at = ?, error = ?, worker_id = NULL,
                       claimed_at = NULL, heartbeat_at = NULL, updated_at = ?${refund}
       WHERE id = ?`
    )
    .run(availableAt, note.slice(0, 2000), ts, jobId)
}

/**
 * Fail a job immediately, without consuming remaining attempts.
 *
 * For errors that are a property of the ENVIRONMENT rather than the job: models
 * not installed, a template deleted mid-batch. Retrying those burns every
 * attempt on every image in the catalog for the same reason and buries the real
 * cause in thousands of identical log lines. The job is parked for an operator
 * to retry once the cause is addressed.
 */
export function park(jobId: string, error: string): void {
  const ts = nowIso()
  getDb()
    .prepare(
      `UPDATE jobs SET status = 'failed', error = ?, attempts = max_attempts,
                       completed_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(error.slice(0, 2000), ts, ts, jobId)
}

/**
 * Requeue a parked job, resetting its attempt count.
 *
 * `attempts = 0` because an operator retry follows a change in the world —
 * models installed, a corrupt file replaced — so the previous attempts are not
 * evidence about this one.
 */
export function retry(jobId: string): boolean {
  const info = getDb()
    .prepare(
      `UPDATE jobs SET status = 'pending', attempts = 0, error = NULL,
                       worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL,
                       completed_at = NULL, updated_at = ?
       WHERE id = ? AND status IN ('failed', 'cancelled')`
    )
    .run(nowIso(), jobId)
  return info.changes > 0
}

export function retryBatch(batchId: string): number {
  const info = getDb()
    .prepare(
      `UPDATE jobs SET status = 'pending', attempts = 0, error = NULL,
                       worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL,
                       completed_at = NULL, updated_at = ?
       WHERE batch_id = ? AND status = 'failed'`
    )
    .run(nowIso(), batchId)
  return info.changes
}

/**
 * Cancel everything not yet finished in a batch.
 *
 * Only `pending` and `claimed` rows are cancelled — a `running` job is inside a
 * worker's inference call and cannot be interrupted safely, so it is allowed to
 * finish. The worker checks `isBatchCancelled` before writing its output, so a
 * cancelled batch produces no further creatives either way.
 */
export function cancelBatch(batchId: string): number {
  const ts = nowIso()
  const info = getDb()
    .prepare(
      `UPDATE jobs SET status = 'cancelled', completed_at = ?, updated_at = ?
       WHERE batch_id = ? AND status IN ('pending', 'claimed')`
    )
    .run(ts, ts, batchId)
  return info.changes
}

export function isBatchCancelled(batchId: string): boolean {
  const row = getDb().prepare('SELECT status FROM batches WHERE id = ?').get(batchId) as any
  return row?.status === 'cancelled'
}

/**
 * Return jobs abandoned by a dead worker to the queue.
 *
 * Called on worker-pool startup and periodically thereafter.
 */
export function reclaimStale(olderThanMs = config.jobs.staleClaimMs): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString()
  const info = getDb()
    .prepare(
      `UPDATE jobs SET status = 'pending', worker_id = NULL, claimed_at = NULL,
                       heartbeat_at = NULL, updated_at = ?,
                       error = 'reclaimed after worker went silent'
       WHERE status IN ('claimed', 'running')
         AND (heartbeat_at IS NULL OR heartbeat_at < ?)`
    )
    .run(nowIso(), cutoff)
  return info.changes
}

export function get(jobId: string): JobRecord | null {
  const row = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(jobId)
  return row ? toJob(row) : null
}

/**
 * The most recently updated job with this dedupe key, of ANY status,
 * touched within the last `withinMs` — unlike the live-only dedupe the
 * unique index enforces on insert.
 *
 * For a render job re-checking "is my `background_fill` job ready yet"
 * every few seconds: once that job fails, the live-only index no longer
 * blocks a fresh insert, so without this a render job stuck deferring
 * against a genuinely down service would enqueue a brand new attempt on
 * EVERY check — a tight retry storm against exactly the service that just
 * said no. This lets the caller see the failure and back off instead.
 */
/**
 * The most recent job with this dedupe key, whatever its status and however
 * old. Lets a dependent job ask "what happened to the work I'm waiting on?"
 * rather than guessing from a timeout.
 */
export function findLatestByDedupeKey(dedupeKey: string): JobRecord | null {
  const row = getDb()
    .prepare(`SELECT * FROM jobs WHERE dedupe_key = ? ORDER BY updated_at DESC LIMIT 1`)
    .get(dedupeKey)
  return row ? toJob(row) : null
}

export function findRecent(dedupeKey: string, withinMs: number): JobRecord | null {
  const cutoff = new Date(Date.now() - withinMs).toISOString()
  const row = getDb()
    .prepare(
      `SELECT * FROM jobs WHERE dedupe_key = ? AND updated_at >= ?
       ORDER BY updated_at DESC LIMIT 1`
    )
    .get(dedupeKey, cutoff)
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

export function stats(kind?: JobKind): QueueStats {
  const clause = kind ? 'WHERE kind = ?' : ''
  const params = kind ? [kind] : []
  const rows = getDb()
    .prepare(`SELECT status, COUNT(*) AS n FROM jobs ${clause} GROUP BY status`)
    .all(...params) as any[]

  const out: QueueStats = {
    pending: 0,
    claimed: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  }
  for (const row of rows) out[row.status as JobStatus] = row.n
  return out
}

export function listByBatch(
  batchId: string,
  options: { status?: JobStatus; limit?: number } = {}
): JobRecord[] {
  const where = ['batch_id = ?']
  const params: any[] = [batchId]
  if (options.status) {
    where.push('status = ?')
    params.push(options.status)
  }
  params.push(options.limit ?? 500)

  return getDb()
    .prepare(
      `SELECT * FROM jobs WHERE ${where.join(' AND ')}
       ORDER BY created_at ASC LIMIT ?`
    )
    .all(...params)
    .map(r => toJob(r))
}

export function listFailed(kind?: JobKind, limit = 100): JobRecord[] {
  const clause = kind ? 'AND kind = ?' : ''
  const params: any[] = kind ? [kind, limit] : [limit]
  return getDb()
    .prepare(
      `SELECT * FROM jobs WHERE status = 'failed' ${clause}
       ORDER BY updated_at DESC LIMIT ?`
    )
    .all(...params)
    .map(r => toJob(r))
}

/** Delete finished jobs older than a cutoff, keeping the table small. */
export function prune(olderThanMs = 7 * 24 * 60 * 60 * 1000): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString()
  const info = getDb()
    .prepare(
      `DELETE FROM jobs WHERE status IN ('completed','cancelled')
       AND completed_at IS NOT NULL AND completed_at < ?`
    )
    .run(cutoff)
  return info.changes
}

export function hasPending(kind?: JobKind): boolean {
  const clause = kind ? 'AND kind = ?' : ''
  const params = kind ? [kind] : []
  const row = getDb()
    .prepare(`SELECT 1 FROM jobs WHERE status = 'pending' ${clause} LIMIT 1`)
    .get(...params)
  return !!row
}
