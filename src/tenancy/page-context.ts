/**
 * TenantContext for Server Component pages.
 *
 * API routes get this from `src/lib/api-handler.ts`'s `handler()`. Pages
 * that read data directly (via `@/db/repositories`, server-side, during
 * render — several of this app's pages do, e.g.
 * `src/app/(app)/products/[productId]/page.tsx`) need the equivalent:
 * resolve the session, establish `TenantContext`, THEN run the page's own
 * body as a nested call within that context so every repository call it
 * makes resolves to the right tenant.
 *
 * `withTenant` redirects to /login on an invalid/missing session rather than
 * throwing — middleware should already have caught this, but a page is
 * reachable by more than one path (prefetching, a stale client-side
 * navigation cache) and must not depend on middleware alone having run.
 *
 * ── The one way to get this wrong ────────────────────────────────────────
 * `fn` must actually RUN your data-fetching code, not just describe it.
 * `withTenant(() => someRepo.get(id))` is correct — the call happens inside
 * this function's synchronous frame, while the tenant context is live.
 * `withTenant(() => <SomeServerComponent />)` is NOT: that only constructs a
 * React element (a plain data object describing what to render); React
 * doesn't actually invoke `SomeServerComponent`'s body until its own later
 * render pass, by which point `runWithTenant`'s callback has already
 * returned and the context has unwound — any repository call inside that
 * component throws "no tenant context set" despite being wrapped in
 * `withTenant` syntactically. If a page's data-fetching logic lives in a
 * separate function for readability, call that function directly
 * (`OtherFn()`, not `<OtherFn />`) inside `fn` and return ITS result — see
 * `src/app/(app)/page.tsx`, which hit exactly this bug once.
 *
 * Server-only.
 */

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { config } from '@/config'
import { resolveSession } from '@/auth/session'
import { runWithTenant } from './context'

export async function withTenant<T>(fn: () => Promise<T> | T): Promise<T> {
  const jar = await cookies()
  const token = jar.get(config.auth.sessionCookieName)?.value
  const resolved = resolveSession(token)

  if (!resolved || !resolved.tenant) {
    redirect('/login')
  }

  return runWithTenant(resolved.tenant, fn)
}
