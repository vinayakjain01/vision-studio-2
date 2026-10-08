/**
 * Control-plane data access: users, tenants, memberships, sessions, login
 * attempts, quotas, usage, audit log.
 *
 * Mirrors the shape of `db/repositories.ts` (plain objects of methods, one
 * per table, each statement prepared inline) but against `getControlDb()`
 * instead of the tenant-scoped `getDb()` — control-plane data has no tenant
 * to scope BY, it's what every request uses to figure out which tenant it
 * even is.
 */

import { nanoid } from 'nanoid'
import { config } from '@/config'
import { getControlDb, nowIso, transactionOn, bool, type Db } from './client'

export function newId(prefix: string): string {
  return `${prefix}_${nanoid(16)}`
}

// ─── Users ──────────────────────────────────────────────────────────────────

export interface UserRecord {
  id: string
  email: string
  passwordHash: string
  isPlatformAdmin: boolean
  mustChangePassword: boolean
  disabledAt: string | null
  createdAt: string
  updatedAt: string
}

function toUser(row: any): UserRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    isPlatformAdmin: bool(row.is_platform_admin),
    mustChangePassword: bool(row.must_change_password),
    disabledAt: row.disabled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const users = {
  create(input: {
    email: string
    passwordHash: string
    isPlatformAdmin?: boolean
    mustChangePassword?: boolean
  }): UserRecord {
    const db = getControlDb()
    const id = newId('usr')
    const now = nowIso()
    db.prepare(
      `INSERT INTO users (id, email, email_lower, password_hash, is_platform_admin, must_change_password, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.email,
      input.email.trim().toLowerCase(),
      input.passwordHash,
      input.isPlatformAdmin ? 1 : 0,
      input.mustChangePassword ? 1 : 0,
      now,
      now
    )
    return this.get(id)!
  },

  get(id: string): UserRecord | null {
    const row = getControlDb().prepare('SELECT * FROM users WHERE id = ?').get(id)
    return row ? toUser(row) : null
  },

  findByEmail(email: string): UserRecord | null {
    const row = getControlDb()
      .prepare('SELECT * FROM users WHERE email_lower = ?')
      .get(email.trim().toLowerCase())
    return row ? toUser(row) : null
  },

  setPasswordHash(id: string, passwordHash: string, mustChangePassword = false): void {
    getControlDb()
      .prepare(
        'UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = ? WHERE id = ?'
      )
      .run(passwordHash, mustChangePassword ? 1 : 0, nowIso(), id)
  },

  setDisabled(id: string, disabled: boolean): void {
    getControlDb()
      .prepare('UPDATE users SET disabled_at = ?, updated_at = ? WHERE id = ?')
      .run(disabled ? nowIso() : null, nowIso(), id)
  },

  /** Grants or revokes platform-admin access for an EXISTING user — the one-time bootstrap (`scripts/tenants-migrate-legacy.ts`) only sets this at creation, so a second or later admin needs this instead. */
  setPlatformAdmin(id: string, isPlatformAdmin: boolean): void {
    getControlDb()
      .prepare('UPDATE users SET is_platform_admin = ?, updated_at = ? WHERE id = ?')
      .run(isPlatformAdmin ? 1 : 0, nowIso(), id)
  },
}

// ─── Tenants ────────────────────────────────────────────────────────────────

export type TenantStatus = 'active' | 'suspended' | 'pending_deletion'

export interface TenantRecord {
  id: string
  name: string
  status: TenantStatus
  pendingDeletionAt: string | null
  createdAt: string
  updatedAt: string
}

function toTenant(row: any): TenantRecord {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    pendingDeletionAt: row.pending_deletion_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const tenants = {
  /**
   * Creates the tenant AND its default quota/scheduler-state rows in one
   * transaction — a tenant with no quota row is a bug waiting to happen, and
   * every tenant needs a `tenant_queue_state` row before it can ever have a
   * job claimed fairly.
   *
   * Refuses to create a SECOND tenant unless `ALLOW_MULTI_TENANT_PREVIEW=1`
   * is set. This is no longer an architectural limitation — as of P3 the
   * worker pool binds tenant context per JOB (see src/jobs/worker-entry.ts)
   * and the scheduler fair-shares across tenants by construction, so nothing
   * here would behave incorrectly with a second real tenant. The guard stays
   * in place anyway because that's what was asked for after P2 shipped:
   * multi-tenant operation should be turned on deliberately, not as a side
   * effect of whoever next runs the legacy-migration script, so it remains
   * an explicit opt-in until that instruction is lifted.
   */
  create(name: string, db: Db = getControlDb()): TenantRecord {
    if (!config.auth.allowMultiTenantPreview) {
      const existing = db.prepare('SELECT COUNT(*) AS c FROM tenants').get() as { c: number }
      if (existing.c > 0) {
        throw new Error(
          'Refusing to create a second tenant: multi-tenant operation is implemented (P3) but ' +
            'stays behind an explicit opt-in until turned on deliberately. Set ' +
            'ALLOW_MULTI_TENANT_PREVIEW=1 to create additional tenants.'
        )
      }
    }

    return transactionOn(db, conn => {
      const id = newId('tnt')
      const now = nowIso()
      conn
        .prepare('INSERT INTO tenants (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, name, 'active', now, now)
      conn.prepare('INSERT INTO quotas (tenant_id) VALUES (?)').run(id)
      // `tenant_queue_state.weight` starts as a copy of `quotas.weight`
      // (both default 1.0) rather than one column serving both roles: the
      // scheduler's claim query reads this row on every claim and must never
      // block on or join against `quotas` (an admin-editable table a request
      // handler could be writing to concurrently) — see
      // docs/MULTI_TENANCY.md §3.2. An admin changing `quotas.weight` later
      // re-syncs this copy explicitly (`tenantQueueState.setWeight`), the
      // same deliberate-copy pattern `images.vision_status` already uses as
      // a denormalised mirror of `vision_analyses.status`.
      conn.prepare('INSERT INTO tenant_queue_state (tenant_id, weight, running_jobs) VALUES (?, 1.0, 0)').run(id)
      conn.prepare('INSERT INTO ai_extend_tenant_state (tenant_id, in_flight) VALUES (?, 0)').run(id)
      return toTenant(conn.prepare('SELECT * FROM tenants WHERE id = ?').get(id))
    })
  },

  get(id: string): TenantRecord | null {
    const row = getControlDb().prepare('SELECT * FROM tenants WHERE id = ?').get(id)
    return row ? toTenant(row) : null
  },

  list(): TenantRecord[] {
    return getControlDb()
      .prepare('SELECT * FROM tenants ORDER BY created_at ASC')
      .all()
      .map(toTenant)
  },

  /** For 'active'/'suspended' only — use `markPendingDeletion`/`unmarkPendingDeletion` for that state, which also manage `pending_deletion_at`. */
  setStatus(id: string, status: 'active' | 'suspended'): void {
    getControlDb()
      .prepare('UPDATE tenants SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, nowIso(), id)
  },

  markPendingDeletion(id: string): void {
    const now = nowIso()
    getControlDb()
      .prepare('UPDATE tenants SET status = ?, pending_deletion_at = ?, updated_at = ? WHERE id = ?')
      .run('pending_deletion', now, now, id)
  },

  /** Admin changed their mind before purging — back to active, deletion timer cleared. */
  unmarkPendingDeletion(id: string): void {
    getControlDb()
      .prepare("UPDATE tenants SET status = 'active', pending_deletion_at = NULL, updated_at = ? WHERE id = ?")
      .run(nowIso(), id)
  },

  /** Permanently removes the tenant row — cascades to memberships/quotas/tenant_queue_state/ai_extend_tenant_state/usage_counters via their FKs. Caller is responsible for the tenant's jobs (no FK, separate table) and its on-disk media directory. */
  delete(id: string): void {
    getControlDb().prepare('DELETE FROM tenants WHERE id = ?').run(id)
  },
}

// ─── Memberships ────────────────────────────────────────────────────────────

export interface MembershipRecord {
  id: string
  userId: string
  tenantId: string
  role: 'owner' | 'member'
  createdAt: string
}

function toMembership(row: any): MembershipRecord {
  return { id: row.id, userId: row.user_id, tenantId: row.tenant_id, role: row.role, createdAt: row.created_at }
}

export const memberships = {
  create(userId: string, tenantId: string, role: 'owner' | 'member', db: Db = getControlDb()): MembershipRecord {
    const id = newId('mem')
    const now = nowIso()
    db.prepare(
      'INSERT INTO memberships (id, user_id, tenant_id, role, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, userId, tenantId, role, now)
    return { id, userId, tenantId, role, createdAt: now }
  },

  /**
   * v1: a user belongs to exactly one tenant (their personal one), so "the"
   * membership is unambiguous. Returns the oldest if somehow more than one
   * exists (future-proofing for when a user can join a second tenant,
   * without this call site needing to change).
   */
  findForUser(userId: string): MembershipRecord | null {
    const row = getControlDb()
      .prepare('SELECT * FROM memberships WHERE user_id = ? ORDER BY created_at ASC LIMIT 1')
      .get(userId)
    return row ? toMembership(row) : null
  },

  listForUser(userId: string): MembershipRecord[] {
    return getControlDb()
      .prepare('SELECT * FROM memberships WHERE user_id = ? ORDER BY created_at ASC')
      .all(userId)
      .map(toMembership)
  },

  /** Every member of a tenant — used by the admin suspend action to find every session that needs revoking. */
  listForTenant(tenantId: string): MembershipRecord[] {
    return getControlDb()
      .prepare('SELECT * FROM memberships WHERE tenant_id = ? ORDER BY created_at ASC')
      .all(tenantId)
      .map(toMembership)
  },
}

// ─── Sessions ───────────────────────────────────────────────────────────────

export interface SessionRecord {
  id: string
  userId: string
  tokenHash: string
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  revokedAt: string | null
}

function toSession(row: any): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  }
}

export const sessions = {
  create(userId: string, tokenHash: string, expiresAt: string): SessionRecord {
    const db = getControlDb()
    const id = newId('ses')
    const now = nowIso()
    db.prepare(
      `INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, userId, tokenHash, now, now, expiresAt)
    return { id, userId, tokenHash, createdAt: now, lastSeenAt: now, expiresAt, revokedAt: null }
  },

  findByTokenHash(tokenHash: string): SessionRecord | null {
    const row = getControlDb().prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash)
    return row ? toSession(row) : null
  },

  /** Sliding expiry: bump `last_seen_at` and push `expires_at` out again. */
  touch(id: string, expiresAt: string): void {
    getControlDb()
      .prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
      .run(nowIso(), expiresAt, id)
  },

  revoke(id: string): void {
    getControlDb().prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(nowIso(), id)
  },

  /** Revokes every session for a user — "log out everywhere", used on password change. */
  revokeAllForUser(userId: string): void {
    getControlDb()
      .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(nowIso(), userId)
  },

  /**
   * Same as `revokeAllForUser`, but keeps one session alive — the one doing
   * the revoking. Used by self-service password change: the person changing
   * their OWN password should not be logged out of the tab they just did it
   * from, only every other session (a shared computer, a stolen cookie).
   */
  revokeAllForUserExcept(userId: string, keepSessionId: string): void {
    getControlDb()
      .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL')
      .run(nowIso(), userId, keepSessionId)
  },

  /** Housekeeping: delete sessions that expired or were revoked more than a day ago. Safe to call often; cheap no-op when there's nothing to prune. */
  pruneExpired(): number {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const result = getControlDb()
      .prepare('DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)')
      .run(cutoff, cutoff)
    return result.changes
  },
}

// ─── Login attempts (rate limiting) ────────────────────────────────────────

export const loginAttempts = {
  record(identifier: string, succeeded: boolean): void {
    getControlDb()
      .prepare('INSERT INTO login_attempts (id, identifier, attempted_at, succeeded) VALUES (?, ?, ?, ?)')
      .run(newId('att'), identifier, nowIso(), succeeded ? 1 : 0)
  },

  /** Count of FAILED attempts for this identifier within the last `windowMs`. */
  recentFailures(identifier: string, windowMs: number): number {
    const since = new Date(Date.now() - windowMs).toISOString()
    const row = getControlDb()
      .prepare(
        'SELECT COUNT(*) AS c FROM login_attempts WHERE identifier = ? AND succeeded = 0 AND attempted_at > ?'
      )
      .get(identifier, since) as { c: number }
    return row.c
  },

  pruneOld(olderThanMs: number): number {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString()
    const result = getControlDb().prepare('DELETE FROM login_attempts WHERE attempted_at < ?').run(cutoff)
    return result.changes
  },
}

// ─── Audit log ──────────────────────────────────────────────────────────────

export interface AuditLogEntry {
  id: string
  actorUserId: string | null
  tenantId: string | null
  action: string
  detail: unknown
  createdAt: string
}

function toAuditLogEntry(row: any): AuditLogEntry {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    tenantId: row.tenant_id,
    action: row.action,
    detail: row.detail ? JSON.parse(row.detail) : null,
    createdAt: row.created_at,
  }
}

export const auditLog = {
  record(entry: {
    actorUserId: string | null
    tenantId: string | null
    action: string
    detail?: unknown
  }): void {
    getControlDb()
      .prepare(
        'INSERT INTO audit_log (id, actor_user_id, tenant_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        newId('aud'),
        entry.actorUserId,
        entry.tenantId,
        entry.action,
        entry.detail != null ? JSON.stringify(entry.detail) : null,
        nowIso()
      )
  },

  /** Filtered, paginated listing for the P5 admin audit log viewer. Every filter is optional and AND-combined. */
  list(filters: {
    actorUserId?: string
    action?: string
    tenantId?: string
    fromDate?: string
    toDate?: string
    limit?: number
    offset?: number
  }): AuditLogEntry[] {
    const clauses: string[] = []
    const params: unknown[] = []
    if (filters.actorUserId) {
      clauses.push('actor_user_id = ?')
      params.push(filters.actorUserId)
    }
    if (filters.action) {
      clauses.push('action = ?')
      params.push(filters.action)
    }
    if (filters.tenantId) {
      clauses.push('tenant_id = ?')
      params.push(filters.tenantId)
    }
    if (filters.fromDate) {
      clauses.push('created_at >= ?')
      params.push(filters.fromDate)
    }
    if (filters.toDate) {
      clauses.push('created_at <= ?')
      params.push(filters.toDate)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.min(500, filters.limit ?? 100)
    const offset = filters.offset ?? 0
    return getControlDb()
      .prepare(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset)
      .map(toAuditLogEntry)
  },
}

// ─── Quotas ─────────────────────────────────────────────────────────────────

export interface QuotaRecord {
  tenantId: string
  maxQueuedJobs: number
  maxImagesPerBatch: number
  maxConcurrentUploads: number
  maxStorageBytes: number
  maxAiExtendPerMonth: number
  weight: number
}

function toQuota(row: any): QuotaRecord {
  return {
    tenantId: row.tenant_id,
    maxQueuedJobs: row.max_queued_jobs,
    maxImagesPerBatch: row.max_images_per_batch,
    maxConcurrentUploads: row.max_concurrent_uploads,
    maxStorageBytes: row.max_storage_bytes,
    maxAiExtendPerMonth: row.max_ai_extend_per_month,
    weight: row.weight,
  }
}

export const quotas = {
  get(tenantId: string): QuotaRecord | null {
    const row = getControlDb().prepare('SELECT * FROM quotas WHERE tenant_id = ?').get(tenantId)
    return row ? toQuota(row) : null
  },

  /**
   * Every tenant gets a `quotas` row in the same transaction `tenants.create`
   * inserts the tenant itself — this should never be missing. Throwing
   * rather than silently applying hardcoded defaults means a broken
   * invariant surfaces immediately as an error, not as a quota check that
   * quietly stopped enforcing anything.
   */
  getOrThrow(tenantId: string): QuotaRecord {
    const quota = this.get(tenantId)
    if (!quota) {
      throw new Error(`no quotas row for tenant ${tenantId} — tenants.create() should have inserted one`)
    }
    return quota
  },

  setWeight(tenantId: string, weight: number): void {
    getControlDb().prepare('UPDATE quotas SET weight = ? WHERE tenant_id = ?').run(weight, tenantId)
  },

  /**
   * Partial update for the admin "edit quotas" action — only the fields
   * present in `patch` change. Scheduler `weight` lives here too, but
   * editing it ALSO requires `tenantQueueState.setWeight` (the scheduler's
   * own working copy — see that table's doc comment for why they're two
   * columns); callers that change weight must call both, which is why
   * `admin-service.ts`'s `updateTenantQuotas` wraps this rather than routes
   * calling it directly.
   */
  update(tenantId: string, patch: Partial<Omit<QuotaRecord, 'tenantId'>>): QuotaRecord {
    const current = this.getOrThrow(tenantId)
    const next: QuotaRecord = { ...current, ...patch, tenantId }
    getControlDb()
      .prepare(
        `UPDATE quotas SET max_queued_jobs = ?, max_images_per_batch = ?, max_concurrent_uploads = ?,
                           max_storage_bytes = ?, max_ai_extend_per_month = ?, weight = ?
         WHERE tenant_id = ?`
      )
      .run(
        next.maxQueuedJobs,
        next.maxImagesPerBatch,
        next.maxConcurrentUploads,
        next.maxStorageBytes,
        next.maxAiExtendPerMonth,
        next.weight,
        tenantId
      )
    return next
  },
}

// ─── Scheduler fair-share state ─────────────────────────────────────────────

export interface TenantQueueStateRecord {
  tenantId: string
  weight: number
  runningJobs: number
}

function toQueueState(row: any): TenantQueueStateRecord {
  return { tenantId: row.tenant_id, weight: row.weight, runningJobs: row.running_jobs }
}

export const tenantQueueState = {
  get(tenantId: string): TenantQueueStateRecord | null {
    const row = getControlDb().prepare('SELECT * FROM tenant_queue_state WHERE tenant_id = ?').get(tenantId)
    return row ? toQueueState(row) : null
  },

  /** Every tenant's row, in no particular order — the claim query's own candidate iteration (src/jobs/queue.ts) is what orders by fairness. */
  listAll(): TenantQueueStateRecord[] {
    return getControlDb().prepare('SELECT * FROM tenant_queue_state').all().map(toQueueState)
  },

  /** Re-syncs the scheduler's working copy when an admin edits `quotas.weight` — see the column's doc comment in control-schema.sql for why they're two columns. */
  setWeight(tenantId: string, weight: number): void {
    getControlDb().prepare('UPDATE tenant_queue_state SET weight = ? WHERE tenant_id = ?').run(weight, tenantId)
  },
}

// ─── Usage counters (monthly, metered) ──────────────────────────────────────

export interface UsageCounter {
  tenantId: string
  period: string
  aiExtendCalls: number
  storageBytes: number
}

function toUsage(tenantId: string, period: string, row: any): UsageCounter {
  return {
    tenantId,
    period,
    aiExtendCalls: row?.ai_extend_calls ?? 0,
    storageBytes: row?.storage_bytes ?? 0,
  }
}

/** 'YYYY-MM' in UTC — the one place "what period is it" is computed, so every caller agrees on the boundary. */
export function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7)
}

export const usageCounters = {
  get(tenantId: string, period: string = currentPeriod()): UsageCounter {
    const row = getControlDb()
      .prepare('SELECT * FROM usage_counters WHERE tenant_id = ? AND period = ?')
      .get(tenantId, period)
    return toUsage(tenantId, period, row)
  },

  /**
   * Atomically bumps this month's AI Extend call count and returns the new
   * total. Called ONLY after a successful generation (never before, never on
   * a retry attempt that didn't complete) — see
   * src/jobs/ai-extend-dispatcher.ts — since this is what the tenant is
   * billed against downstream, not a request-attempt counter.
   */
  incrementAiExtendCalls(tenantId: string, period: string = currentPeriod()): number {
    const db = getControlDb()
    const now = nowIso()
    db.prepare(
      `INSERT INTO usage_counters (tenant_id, period, ai_extend_calls, storage_bytes, updated_at)
       VALUES (?, ?, 1, 0, ?)
       ON CONFLICT (tenant_id, period) DO UPDATE SET
         ai_extend_calls = ai_extend_calls + 1, updated_at = excluded.updated_at`
    ).run(tenantId, period, now)
    return (
      db.prepare('SELECT ai_extend_calls FROM usage_counters WHERE tenant_id = ? AND period = ?')
        .get(tenantId, period) as { ai_extend_calls: number }
    ).ai_extend_calls
  },

  /**
   * Incremental update to the storage gauge — a negative delta on delete.
   * Drifts over time against reality (a crash between a file write and this
   * call, a bulk directory delete that doesn't call this at all — see
   * media-store.ts's `deleteDirectory`/`deleteDerivedTree`), which is why a
   * periodic reconciliation scan (`reconcileStorageUsage` in media-store.ts)
   * exists to correct it from an actual disk scan rather than this counter
   * being treated as authoritative forever.
   */
  incrementStorageBytes(tenantId: string, deltaBytes: number, period: string = currentPeriod()): void {
    const now = nowIso()
    getControlDb()
      .prepare(
        `INSERT INTO usage_counters (tenant_id, period, ai_extend_calls, storage_bytes, updated_at)
         VALUES (?, ?, 0, MAX(0, ?), ?)
         ON CONFLICT (tenant_id, period) DO UPDATE SET
           storage_bytes = MAX(0, storage_bytes + ?), updated_at = excluded.updated_at`
      )
      .run(tenantId, period, deltaBytes, now, deltaBytes)
  },

  /** Point-in-time gauge, overwritten rather than accumulated — see the column's doc comment in control-schema.sql. */
  setStorageBytes(tenantId: string, bytes: number, period: string = currentPeriod()): void {
    const now = nowIso()
    getControlDb()
      .prepare(
        `INSERT INTO usage_counters (tenant_id, period, ai_extend_calls, storage_bytes, updated_at)
         VALUES (?, ?, 0, ?, ?)
         ON CONFLICT (tenant_id, period) DO UPDATE SET
           storage_bytes = excluded.storage_bytes, updated_at = excluded.updated_at`
      )
      .run(tenantId, period, bytes, now)
  },

  /** Sum across every tenant for the period — what the global circuit breaker (AI_EXTEND_GLOBAL_MONTHLY_CAP) actually reads. */
  globalAiExtendCalls(period: string = currentPeriod()): number {
    const row = getControlDb()
      .prepare('SELECT COALESCE(SUM(ai_extend_calls), 0) AS total FROM usage_counters WHERE period = ?')
      .get(period) as { total: number }
    return row.total
  },
}
