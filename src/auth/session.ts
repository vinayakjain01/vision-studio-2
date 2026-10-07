/**
 * Session tokens.
 *
 * A session is a random 256-bit token handed to the browser in a cookie;
 * only its SHA-256 hash is ever stored (`control-repositories.ts`'s
 * `sessions` table), so reading the database (a backup, a leaked file)
 * cannot be used to forge a session the way storing the token itself would
 * allow.
 *
 * Deliberately has no dependency on Next.js's request/cookie types — route
 * handlers, middleware, and Server Component pages each read a cookie
 * through a different Next.js API (`NextRequest.cookies`,
 * `next/headers`'s `cookies()`), so this module just takes a plain token
 * string and lets each caller extract it however that context requires.
 *
 * Server-only.
 */

import crypto from 'crypto'
import { config } from '@/config'
import { sessions, memberships, users, tenants } from '@/db/control-repositories'
import type { TenantContext } from '@/tenancy/context'

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('base64url') // 256 bits
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

/** See `resolveSession`'s sliding-expiry debounce. */
const SESSION_TOUCH_DEBOUNCE_MS = 60_000

export interface ResolvedSession {
  sessionId: string
  userId: string
  isPlatformAdmin: boolean
  /** Null for a platform_admin with no personal tenant — otherwise always set. */
  tenant: TenantContext | null
  /** Set by an admin-initiated account creation or password reset (P5) — middleware confines this session to the change-password flow until cleared. */
  mustChangePassword: boolean
}

/**
 * Validates a raw session token end to end: hash lookup, expiry, revocation,
 * the user not being disabled, and resolving their tenant membership.
 * Returns null for ANY failure — callers must treat null uniformly as "not
 * logged in" and never branch on which specific check failed, so a bug
 * can't turn "expired" into a more informative (and more exploitable) error
 * than "invalid".
 *
 * Slides the session's expiry forward on every successful resolution.
 */
export function resolveSession(token: string | undefined | null): ResolvedSession | null {
  if (!token) return null

  const session = sessions.findByTokenHash(hashToken(token))
  if (!session) return null
  if (session.revokedAt) return null
  if (new Date(session.expiresAt).getTime() <= Date.now()) return null

  const user = users.get(session.userId)
  if (!user || user.disabledAt) return null

  const membership = memberships.findForUser(user.id)

  // A suspended tenant's sessions are revoked as part of the suspend action
  // itself — this is the defensive second check (same "never trust just one
  // gate" posture as the rest of this function), for the brief window
  // between marking the tenant suspended and that revoke actually running.
  if (membership && tenants.get(membership.tenantId)?.status === 'suspended') return null

  // Debounced: every authenticated request (every page view, every API call)
  // reaches this function, and a plain WAL-mode UPDATE still needs
  // control.db's single writer lock — a busy session polling or navigating
  // several times a second would otherwise make that file write-hot for no
  // behavioural benefit (a session due to expire in 30 days does not
  // meaningfully care whether its last-touch is one second or one minute
  // stale). Skipping the write when the LAST update was recent enough keeps
  // the effective sliding window, just rounded to this granularity.
  const msSinceLastSeen = Date.now() - new Date(session.lastSeenAt).getTime()
  if (msSinceLastSeen > SESSION_TOUCH_DEBOUNCE_MS) {
    const newExpiresAt = new Date(Date.now() + config.auth.sessionTtlMs).toISOString()
    sessions.touch(session.id, newExpiresAt)
  }

  return {
    sessionId: session.id,
    userId: user.id,
    isPlatformAdmin: user.isPlatformAdmin,
    tenant: membership
      ? { tenantId: membership.tenantId, userId: user.id, role: membership.role }
      : null,
    mustChangePassword: user.mustChangePassword,
  }
}

export function createSession(userId: string): { token: string; expiresAt: string } {
  const token = generateSessionToken()
  const expiresAt = new Date(Date.now() + config.auth.sessionTtlMs).toISOString()
  sessions.create(userId, hashToken(token), expiresAt)
  return { token, expiresAt }
}

export function revokeSessionByToken(token: string | undefined | null): void {
  if (!token) return
  const session = sessions.findByTokenHash(hashToken(token))
  if (session) sessions.revoke(session.id)
}
