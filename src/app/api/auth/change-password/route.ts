/**
 * Self-service password change.
 *
 * Deliberately NOT wrapped in `src/lib/api-handler.ts`'s `handler()` — that
 * wrapper requires `resolved.tenant` (rejects with "this account has no
 * workspace" otherwise), because every ORDINARY route reads or writes one
 * tenant's own data. Changing your own password is identity-level, not
 * tenant-scoped, and a platform admin can have no personal tenant at all
 * (see `ResolvedSession`'s doc comment) — exactly the account that most
 * needs this route to work the day after an admin-initiated reset. This
 * does its own origin check + session resolution instead, the same shape
 * `adminHandler()` uses for the same reason.
 *
 * Requires the CURRENT password (not just an active session) — a session
 * token sitting in a browser is not proof the person at the keyboard right
 * now is who they claim to be. On success, every OTHER session for this
 * user is revoked (a shared computer, a stolen cookie elsewhere); the
 * session making this request is deliberately kept alive, same reasoning as
 * most account-settings pages: changing your own password should not also
 * log you out of the tab you just did it from.
 */

import { NextRequest, NextResponse } from 'next/server'
import { config } from '@/config'
import { resolveSession } from '@/auth/session'
import { hashPassword, verifyPassword } from '@/auth/password'
import { users, sessions, auditLog } from '@/db/control-repositories'
import { ok, badRequest, unauthorized, originIsTrusted, mapKnownError } from '@/lib/api-handler'

export const dynamic = 'force-dynamic'

const MIN_PASSWORD_LENGTH = 8

export async function POST(request: NextRequest) {
  try {
    if (!originIsTrusted(request)) {
      return NextResponse.json({ error: 'cross-origin request rejected' }, { status: 403 })
    }

    const token = request.cookies.get(config.auth.sessionCookieName)?.value
    const resolved = resolveSession(token)
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
  } catch (err) {
    return mapKnownError(err)
  }
}
