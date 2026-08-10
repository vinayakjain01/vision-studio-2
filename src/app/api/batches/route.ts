/**
 * Batch listing.
 */

import { batches } from '@/db/repositories'
import { handler, ok } from '@/lib/api'

export const dynamic = 'force-dynamic'

export const GET = handler(async () => {
  // Refresh counters on read so a batch whose last worker message was lost
  // still settles to its true status.
  const list = batches.list(50).map(batch => batches.refresh(batch.id) ?? batch)
  return ok({ batches: list })
})
