/**
 * Route protection.
 *
 * Fast, first-line reject for a missing or invalid session — redirects page
 * requests to /login, returns 401 JSON for API requests. This is NOT where
 * `TenantContext` gets established (see the doc comment on
 * `src/tenancy/context.ts` for why: Next.js doesn't guarantee middleware
 * and the route/page it approves share one continuous async context). That
 * happens again, authoritatively, in `src/lib/api.ts`'s `handler()` for API
 * routes and in `src/tenancy/page-context.ts` for Server Component pages.
 * Redundant on purpose — a missing session is rejected twice rather than
 * assumed-safe once.
 *
 * Runs on the Node.js runtime, not Edge — `resolveSession` reads
 * `control.db` through `better-sqlite3`, a native addon Edge can't load.
 */

import { NextRequest, NextResponse } from 'next/server'
// Aliased: Next.js requires this file's OWN matcher export to be named
// `config`, which would otherwise collide with the app's config module.
import { config as appConfig } from '@/config'
import { resolveSession } from '@/auth/session'

export const runtime = 'nodejs'

/**
 * No session required at all. Everything else needs one.
 *
 * `/api/auth/logout` belongs here even though a logged-in user is the only
 * one who'd normally call it: its own handler (`{ public: true }`,
 * `src/app/api/auth/logout/route.ts`) is deliberately permissive — an
 * already-expired or already-revoked session must still successfully clear
 * the browser's cookie, not bounce off a 401 before it ever gets there.
 * Leaving it off this list would make middleware reject exactly the request
 * that handler exists to always accept.
 */
const PUBLIC_PATHS = ['/login', '/api/auth/login', '/api/auth/logout', '/api/health']

function isPublic(pathname: string): boolean {
  return (
    PUBLIC_PATHS.includes(pathname) ||
    pathname.startsWith('/_next/') ||
    pathname === '/favicon.ico' ||
    pathname === '/icon.svg'
  )
}

function isAdminPath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/') || pathname.startsWith('/api/admin/')
}

/**
 * Reachable even while `mustChangePassword` is set (P5: admin-created
 * accounts and admin-reset passwords force this) — enough to actually
 * change the password and nothing else. `/settings` because that's where
 * the Account panel's change-password form lives (see
 * src/components/settings/account-panel.tsx); a dedicated page was not
 * worth adding just for this one gate.
 */
const ALLOWED_WHILE_MUST_CHANGE_PASSWORD = ['/settings', '/api/auth/change-password', '/api/auth/logout']

function isAllowedWhileMustChangePassword(pathname: string): boolean {
  return ALLOWED_WHILE_MUST_CHANGE_PASSWORD.some(p => pathname === p || pathname.startsWith(`${p}/`))
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl
  if (isPublic(pathname)) return NextResponse.next()

  const token = request.cookies.get(appConfig.auth.sessionCookieName)?.value
  const resolved = resolveSession(token)

  if (!resolved) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'authentication required' }, { status: 401 })
    }
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('next', pathname)
    return NextResponse.redirect(loginUrl)
  }

  // Defense in depth, same reasoning as the plain-session check above: the
  // route handler (`adminHandler()`) and page (`withAdmin()`) each check
  // `isPlatformAdmin` again themselves — this is the fast, first-line
  // reject for the API case, not the only one. For a PAGE request this
  // intentionally does NOT short-circuit here: App Router has no
  // middleware-level equivalent of rendering the not-found boundary (that's
  // a page-rendering primitive, `next/navigation`'s `notFound()`), so the
  // request falls through to `withAdmin()`, which calls it — the end
  // result is the same real 404 page either way, never a 403 that confirms
  // the area exists.
  if (isAdminPath(pathname) && !resolved.isPlatformAdmin && pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  // P5: a temp password (admin-created account, admin password reset) must
  // be changed before anything else — confine the session to exactly the
  // page/routes that let them do that, rather than trusting the login
  // response's `mustChangePassword` flag to be acted on client-side alone.
  if (resolved.mustChangePassword && !isAllowedWhileMustChangePassword(pathname)) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'password change required', code: 'must_change_password' }, { status: 403 })
    }
    return NextResponse.redirect(new URL('/settings', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and Next's own internals — those are
     * also excluded explicitly in `isPublic()` above as defense in depth,
     * since a matcher mistake here would be a silent "all pages
     * unprotected" failure rather than a loud one.
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
}
