/**
 * Admin route-handler wrapper — `src/lib/api-handler.ts`'s `handler()` for
 * `/api/admin/*` routes, with a different access rule.
 *
 * Deliberately separate from `handler()` rather than an option flag on it:
 * `handler()` REQUIRES `resolved.tenant` (a tenant-less session is rejected
 * with "this account has no workspace") because every ordinary route reads
 * or writes exactly one tenant's own data. A platform admin can — and
 * often will — have NO personal tenant at all (see `ResolvedSession`'s doc
 * comment), and admin routes mostly operate on CONTROL-PLANE data (tenants,
 * users, quotas, audit_log) that has no "current tenant" to scope into in
 * the first place. An admin action that needs to touch one SPECIFIC
 * tenant's own data (the deletion purge's media directory, for instance)
 * wraps just that part in `runWithTenant({tenantId: <that tenant>, ...})`
 * explicitly, naming the target tenant — never the ambient one, because
 * there isn't one here.
 *
 * Non-admins and anonymous users must not be able to tell `/api/admin/*`
 * exists: anonymous gets the same 401 every other route gives an
 * unauthenticated request; an authenticated NON-admin gets 404, identical
 * to a route that was never there, rather than a 403 that confirms "this
 * exists, you're just not allowed."
 */

import { NextRequest, NextResponse } from 'next/server'
import { config } from '@/config'
import { resolveSession, type ResolvedSession } from '@/auth/session'
import { MUTATING_METHODS, originIsTrusted, mapKnownError, unauthorized, notFound, callAndLogIfSlow } from './api-handler'

export function adminHandler<Args extends unknown[]>(
  fn: (session: ResolvedSession, ...args: Args) => Promise<NextResponse> | NextResponse
) {
  return async (...args: Args): Promise<NextResponse> => {
    try {
      const request = args[0] as NextRequest | undefined

      if (request && MUTATING_METHODS.has(request.method) && !originIsTrusted(request)) {
        return NextResponse.json({ error: 'cross-origin request rejected' }, { status: 403 })
      }

      const token = request?.cookies.get(config.auth.sessionCookieName)?.value
      const resolved = resolveSession(token)
      if (!resolved) return unauthorized()
      if (!resolved.isPlatformAdmin) return notFound()

      return await callAndLogIfSlow(request, undefined, () => fn(resolved, ...args))
    } catch (err) {
      return mapKnownError(err)
    }
  }
}
