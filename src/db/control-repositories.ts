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
}

// ─── Tenants ────────────────────────────────────────────────────────────────

export interface TenantRecord {
  id: string
  name: string
  status: 'active' | 'suspended'
  createdAt: string
  updatedAt: string
}

function toTenant(row: any): TenantRecord {
  return { id: row.id, name: row.name, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }
}

export const tenants = {
  /**
   * Creates the tenant AND its default quota row in one transaction — a
   * tenant with no quota row is a bug waiting to happen once P3 starts
   * enforcing them.
   *
   * Refuses to create a SECOND tenant unless `ALLOW_MULTI_TENANT_PREVIEW=1`
   * is set. The worker pool and job queue are still single-tenant until P3
   * (see docs/MULTI_TENANCY.md §3.3) — bound at startup to whichever one
   * tenant `resolveDefaultTenantId()` finds, and it refuses to run at all
   * once a second exists. Letting a second tenant get created here anyway
   * would silently run every tenant's jobs against the first one's data
   * instead, which is a correctness bug, not a missing feature. This is
   * the one place that guarantee can be enforced regardless of which
   * script or route ends up calling it.
   */
  create(name: string, db: Db = getControlDb()): TenantRecord {
    if (!config.auth.allowMultiTenantPreview) {
      const existing = db.prepare('SELECT COUNT(*) AS c FROM tenants').get() as { c: number }
      if (existing.c > 0) {
        throw new Error(
          'Refusing to create a second tenant: the worker pool and job queue are still ' +
            'single-tenant until P3 (see docs/MULTI_TENANCY.md §3.3) and would run every ' +
            "tenant's jobs against whichever one resolveDefaultTenantId() picks. Set " +
            'ALLOW_MULTI_TENANT_PREVIEW=1 only if you understand this is a data/auth-layer ' +
            'preview, not a supported multi-tenant deployment.'
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

  setStatus(id: string, status: 'active' | 'suspended'): void {
    getControlDb()
      .prepare('UPDATE tenants SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, nowIso(), id)
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
}
