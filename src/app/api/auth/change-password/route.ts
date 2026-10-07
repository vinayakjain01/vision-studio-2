/**
 * Self-service password change.
 *
 * Requires the CURRENT password (not just an active session) — a session
 * token sitting in a browser is not proof the person at the keyboard right
 * now is who they claim to be. On success, every OTHER session for this
 * user is revoked (a shared computer, a stolen cookie elsewhere); the
 * session making this request is deliberately kept alive, same reasoning as
 * most account-settings pages: changing your own password should not also
 * log you out of the tab you just did it from.
 */

import { NextRequest } from 'next/server'
import { config } from '@/config'
import { resolveSession } from '@/auth/session'
import { hashPassword, verifyPassword } from '@/auth/password'
import { users, sessions, auditLog } from '@/db/control-repositories'
import { handler, ok, badRequest, unauthorized } from '@/lib/api-handler'

export const dynamic = 'force-dynamic'

const MIN_PASSWORD_LENGTH = 8

export const POST = handler(async (request: NextRequest) => {
  const token = request.cookies.get(config.auth.sessionCookieName)?.value
  const resolved = resolveSession(token)
  // handler() already required a valid session to reach this point; re-
  // resolving here (cheap, same debounced touch as any other request) is
  // the only way to learn WHICH session this request came from, so the
  // revoke-all-but-this-one below can actually exclude it.
  if (!resolved) return unauthorized()

  const body = await request.json().catch(() => null)
  const currentPassword = typeof body?.currentPassword === 'string' ? body.currentPassword : ''
  const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : ''

  if (!currentPassword || !newPassword) {
    return badRequest('currentPassword and newPassword are required')
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return badRequest(`new password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  }

  const user = users.get(resolved.userId)
  if (!user) return unauthorized()

  const valid = await verifyPassword(user.passwordHash, currentPassword)
  if (!valid) {
    auditLog.record({ actorUserId: user.id, tenantId: null, action: 'change_password_failed', detail: {} })
    return badRequest('current password is incorrect')
  }

  const newHash = await hashPassword(newPassword)
  users.setPasswordHash(user.id, newHash, false)
  sessions.revokeAllForUserExcept(user.id, resolved.sessionId)

  auditLog.record({ actorUserId: user.id, tenantId: null, action: 'change_password', detail: {} })

  return ok({ ok: true })
})
