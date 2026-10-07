/**
 * Admin-initiated password reset for one user. Platform-admin only.
 */

import { NextRequest } from 'next/server'
import { adminHandler } from '@/lib/admin-handler'
import { ok, badRequest } from '@/lib/api-handler'
import { resetUserPassword, AdminActionError } from '@/services/admin-service'

export const dynamic = 'force-dynamic'

export const POST = adminHandler(
  async (session, _request: NextRequest, context: { params: Promise<{ userId: string }> }) => {
    const { userId } = await context.params
    try {
      // The temp password is returned ONCE, here — never logged.
      const result = await resetUserPassword(userId, { userId: session.userId })
      return ok(result)
    } catch (err) {
      if (err instanceof AdminActionError) return badRequest(err.message)
      throw err
    }
  }
)
