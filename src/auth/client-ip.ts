/**
 * The client IP to key rate limiting on.
 *
 * `X-Forwarded-For` is attacker-controlled input unless something in front
 * of this app is trusted to have set (not merely appended to) it. With
 * `TRUST_PROXY` off — the default — it's ignored outright: a request could
 * claim to be any IP it likes, and trusting that would let an attacker pick
 * their own rate-limit bucket (or someone else's, to get them blocked) for
 * free. Every request then shares one "unknown" bucket instead, which is
 * coarse but cannot be gamed.
 *
 * With `TRUST_PROXY` on, the LAST entry in `X-Forwarded-For` is used — not
 * the first. A proxy that appends (rather than overwrites) the header
 * leaves every earlier entry exactly as attacker-controlled as the header
 * was with no proxy at all; only the entry the proxy itself added, which is
 * always the last hop before reaching us, can be trusted. This assumes
 * exactly one trusted proxy in front of the app (Caddy, per docs/DEPLOY.md)
 * — a chain of multiple proxies would need the Nth-from-the-end entry, not
 * implemented here because this deployment doesn't have one.
 *
 * Server-only.
 */

import { NextRequest } from 'next/server'
import { config } from '@/config'

export function clientIp(request: NextRequest): string {
  if (!config.auth.trustProxy) return 'unknown'

  const header = request.headers.get('x-forwarded-for')
  if (!header) return 'unknown'

  const hops = header.split(',').map(h => h.trim()).filter(Boolean)
  return hops.length > 0 ? hops[hops.length - 1] : 'unknown'
}
