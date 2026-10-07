/**
 * Global operational panel: worker busy/idle, total queue depth, event-loop
 * p99, AI Extend global usage, free disk, control.db size. Platform-admin
 * only. Counts, sizes and timings only — see admin-service.ts's privacy
 * boundary note.
 */

import { NextRequest } from 'next/server'
import { adminHandler } from '@/lib/admin-handler'
import { okWithEtag } from '@/lib/api-handler'
import { getGlobalPanelStats } from '@/services/admin-service'

export const dynamic = 'force-dynamic'

export const GET = adminHandler(async (_session, request: NextRequest) => {
  return okWithEtag(request, await getGlobalPanelStats())
})
