/**
 * Log out: revoke the session server-side, clear the cookie.
 *
 * Public — logging out must work even if session resolution would
 * otherwise fail (an already-expired or already-revoked session should
 * still successfully clear the client's cookie, not 401).
 */

import { NextRequest, NextResponse } from 'next/server'
import { config } from '@/config'
import { revokeSessionByToken } from '@/auth/session'
import { handler } from '@/lib/api-handler'

export const dynamic = 'force-dynamic'

export const POST = handler(
  async (request: NextRequest) => {
    const token = request.cookies.get(config.auth.sessionCookieName)?.value
    revokeSessionByToken(token)

    const response = NextResponse.json({ ok: true })
    response.cookies.set(config.auth.sessionCookieName, '', { path: '/', maxAge: 0 })
    return response
  },
  { public: true }
)
