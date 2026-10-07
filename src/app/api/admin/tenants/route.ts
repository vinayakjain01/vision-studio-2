/**
 * Admin tenants list + create. Platform-admin only — see src/lib/admin-handler.ts.
 */

import { NextRequest } from 'next/server'
import { adminHandler } from '@/lib/admin-handler'
import { ok, okWithEtag, badRequest } from '@/lib/api-handler'
import { listTenantsWithMetrics, createTenantAndFirstUser, AdminActionError } from '@/services/admin-service'

export const dynamic = 'force-dynamic'

export const GET = adminHandler(async (_session, request: NextRequest) => {
  return okWithEtag(request, { tenants: listTenantsWithMetrics() })
})

export const POST = adminHandler(async (session, request: NextRequest) => {
  const body = await request.json().catch(() => null)
  const tenantName = typeof body?.tenantName === 'string' ? body.tenantName.trim() : ''
  const email = typeof body?.email === 'string' ? body.email.trim() : ''
  if (!tenantName || !email) return badRequest('tenantName and email are required')

  try {
    const result = await createTenantAndFirstUser(
      { tenantName, email, quotas: body?.quotas },
      { userId: session.userId }
    )
    // The temp password is returned ONCE, here, in this response body only —
    // never logged (see generateTempPassword's doc comment) and never
    // retrievable again after this call.
    return ok(result)
  } catch (err) {
    if (err instanceof AdminActionError) return badRequest(err.message)
    throw err
  }
})
