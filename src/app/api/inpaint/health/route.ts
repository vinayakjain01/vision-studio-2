/**
 * Is the AI Extend inpaint service actually reachable right now?
 *
 * Exists so the Template Builder can say so BEFORE a batch is generated.
 * Without it, choosing "AI Extend" against a service that isn't running looks
 * fine in the builder and only surfaces later as a pile of failed
 * `background_fill` jobs — the failure is correct (nothing silently degrades
 * to a plain fill) but it arrives long after the decision that caused it.
 *
 * Never throws: `checkHealth` resolves `{ reachable: false }` for every
 * failure mode, so this endpoint answers even when nothing is listening.
 */

import { checkHealth } from '@/services/inpaint-client'
import { config } from '@/config'
import { handler, ok } from '@/lib/api'

export const dynamic = 'force-dynamic'

export const GET = handler(async () => {
  const health = await checkHealth()
  return ok({
    ...health,
    /** Echoed so the UI can name the address it failed to reach. */
    serviceUrl: config.inpaint.serviceUrl,
    /** What THIS app is configured for, whatever the service reports. */
    configuredDevice: config.inpaint.device,
  })
})
