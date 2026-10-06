import { NextRequest } from 'next/server'

export interface MakeRequestOptions {
  method?: string
  cookie?: string
  origin?: string
  headers?: Record<string, string>
  json?: unknown
  body?: BodyInit
}

/**
 * Builds a real `NextRequest` the way `src/lib/api-handler.ts`'s `handler()`
 * actually reads one — session via `request.cookies.get(...)`, origin via
 * `request.headers.get('origin')` — so route handlers can be invoked
 * directly in a test process with no running Next server. This only works
 * because `handler()` deliberately reads the session off the `NextRequest`
 * object itself rather than `next/headers`'s `cookies()`, which depends on
 * Next's own request-scoped context and would NOT work outside a real
 * server (see `api-handler.ts`'s module doc).
 */
export function makeRequest(url: string, opts: MakeRequestOptions = {}): NextRequest {
  const headers = new Headers(opts.headers)
  if (opts.cookie) headers.set('cookie', opts.cookie)
  if (opts.origin) headers.set('origin', opts.origin)

  let body = opts.body
  if (opts.json !== undefined) {
    headers.set('content-type', 'application/json')
    body = JSON.stringify(opts.json)
  }

  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method: opts.method ?? 'GET',
    headers,
    body,
  })
}

/** `{ params: Promise<...> }` — the exact shape Next.js passes a dynamic route's second argument. */
export function makeParams<T extends Record<string, string | string[]>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) }
}
