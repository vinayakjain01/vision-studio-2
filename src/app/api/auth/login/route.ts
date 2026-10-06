/**
 * Log in: validate credentials, create a session, set the cookie.
 *
 * Public — there is no session yet when this runs, by definition.
 */

import { NextRequest, NextResponse } from 'next/server'
import { config } from '@/config'
import { attemptLogin } from '@/auth/login'
import { clientIp } from '@/auth/client-ip'
import { auditLog } from '@/db/control-repositories'
import { handler, badRequest } from '@/lib/api-handler'

export const dynamic = 'force-dynamic'

export const POST = handler(
  async (request: NextRequest) => {
    const body = await request.json().catch(() => null)
    const email = typeof body?.email === 'string' ? body.email.trim() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    if (!email || !password) return badRequest('email and password are required')

    const result = await attemptLogin(email, password, clientIp(request))

    if (!result.ok) {
      auditLog.record({ actorUserId: null, tenantId: null, action: 'login_failed', detail: { email, reason: result.reason } })
      // Same generic message regardless of reason — see attemptLogin's doc.
      const status = result.reason === 'rate_limited' ? 429 : 401
      return NextResponse.json({ error: 'Incorrect email or password' }, { status })
    }

    const response = NextResponse.json({ ok: true, mustChangePassword: result.mustChangePassword })
    response.cookies.set(config.auth.sessionCookieName, result.token, {
      httpOnly: true,
      secure: config.auth.cookieSecure,
      sameSite: 'lax',
      path: '/',
      expires: new Date(result.expiresAt),
    })
    return response
  },
  { public: true }
)
