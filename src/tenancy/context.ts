/**
 * Tenant context — the one place "which tenant is this?" is answered for
 * everything downstream: `db/client.ts`'s `getDb()`, `storage/media-store.ts`'s
 * root resolution, and anything else that touches tenant data.
 *
 * Set once per request (see `src/lib/api.ts` for API routes, `withTenant` in
 * `src/tenancy/page-context.ts` for Server Component pages) and read via
 * `currentTenant()` everywhere data access happens. There is no fallback
 * tenant and no default: `currentTenant()` throws if nothing set it, on
 * purpose — a bug that forgets to establish context must fail loudly and
 * immediately, not silently serve tenant A's request against tenant B's
 * data (or no data, or a crash three calls later with a confusing error).
 *
 * AsyncLocalStorage propagates through any chain of nested async calls
 * within ONE JS execution — which covers an API route handler's entire body
 * (including every repository and media-store call it makes) and a Server
 * Component page's entire render once that page's own top-level function is
 * the one that calls `runWithTenant`. It does NOT cross a process boundary:
 * worker child processes (see `src/jobs/worker-entry.ts`) bind their own
 * context per job from the job's own `tenantId` field, independently.
 *
 * Deliberately does NOT cross middleware → page/route boundary either, even
 * though both run in the same Node process: Next.js does not guarantee
 * middleware and the request it approved share one continuous async context,
 * so middleware's job is purely a fast reject for missing/invalid sessions
 * (see `middleware.ts`) — never the place tenant context is established. The
 * authoritative resolution happens again, cheaply, inside the route/page
 * itself. Redundant, and correct because of it.
 *
 * Server-only.
 */

import { AsyncLocalStorage } from 'async_hooks'

export interface TenantContext {
  tenantId: string
  userId: string
  role: 'owner' | 'member'
}

const storage = new AsyncLocalStorage<TenantContext>()

export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  return storage.run(ctx, fn)
}

/** Throws if no tenant context is set. Fail closed — see the module doc. */
export function currentTenant(): TenantContext {
  const ctx = storage.getStore()
  if (!ctx) {
    throw new Error(
      'currentTenant() called with no tenant context set — a request path is missing its ' +
        'runWithTenant()/withTenant() wrapper. Refusing to guess which tenant this is.'
    )
  }
  return ctx
}

/** Like `currentTenant()`, but returns null instead of throwing — for the rare caller (health checks, the login page itself) that legitimately runs both inside and outside a tenant context. */
export function tryCurrentTenant(): TenantContext | null {
  return storage.getStore() ?? null
}
