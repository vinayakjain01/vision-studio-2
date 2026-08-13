/**
 * Is AI Extend usable right now?
 *
 * Exists so the Template Builder can say so BEFORE a batch is generated.
 * Without it, choosing "AI Extend" with no credentials set looks fine in the
 * builder and only surfaces later as a pile of parked `background_fill`
 * jobs — the failure is correct (nothing silently degrades to a plain fill)
 * but it arrives long after the decision that caused it.
 *
 * Deliberately reports only whether credentials are PRESENT, never their
 * values, and does not call Cloudinary — a reachability probe on every
 * builder page load would be a request per visit against a billed account
 * for no added certainty.
 */

import { config } from '@/config'
import { handler, ok } from '@/lib/api'

export const dynamic = 'force-dynamic'

export const GET = handler(async () => {
  return ok({
    configured: config.cloudinary.enabled,
    /** Safe to expose — it is the public delivery hostname component. */
    cloudName: config.cloudinary.cloudName || null,
  })
})
