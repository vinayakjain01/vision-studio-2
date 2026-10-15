/**
 * Operator diagnostics (Phase 1.2, docs/ISSUES.md): jobs by status/kind/age,
 * the oldest claimed-or-running job, deferral-loop candidates, per-worker
 * RSS, queue depth, event-loop p99, process memory vs the container limit.
 * Platform-admin only. Consumed by `npm run diag` (scripts/diag.ts), not
 * polled by any UI — no etag/caching, this is an on-demand snapshot.
 */

import { adminHandler } from '@/lib/admin-handler'
import { ok } from '@/lib/api-handler'
import { getDiagnostics } from '@/services/admin-service'

export const dynamic = 'force-dynamic'

export const GET = adminHandler(async () => {
  return ok(await getDiagnostics())
})
