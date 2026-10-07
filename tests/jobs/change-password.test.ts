import crypto from 'crypto'
import { describe, it, expect } from 'vitest'
import { createTestTenant, cookieHeader } from '../helpers/tenancy-fixture'
import { makeRequest } from '../helpers/request'
import { hashPassword, verifyPassword } from '@/auth/password'
import { users, sessions } from '@/db/control-repositories'
import { createSession } from '@/auth/session'
import { POST as changePasswordPost } from '@/app/api/auth/change-password/route'

const changePassword = changePasswordPost as unknown as (...args: unknown[]) => Promise<Response>

async function setupUserWithPassword(label: string, password: string) {
  const tenant = createTestTenant(label)
  users.setPasswordHash(tenant.userId, await hashPassword(password))
  return tenant
}

describe('POST /api/auth/change-password', () => {
  it('rejects the wrong current password without changing anything', async () => {
    const tenant = await setupUserWithPassword('ChangePwWrong', 'CorrectHorse1')

    const res = await changePassword(
      makeRequest('http://localhost:3000/api/auth/change-password', {
        method: 'POST',
        cookie: cookieHeader(tenant.sessionToken),
        json: { currentPassword: 'wrong-password', newPassword: 'NewPassword1' },
      })
    )
    expect(res.status).toBe(400)

    const user = users.get(tenant.userId)!
    expect(await verifyPassword(user.passwordHash, 'CorrectHorse1')).toBe(true)
  })

  it('rejects a new password shorter than the minimum', async () => {
    const tenant = await setupUserWithPassword('ChangePwShort', 'CorrectHorse1')

    const res = await changePassword(
      makeRequest('http://localhost:3000/api/auth/change-password', {
        method: 'POST',
        cookie: cookieHeader(tenant.sessionToken),
        json: { currentPassword: 'CorrectHorse1', newPassword: 'short' },
      })
    )
    expect(res.status).toBe(400)
  })

  it('changes the password and revokes every OTHER session, keeping the current one alive', async () => {
    const tenant = await setupUserWithPassword('ChangePwOk', 'CorrectHorse1')
    // A second, independent session for the same user — simulating another
    // signed-in browser/device.
    const otherSession = createSession(tenant.userId)

    const res = await changePassword(
      makeRequest('http://localhost:3000/api/auth/change-password', {
        method: 'POST',
        cookie: cookieHeader(tenant.sessionToken),
        json: { currentPassword: 'CorrectHorse1', newPassword: 'BrandNewPassword1' },
      })
    )
    expect(res.status).toBe(200)

    const user = users.get(tenant.userId)!
    expect(await verifyPassword(user.passwordHash, 'BrandNewPassword1')).toBe(true)
    expect(await verifyPassword(user.passwordHash, 'CorrectHorse1')).toBe(false)

    // The OTHER session (not the one that made this request) must now be
    // revoked; the request's own session must still be live.
    const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex')
    const otherLookup = sessions.findByTokenHash(hash(otherSession.token))
    expect(otherLookup?.revokedAt).not.toBeNull()

    const thisLookup = sessions.findByTokenHash(hash(tenant.sessionToken))
    expect(thisLookup?.revokedAt).toBeNull()
  })
})
