/**
 * Platform-admin operations (P5) — the tenants table, the global panel, and
 * every admin action, each one writing its own `audit_log` entry.
 *
 * Deliberately operates on control-plane data directly, never through
 * `TenantContext`/`runWithTenant` for the general case: an admin isn't
 * "acting as" any one tenant, and a platform admin may have no personal
 * tenant at all (see `ResolvedSession`'s doc comment). The one action that
 * genuinely needs to touch a SPECIFIC tenant's own files (`purgeTenant`)
 * scopes that one step explicitly by tenant id, never ambiently.
 *
 * Privacy boundary: every function here returns counts, sizes, timings and
 * identifiers (tenant name, user email) — never a tenant's media,
 * filenames, product names, or template content. `tests/admin/no-tenant-
 * content.test.ts` scans these shapes for exactly that.
 *
 * Server-only.
 */

import fs from 'fs/promises'
import {
  tenants,
  memberships,
  users,
  sessions,
  quotas,
  tenantQueueState,
  usageCounters,
  auditLog,
  currentPeriod,
  type TenantRecord,
  type QuotaRecord,
  type AuditLogEntry,
} from '@/db/control-repositories'
import { closeTenantDb, getControlDb, openTenantDbById } from '@/db/client'
import { migrate } from '@/db/migrate'
import { config } from '@/config'
import { purgeTenantDirectory, ensureMediaRoots } from '@/storage/media-store'
import { generateTempPassword, hashPassword } from '@/auth/password'
import { getQueueWaitPercentiles } from '@/jobs/queue-wait-rollup'
import { getPool } from '@/jobs/pool'
import { getEventLoopStats } from '@/lib/event-loop-monitor'
import * as queue from '@/jobs/queue'

// ─── Tenants table ──────────────────────────────────────────────────────────

export interface AdminTenantRow {
  id: string
  name: string
  status: TenantRecord['status']
  pendingDeletionAt: string | null
  /** The owner's own account identity (email, user id) — not tenant CONTENT, needed so the admin UI can offer "reset this tenant's password" without a separate lookup. */
  ownerUserId: string | null
  ownerEmail: string | null
  storageUsedBytes: number
  storageQuotaBytes: number
  queuedJobs: number
  runningJobs: number
  jobsPerHour24h: number
  queueWaitP50Ms: number
  queueWaitP95Ms: number
  aiExtendCallsThisMonth: number
  aiExtendQuota: number
  weight: number
  lastActivityAt: string | null
  createdAt: string
}

export function listTenantsWithMetrics(): AdminTenantRow[] {
  const db = getControlDb()
  const allTenants = tenants.list()
  if (allTenants.length === 0) return []

  // One grouped query each, not one query per tenant — every number here is
  // batch-computed across ALL tenants in a single pass over an indexed
  // table, then assembled per tenant in JS. See scripts/bench-admin-queries.ts
  // for the measured cost of each at 100k job rows.
  const queueCounts = new Map<string, { queued: number; running: number }>()
  for (const row of db
    .prepare(
      `SELECT tenant_id,
              SUM(CASE WHEN status IN ('pending','claimed') THEN 1 ELSE 0 END) AS queued,
              SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
       FROM jobs GROUP BY tenant_id`
    )
    .all() as { tenant_id: string; queued: number; running: number }[]) {
    queueCounts.set(row.tenant_id, { queued: row.queued, running: row.running })
  }

  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const throughput = new Map<string, number>()
  for (const row of db
    .prepare(
      `SELECT tenant_id, COUNT(*) AS n FROM jobs
       WHERE status = 'completed' AND completed_at >= ?
       GROUP BY tenant_id`
    )
    .all(cutoff24h) as { tenant_id: string; n: number }[]) {
    throughput.set(row.tenant_id, row.n)
  }

  const lastJobActivity = new Map<string, string>()
  for (const row of db.prepare('SELECT tenant_id, MAX(created_at) AS last FROM jobs GROUP BY tenant_id').all() as {
    tenant_id: string
    last: string
  }[]) {
    lastJobActivity.set(row.tenant_id, row.last)
  }

  const lastSessionActivity = new Map<string, string>()
  for (const row of db
    .prepare(
      `SELECT m.tenant_id AS tenant_id, MAX(s.last_seen_at) AS last
       FROM sessions s JOIN memberships m ON m.user_id = s.user_id
       WHERE s.revoked_at IS NULL
       GROUP BY m.tenant_id`
    )
    .all() as { tenant_id: string; last: string }[]) {
    lastSessionActivity.set(row.tenant_id, row.last)
  }

  const period = currentPeriod()

  // One owner (the earliest member) per tenant — v1's "a user belongs to
  // exactly one tenant" model, same assumption `memberships.findForUser`
  // documents, just read from the other direction.
  const owners = new Map<string, { userId: string; email: string }>()
  for (const row of db
    .prepare(
      `SELECT m.tenant_id AS tenant_id, u.id AS user_id, u.email AS email
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.created_at = (SELECT MIN(m2.created_at) FROM memberships m2 WHERE m2.tenant_id = m.tenant_id)`
    )
    .all() as { tenant_id: string; user_id: string; email: string }[]) {
    owners.set(row.tenant_id, { userId: row.user_id, email: row.email })
  }

  return allTenants.map(tenant => {
    const queueCount = queueCounts.get(tenant.id) ?? { queued: 0, running: 0 }
    const quota = quotas.get(tenant.id)
    const usage = usageCounters.get(tenant.id, period)
    const wait = getQueueWaitPercentiles(tenant.id, 24)
    const queueState = tenantQueueState.get(tenant.id)

    const jobActivity = lastJobActivity.get(tenant.id) ?? null
    const sessionActivity = lastSessionActivity.get(tenant.id) ?? null
    const lastActivityAt =
      jobActivity && sessionActivity
        ? jobActivity > sessionActivity
          ? jobActivity
          : sessionActivity
        : (jobActivity ?? sessionActivity)

    const owner = owners.get(tenant.id) ?? null

    return {
      id: tenant.id,
      name: tenant.name,
      status: tenant.status,
      pendingDeletionAt: tenant.pendingDeletionAt,
      ownerUserId: owner?.userId ?? null,
      ownerEmail: owner?.email ?? null,
      storageUsedBytes: usage.storageBytes,
      storageQuotaBytes: quota?.maxStorageBytes ?? 0,
      queuedJobs: queueCount.queued,
      runningJobs: queueCount.running,
      jobsPerHour24h: Math.round(((throughput.get(tenant.id) ?? 0) / 24) * 100) / 100,
      queueWaitP50Ms: Math.round(wait.p50Ms),
      queueWaitP95Ms: Math.round(wait.p95Ms),
      aiExtendCallsThisMonth: usage.aiExtendCalls,
      aiExtendQuota: quota?.maxAiExtendPerMonth ?? 0,
      weight: queueState?.weight ?? quota?.weight ?? 1,
      lastActivityAt,
      createdAt: tenant.createdAt,
    }
  })
}

// ─── Global panel ───────────────────────────────────────────────────────────

export interface GlobalPanelStats {
  workersBusy: number
  workersIdle: number
  workersTotal: number
  queueDepthTotal: number
  eventLoopP99Ms: number | null
  aiExtendGlobalCallsThisMonth: number
  aiExtendGlobalCap: number
  freeDiskBytes: number | null
  controlDbSizeBytes: number
}

export async function getGlobalPanelStats(): Promise<GlobalPanelStats> {
  const poolStatus = getPool().status()
  const workersBusy = poolStatus.workers.filter(w => w.state === 'busy').length
  const workersIdle = poolStatus.workers.length - workersBusy

  const globalQueue = queue.stats()
  const queueDepthTotal = globalQueue.pending + globalQueue.claimed + globalQueue.running

  const eventLoop = getEventLoopStats()

  let freeDiskBytes: number | null = null
  try {
    const stat = await fs.statfs(config.paths.dataDir)
    freeDiskBytes = stat.bavail * stat.bsize
  } catch {
    // statfs isn't available on every platform/filesystem — the admin panel
    // shows "unknown" rather than failing the whole page over one field.
  }

  let controlDbSizeBytes = 0
  try {
    controlDbSizeBytes = (await fs.stat(config.paths.controlDatabase)).size
  } catch {
    // Shouldn't happen (the process has the file open), but never let a
    // stat failure take down the whole panel.
  }

  return {
    workersBusy,
    workersIdle,
    workersTotal: poolStatus.workers.length,
    queueDepthTotal,
    eventLoopP99Ms: eventLoop?.p99Ms ?? null,
    aiExtendGlobalCallsThisMonth: usageCounters.globalAiExtendCalls(),
    aiExtendGlobalCap: config.aiExtendDispatcher.globalMonthlyCap,
    freeDiskBytes,
    controlDbSizeBytes,
  }
}

// ─── Diagnostics (Phase 1.2, docs/ISSUES.md) ───────────────────────────────

export interface DiagJobBucket {
  kind: string
  status: string
  count: number
  /** Age of the OLDEST row in this bucket, in ms — the one worth investigating, not an average. */
  oldestAgeMs: number
}

export interface DiagWorkerStat {
  id: string
  kinds: string[]
  state: string
  pid: number | null
  /** null when /proc isn't available (non-Linux) or the read failed — never a reason to fail the whole report. */
  rssMb: number | null
}

export interface DiagStalledCandidate {
  jobId: string
  tenantId: string
  kind: string
  attempts: number
  maxAttempts: number
  ageMs: number
}

export interface DiagReport {
  generatedAt: string
  jobsByBucket: DiagJobBucket[]
  oldestClaimedOrRunning: { jobId: string; tenantId: string; kind: string; status: string; ageMs: number } | null
  /** Jobs sitting at attempts >= maxAttempts - 1 but still pending/claimed/running — one defer/retry away from parking, worth a human glance even before they fail outright. */
  deferralLoopCandidates: DiagStalledCandidate[]
  workers: DiagWorkerStat[]
  queueDepthTotal: number
  eventLoopP99Ms: number | null
  memory: {
    rssMb: number
    /** From process.constrainedMemory() (cgroup limit inside a container) — null outside one, e.g. bare Node on a VM with no cgroup limit set. */
    limitMb: number | null
  }
}

/** Linux-only (`/proc/<pid>/status`); returns null anywhere else or on any read failure — a missing number is never worth crashing the report over. */
async function readRssMb(pid: number): Promise<number | null> {
  try {
    const text = await fs.readFile(`/proc/${pid}/status`, 'utf8')
    const match = text.match(/^VmRSS:\s+(\d+)\s+kB$/m)
    return match ? Math.round(Number(match[1]) / 1024) : null
  } catch {
    return null
  }
}

/**
 * Everything `npm run diag` (scripts/diag.ts) needs that only the live
 * server process can answer — worker RSS, in-memory pool state, event-loop
 * delay. The job-table breakdown is read fresh from control.db on every
 * call; cheap (indexed by status/kind), no caching, since this is an
 * on-demand operator tool, not a polled dashboard.
 */
export async function getDiagnostics(): Promise<DiagReport> {
  const db = getControlDb()

  const buckets = db
    .prepare(
      `SELECT kind, status, COUNT(*) AS count, MIN(created_at) AS oldest
       FROM jobs GROUP BY kind, status`
    )
    .all() as { kind: string; status: string; count: number; oldest: string }[]
  const now = Date.now()
  const jobsByBucket: DiagJobBucket[] = buckets.map(b => ({
    kind: b.kind,
    status: b.status,
    count: b.count,
    oldestAgeMs: now - new Date(b.oldest).getTime(),
  }))

  const oldestRow = db
    .prepare(
      `SELECT id, tenant_id, kind, status, claimed_at FROM jobs
       WHERE status IN ('claimed', 'running') ORDER BY claimed_at ASC LIMIT 1`
    )
    .get() as { id: string; tenant_id: string; kind: string; status: string; claimed_at: string } | undefined
  const oldestClaimedOrRunning = oldestRow
    ? {
        jobId: oldestRow.id,
        tenantId: oldestRow.tenant_id,
        kind: oldestRow.kind,
        status: oldestRow.status,
        ageMs: now - new Date(oldestRow.claimed_at).getTime(),
      }
    : null

  const deferralRows = db
    .prepare(
      `SELECT id, tenant_id, kind, attempts, max_attempts, created_at FROM jobs
       WHERE status IN ('pending', 'claimed', 'running') AND attempts >= max_attempts - 1 AND max_attempts > 1
       ORDER BY attempts DESC LIMIT 50`
    )
    .all() as { id: string; tenant_id: string; kind: string; attempts: number; max_attempts: number; created_at: string }[]
  const deferralLoopCandidates: DiagStalledCandidate[] = deferralRows.map(r => ({
    jobId: r.id,
    tenantId: r.tenant_id,
    kind: r.kind,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    ageMs: now - new Date(r.created_at).getTime(),
  }))

  const poolStatus = getPool().status()
  const workers: DiagWorkerStat[] = await Promise.all(
    poolStatus.workers.map(async w => ({
      id: w.id,
      kinds: w.kinds,
      state: w.state,
      pid: w.pid,
      rssMb: w.pid ? await readRssMb(w.pid) : null,
    }))
  )

  const globalQueue = queue.stats()
  const eventLoop = getEventLoopStats()
  const limitBytes = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0

  return {
    generatedAt: new Date(now).toISOString(),
    jobsByBucket,
    oldestClaimedOrRunning,
    deferralLoopCandidates,
    workers,
    queueDepthTotal: globalQueue.pending + globalQueue.claimed + globalQueue.running,
    eventLoopP99Ms: eventLoop?.p99Ms ?? null,
    memory: {
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      limitMb: limitBytes > 0 ? Math.round(limitBytes / 1024 / 1024) : null,
    },
  }
}

// ─── Actions ────────────────────────────────────────────────────────────────

export class AdminActionError extends Error {}

interface Actor {
  /** Null for the lockout-recovery CLI (scripts/admin-create-tenant.ts, scripts/admin-reset-password.ts), which runs with no logged-in admin session to attribute the action to — `audit_log.actor_user_id` allows NULL for exactly this case. */
  userId: string | null
}

/**
 * Create a tenant and its first (owner) user. Honors
 * `ALLOW_MULTI_TENANT_PREVIEW` exactly the way `tenants.create` always has
 * — the error it throws when the flag is off is already a clear, specific
 * message, not a generic failure, so this re-throws it as-is rather than
 * wrapping it in something vaguer.
 */
export async function createTenantAndFirstUser(
  input: { tenantName: string; email: string; quotas?: Partial<Omit<QuotaRecord, 'tenantId'>> },
  actor: Actor
): Promise<{ tenantId: string; userId: string; tempPassword: string }> {
  if (users.findByEmail(input.email)) {
    throw new AdminActionError(`a user with email ${input.email} already exists`)
  }

  const tenant = tenants.create(input.tenantName) // throws its own clear message if preview mode forbids a second tenant

  // tenants.create() only inserts the CONTROL-PLANE row (tenants, quotas,
  // tenant_queue_state, ai_extend_tenant_state) — this tenant has no app.db
  // and no media directories yet, which every tenant-scoped page/query
  // assumes exist. Every other path that creates a tenant (the legacy-
  // migration bootstrap, every test fixture) does both of these
  // immediately afterward; this one was missing it.
  ensureMediaRoots(tenant.id)
  migrate(openTenantDbById(tenant.id))

  const tempPassword = generateTempPassword()
  const passwordHash = await hashPassword(tempPassword)
  const user = users.create({ email: input.email, passwordHash, mustChangePassword: true })
  memberships.create(user.id, tenant.id, 'owner')

  if (input.quotas) quotas.update(tenant.id, input.quotas)

  auditLog.record({
    actorUserId: actor.userId,
    tenantId: tenant.id,
    action: 'admin_create_tenant',
    detail: { tenantName: tenant.name, email: user.email },
  })

  return { tenantId: tenant.id, userId: user.id, tempPassword }
}

export function suspendTenant(tenantId: string, actor: Actor): void {
  const tenant = tenants.get(tenantId)
  if (!tenant) throw new AdminActionError('tenant not found')

  tenants.setStatus(tenantId, 'suspended')
  for (const membership of memberships.listForTenant(tenantId)) {
    sessions.revokeAllForUser(membership.userId)
  }

  auditLog.record({ actorUserId: actor.userId, tenantId, action: 'admin_suspend_tenant', detail: { name: tenant.name } })
}

export function resumeTenant(tenantId: string, actor: Actor): void {
  const tenant = tenants.get(tenantId)
  if (!tenant) throw new AdminActionError('tenant not found')

  tenants.setStatus(tenantId, 'active')
  auditLog.record({ actorUserId: actor.userId, tenantId, action: 'admin_resume_tenant', detail: { name: tenant.name } })
}

/**
 * Edits quotas and/or scheduler weight. Weight lives in two places
 * (`quotas.weight`, the admin-editable source of truth, and
 * `tenant_queue_state.weight`, the scheduler's own working copy — see that
 * column's doc comment) — this keeps both in sync in one call. Effective
 * immediately on the next enqueue (quota checks read `quotas` live) or
 * claim (the scheduler reads `tenant_queue_state` live); neither is cached.
 */
export function updateTenantQuotas(
  tenantId: string,
  patch: Partial<Omit<QuotaRecord, 'tenantId'>>,
  actor: Actor
): QuotaRecord {
  const tenant = tenants.get(tenantId)
  if (!tenant) throw new AdminActionError('tenant not found')

  const updated = quotas.update(tenantId, patch)
  if (patch.weight !== undefined) tenantQueueState.setWeight(tenantId, patch.weight)

  auditLog.record({ actorUserId: actor.userId, tenantId, action: 'admin_update_quotas', detail: patch })
  return updated
}

export async function resetUserPassword(userId: string, actor: Actor): Promise<{ tempPassword: string }> {
  const user = users.get(userId)
  if (!user) throw new AdminActionError('user not found')

  const tempPassword = generateTempPassword()
  const passwordHash = await hashPassword(tempPassword)
  users.setPasswordHash(userId, passwordHash, true)
  sessions.revokeAllForUser(userId)

  const membership = memberships.findForUser(userId)
  // Never log the password itself — only that a reset happened, for whom.
  auditLog.record({
    actorUserId: actor.userId,
    tenantId: membership?.tenantId ?? null,
    action: 'admin_reset_password',
    detail: { email: user.email },
  })

  return { tempPassword }
}

export function markTenantPendingDeletion(tenantId: string, actor: Actor): void {
  const tenant = tenants.get(tenantId)
  if (!tenant) throw new AdminActionError('tenant not found')

  tenants.markPendingDeletion(tenantId)
  auditLog.record({
    actorUserId: actor.userId,
    tenantId,
    action: 'admin_mark_pending_deletion',
    detail: { name: tenant.name },
  })
}

export function cancelPendingDeletion(tenantId: string, actor: Actor): void {
  const tenant = tenants.get(tenantId)
  if (!tenant) throw new AdminActionError('tenant not found')

  tenants.unmarkPendingDeletion(tenantId)
  auditLog.record({
    actorUserId: actor.userId,
    tenantId,
    action: 'admin_cancel_pending_deletion',
    detail: { name: tenant.name },
  })
}

/**
 * Step two of deletion — irreversible. Requires the tenant to already be
 * `pending_deletion` (step one) and the caller to type the tenant's exact
 * current name, the same "can't do this by accident" pattern GitHub/similar
 * admin UIs use for destructive actions.
 *
 * Jobs, memberships, quotas, usage counters, scheduler state and queue-wait
 * rollups are all removed by the `tenants` row's own `ON DELETE CASCADE`
 * foreign keys (control-schema.sql) the instant `tenants.delete` runs —
 * there is nothing left to separately "cancel", which is the strongest
 * possible reading of the spec's "purge cancels jobs". `audit_log` uses
 * `ON DELETE SET NULL` instead (deliberately, so the historical record
 * survives), which is why the audit entry below is written BEFORE the
 * delete, while `tenant_id` can still be set to something meaningful.
 */
export async function purgeTenant(tenantId: string, confirmName: string, actor: Actor): Promise<void> {
  const tenant = tenants.get(tenantId)
  if (!tenant) throw new AdminActionError('tenant not found')
  if (tenant.status !== 'pending_deletion') {
    throw new AdminActionError('tenant must be marked pending deletion before it can be purged')
  }
  if (confirmName !== tenant.name) {
    throw new AdminActionError('confirmation name does not match the tenant name')
  }

  auditLog.record({
    actorUserId: actor.userId,
    tenantId,
    action: 'admin_purge_tenant',
    detail: { name: tenant.name },
  })

  closeTenantDb(tenantId)
  tenants.delete(tenantId)
  await purgeTenantDirectory(tenantId)
}

// ─── Audit log viewer ───────────────────────────────────────────────────────

export function listAuditLog(filters: {
  actorUserId?: string
  action?: string
  tenantId?: string
  fromDate?: string
  toDate?: string
  limit?: number
  offset?: number
}): AuditLogEntry[] {
  return auditLog.list(filters)
}
