/**
 * Liveness check. Status only — no counts, no tenant data, nothing an
 * unauthenticated prober shouldn't see. Public on purpose: a load balancer
 * or uptime monitor has no session.
 */

import { handler, ok } from '@/lib/api-handler'

export const dynamic = 'force-dynamic'

export const GET = handler(async () => ok({ status: 'ok' }), { public: true })
