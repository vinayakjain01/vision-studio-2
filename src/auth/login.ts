/**
 * Login: rate limiting + credential check + session creation, as one unit.
 *
 * Server-only.
 */

import { config } from '@/config'
import { users, loginAttempts, memberships, tenants } from '@/db/control-repositories'
import { verifyPassword } from './password'
import { createSession } from './session'

/**
 * A real argon2id hash of a fixed, meaningless password — never anyone's
 * actual credential. Verified against on every login for an email that
 * doesn't exist, so that path costs the same ~50-100ms argon2 always takes
 * rather than returning instantly. Without this, response time alone would
 * tell an attacker which emails have accounts.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,p=4,t=3$GLXBkPidmahD1aov3uToSA$tnIMRP4fGRsMi9oezxGcwAjobPxa0Muc/tusDy8gDBE'

export type LoginResult =
  | { ok: true; token: string; expiresAt: string; mustChangePassword: boolean }
  | { ok: false; reason: 'rate_limited' | 'invalid_credentials' | 'disabled' }

/**
 * Generic failure reason on purpose: the route layer must show the same
 * "incorrect email or password" message for `invalid_credentials` and
 * `disabled` alike. Distinguishing them here is still useful for the audit
 * log, just never for the response shown to whoever's asking.
 */
export async function attemptLogin(email: string, password: string, ip: string): Promise<LoginResult> {
  const emailKey = `email:${email.trim().toLowerCase()}`
  const ipKey = `ip:${ip}`

  // Per-account AND per-IP, independently — the per-IP window is wider
  // (4x the attempts) because a shared office/NAT IP genuinely has several
  // people failing their own passwords, while ten failures against one
  // account from anywhere is never that.
  const emailFailures = loginAttempts.recentFailures(emailKey, config.auth.loginWindowMs)
  const ipFailures = loginAttempts.recentFailures(ipKey, config.auth.loginWindowMs)
  if (emailFailures >= config.auth.loginMaxAttempts || ipFailures >= config.auth.loginMaxAttempts * 4) {
    return { ok: false, reason: 'rate_limited' }
  }

  const user = users.findByEmail(email)
  const valid = await verifyPassword(user?.passwordHash ?? DUMMY_HASH, password)

  if (!user || !valid) {
    loginAttempts.record(emailKey, false)
    loginAttempts.record(ipKey, false)
    return { ok: false, reason: 'invalid_credentials' }
  }

  if (user.disabledAt) {
    loginAttempts.record(emailKey, false)
    loginAttempts.record(ipKey, false)
    return { ok: false, reason: 'disabled' }
  }

  // Suspending a TENANT (P5 admin action) revokes every existing session at
  // the moment it happens, but must ALSO block a fresh login afterward with
  // correct credentials — this is that second check. A platform admin with
  // no personal tenant has no membership to find here, so this never
  // affects them.
  const membership = memberships.findForUser(user.id)
  if (membership && tenants.get(membership.tenantId)?.status === 'suspended') {
    loginAttempts.record(emailKey, false)
    loginAttempts.record(ipKey, false)
    return { ok: false, reason: 'disabled' }
  }

  loginAttempts.record(emailKey, true)
  loginAttempts.record(ipKey, true)

  const { token, expiresAt } = createSession(user.id)
  return { ok: true, token, expiresAt, mustChangePassword: user.mustChangePassword }
}
