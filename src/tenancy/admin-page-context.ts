/**
 * Access guard for `/admin/**` Server Component pages — the page-level
 * counterpart to `src/lib/admin-handler.ts`'s `adminHandler()` for API
 * routes. See that file's doc comment for why admin access is a separate
 * check from `withTenant()`'s tenant-membership one, not a variant of it.
 *
 * Server-only.
 */

import { cookies } from 'next/headers'
import { redirect, notFound } from 'next/navigation'
import { config } from '@/config'
import { resolveSession, type ResolvedSession } from '@/auth/session'

export async function withAdmin<T>(fn: (session: ResolvedSession) => Promise<T> | T): Promise<T> {
  const jar = await cookies()
  const token = jar.get(config.auth.sessionCookieName)?.value
  const resolved = resolveSession(token)

  if (!resolved) redirect('/login')
  // A non-admin gets the same 404 a URL that was never real would — never a
  // page that visibly exists but refuses them.
  if (!resolved.isPlatformAdmin) notFound()

  return fn(resolved)
}
