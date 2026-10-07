/**
 * Route-handler helpers.
 *
 * Consistent JSON envelopes, one place where an unhandled throw becomes a
 * 500 with a logged stack rather than an opaque Next.js error page, and —
 * since every one of this app's API routes already funnels through
 * `handler()` — the one place a request's session is resolved into a
 * `TenantContext` before the route body ever runs.
 *
 * Deliberately a SEPARATE module from `src/lib/api.ts`'s browser-side fetch
 * helpers (`fetcher`/`postJson`/...), even though both used to live in one
 * file. Pulling `resolveSession`/`runWithTenant` into that shared file broke
 * every client component that imports `fetcher` from it: webpack tried to
 * bundle this module's transitive server-only dependencies (better-sqlite3,
 * ultimately) for the browser and failed on `require('fs')`. Route handlers
 * (server-only by Next.js's own file convention) import from here; client
 * components keep importing the small, dependency-free fetch helpers from
 * `src/lib/api.ts`.
 */

import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { config } from '@/config'
import { resolveSession } from '@/auth/session'
import { runWithTenant } from '@/tenancy/context'
import { QuotaExceededError } from '@/jobs/quota'
import { AiExtendQuotaExceededError } from '@/jobs/ai-extend-dispatcher'
import { ExportCapacityError } from '@/render/export-concurrency'

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data as any, init)
}

/**
 * Same JSON envelope as `ok()`, but with an `ETag` derived from the response
 * body and `Cache-Control: no-cache` — which, despite the name, means "the
 * browser MAY cache this, but must always revalidate with the server before
 * using it", not "don't cache". That's exactly what status/progress polling
 * wants: standard browser `fetch()` behavior already sends `If-None-Match`
 * on the next request to the same URL once it has a cached, must-revalidate
 * response, and transparently resolves the caller's `fetch()` promise with
 * the cached 200 body when the server answers 304 — no client-side code
 * needs to know this is happening. Used for the handful of GET endpoints
 * SWR polls on an interval (batches, imports, products, engine status),
 * where the common case under steady polling is "nothing changed since last
 * time" and skipping the JSON re-serialization + re-parse + React re-render
 * that a full 200 would trigger is the entire point.
 */
export function okWithEtag<T>(request: NextRequest, data: T): NextResponse {
  const body = JSON.stringify(data)
  const etag = `"${crypto.createHash('sha1').update(body).digest('hex')}"`
  const headers = { etag, 'cache-control': 'private, no-cache' }

  if (request.headers.get('if-none-match') === etag) {
    return new NextResponse(null, { status: 304, headers })
  }
  return new NextResponse(body, {
    status: 200,
    headers: { ...headers, 'content-type': 'application/json' },
  })
}

export function badRequest(message: string, details?: unknown): NextResponse {
  return NextResponse.json({ error: message, details }, { status: 400 })
}

export function notFound(message = 'not found'): NextResponse {
  return NextResponse.json({ error: message }, { status: 404 })
}

export function unauthorized(message = 'authentication required'): NextResponse {
  return NextResponse.json({ error: message }, { status: 401 })
}

export function serverError(message: string, details?: unknown): NextResponse {
  return NextResponse.json({ error: message, details }, { status: 500 })
}

/** Exported for `src/lib/admin-handler.ts`, which needs the same CSRF check for admin routes. */
export const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * A mutating request whose `Origin` header names a different host is
 * rejected. Defense in depth alongside the session cookie's own
 * `SameSite=Lax` (which already blocks cross-site POSTs from a plain link
 * or form in most browsers) — this catches the cases Lax doesn't, like a
 * fetch from another origin that still happens to carry the cookie. A
 * missing Origin header is allowed through: some legitimate same-origin
 * requests and non-browser clients omit it, and the cookie's own
 * protections remain the primary defense either way.
 *
 * Compared against `config.auth.appOrigin` when set, NOT
 * `request.nextUrl.host` — behind a reverse proxy, Next.js's own view of
 * its host is the internal address it's bound to (`127.0.0.1:3000`), never
 * the public domain a real browser's `Origin` header names, so comparing
 * against it there would reject every legitimate same-origin request.
 * `appOrigin` is required in production for exactly this reason; left
 * unset in development, `nextUrl.host` is already correct (no proxy sits
 * in front of `next dev`).
 */
/** Exported for `src/lib/admin-handler.ts` — same CSRF defense, same reasoning. */
export function originIsTrusted(request: NextRequest): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return true

  const trustedHost = config.auth.appOrigin
    ? safeHost(config.auth.appOrigin)
    : request.nextUrl.host

  return safeHost(origin) === trustedHost
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

/**
 * Wrap a route handler so any throw becomes a logged 500, AND — unless
 * `{ public: true }` — so the request has a valid session and tenant before
 * the handler body runs at all.
 *
 * `args[0]` is read as the `NextRequest` Next.js actually invokes this
 * wrapper with, independent of whether the wrapped `fn` itself declares a
 * request parameter — several existing routes ignore it entirely (e.g.
 * `GET = handler(async () => ...)`), but Next.js still calls the exported
 * function with the real request every time, so it's always there to read
 * at this layer regardless of what the inner handler chose to accept.
 *
 * Middleware (`middleware.ts`) already rejects requests with no valid
 * session before they get here — this is the SECOND, authoritative check,
 * not redundant-for-no-reason: Next.js does not guarantee middleware and
 * the route handler it approved share one continuous async context, so
 * `TenantContext` is established here, fresh, every time (see the module
 * doc on `src/tenancy/context.ts`).
 */
export function handler<Args extends unknown[]>(
  fn: (...args: Args) => Promise<NextResponse> | NextResponse,
  options?: { public?: boolean }
) {
  return async (...args: Args): Promise<NextResponse> => {
    try {
      const request = args[0] as NextRequest | undefined

      if (request && MUTATING_METHODS.has(request.method) && !originIsTrusted(request)) {
        return NextResponse.json({ error: 'cross-origin request rejected' }, { status: 403 })
      }

      if (options?.public) {
        return await fn(...args)
      }

      const token = request?.cookies.get(config.auth.sessionCookieName)?.value
      const resolved = resolveSession(token)
      if (!resolved) return unauthorized()
      if (!resolved.tenant) return unauthorized('this account has no workspace')

      return await runWithTenant(resolved.tenant, () => fn(...args))
    } catch (err) {
      return mapKnownError(err)
    }
  }
}

/**
 * The known-error-to-response mapping shared by `handler()` and
 * `src/lib/admin-handler.ts`'s `adminHandler()` — extracted so admin routes
 * get the same structured 429/503 handling (e.g. an admin action that hits
 * a tenant's own quota check) without duplicating the mapping.
 */
export function mapKnownError(err: unknown): NextResponse {
  // Structured quota errors (code + limit + current usage) get their own
  // response shape — a stable `code` lets the UI render "12/20 uploads"
  // (P4) instead of pattern-matching the message string, and 429 is the
  // honest status: the request is valid, the caller is just over a
  // limit right now.
  if (err instanceof QuotaExceededError) {
    // Every quota code is 429, but only `max_concurrent_uploads` is
    // genuinely transient (a slot frees up as soon as another upload
    // finishes) — the others (queued jobs, images-per-batch, storage)
    // need a human to raise the limit or for usage to drop, so a
    // Retry-After on those would be a lie about when retrying could
    // possibly succeed.
    const headers = err.code === 'max_concurrent_uploads' ? { 'retry-after': '3' } : undefined
    return NextResponse.json(
      { error: err.message, code: err.code, limit: err.limit, current: err.current },
      { status: 429, headers }
    )
  }
  if (err instanceof AiExtendQuotaExceededError) {
    return NextResponse.json(
      { error: err.message, code: 'ai_extend_quota', limit: err.limit, current: err.current },
      { status: 429 }
    )
  }
  if (err instanceof ExportCapacityError) {
    // 503 (not 429): this isn't the CALLER being over a limit, it's the
    // server genuinely saturated right now — a real Retry-After, in
    // seconds, since this one actually reflects how long this attempt
    // itself was willing to wait before giving up.
    return NextResponse.json(
      { error: err.message, code: 'export_capacity' },
      { status: 503, headers: { 'retry-after': String(err.retryAfterSeconds) } }
    )
  }

  const message = err instanceof Error ? err.message : String(err)
  console.error('[api]', err)
  return serverError(message)
}
