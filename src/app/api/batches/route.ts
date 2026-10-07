/**
 * Batch listing.
 */

import { batches } from '@/db/repositories'
import * as queue from '@/jobs/queue'
import { currentTenant } from '@/tenancy/context'
import { handler, ok } from '@/lib/api-handler'

export const dynamic = 'force-dynamic'

export const GET = handler(async () => {
  // Refresh counters on read so a batch whose last worker message was lost
  // still settles to its true status.
  const tenantId = currentTenant().tenantId
  const list = batches.list(50).map(batch => batches.refresh(batch.id, queue.batchJobCounts(tenantId, batch.id)) ?? batch)
  return ok({ batches: list })
})
