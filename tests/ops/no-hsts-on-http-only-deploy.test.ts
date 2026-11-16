import { describe, it, expect } from 'vitest'
import nextConfig from '../../next.config'

/**
 * Reported 2026-11-16: every user got silently logged out and could not log
 * back in. Root cause — `Strict-Transport-Security` was being sent on every
 * response, with a comment reasoning "harmless... since browsers ignore
 * Strict-Transport-Security on an insecure origin." That is only true for
 * the browser that is CURRENTLY on an insecure connection. If a browser ever
 * received this header over a genuinely secure connection even once (this
 * box's nginx config retains leftover `ssl_protocols`/cert directives from
 * an earlier setup attempt — port 443 is closed now, but evidently wasn't
 * always), it caches the policy for a full year (`max-age=31536000`) and
 * HSTS's own anti-downgrade design means it must NOT silently fall back to
 * plain HTTP on a failed HTTPS connection — by design, the whole point of
 * HSTS is refusing exactly that fallback. With nothing listening on 443,
 * every poisoned browser simply can't reach the site at all: no login page,
 * no API calls, indistinguishable from "logged out."
 *
 * This deployment (docs/DEPLOY.md's PM2/bare-metal path) serves plain HTTP
 * only, with no TLS termination anywhere in front of it — there is no
 * configuration under which this header is actually safe to send here, so
 * it must not be sent at all, not merely "should be harmless."
 */
describe('security headers — no HSTS on a deployment that never reliably serves HTTPS', () => {
  it('does not send Strict-Transport-Security on any route', async () => {
    const rules = await nextConfig.headers!()
    for (const rule of rules) {
      const hsts = rule.headers.find(h => h.key.toLowerCase() === 'strict-transport-security')
      expect(hsts, `found HSTS on source "${rule.source}": ${JSON.stringify(hsts)}`).toBeUndefined()
    }
  })
})
