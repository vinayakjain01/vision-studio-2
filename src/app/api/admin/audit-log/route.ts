/**
 * Audit log viewer: filter by actor, action, tenant, date range.
 * Platform-admin only.
 */

import { NextRequest } from 'next/server'
import { adminHandler } from '@/lib/admin-handler'
import { okWithEtag } from '@/lib/api-handler'
import { listAuditLog } from '@/services/admin-service'

export const dynamic = 'force-dynamic'

export const GET = adminHandler(async (_session, request: NextRequest) => {
  const params = request.nextUrl.searchParams
  const entries = listAuditLog({
    actorUserId: params.get('actorUserId') ?? undefined,
    action: params.get('action') ?? undefined,
    tenantId: params.get('tenantId') ?? undefined,
    fromDate: params.get('fromDate') ?? undefined,
    toDate: params.get('toDate') ?? undefined,
    limit: params.get('limit') ? Number(params.get('limit')) : undefined,
    offset: params.get('offset') ? Number(params.get('offset')) : undefined,
  })
  return okWithEtag(request, { entries })
})
