/**
 * Route-handler helpers.
 *
 * Consistent JSON envelopes and one place where an unhandled throw becomes a
 * 500 with a logged stack rather than an opaque Next.js error page.
 */

import { NextResponse } from 'next/server'

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data as any, init)
}

export function badRequest(message: string, details?: unknown): NextResponse {
  return NextResponse.json({ error: message, details }, { status: 400 })
}

export function notFound(message = 'not found'): NextResponse {
  return NextResponse.json({ error: message }, { status: 404 })
}

export function serverError(message: string, details?: unknown): NextResponse {
  return NextResponse.json({ error: message, details }, { status: 500 })
}

/**
 * Wrap a handler so any throw becomes a logged 500.
 *
 * Without this a failure inside a route surfaces as an empty response and the
 * cause only appears in the server console — during a bulk import that is the
 * difference between "the upload stalled" and a message naming the file.
 */
export function handler<Args extends unknown[]>(
  fn: (...args: Args) => Promise<NextResponse> | NextResponse
) {
  return async (...args: Args): Promise<NextResponse> => {
    try {
      return await fn(...args)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[api]', err)
      return serverError(message)
    }
  }
}

/** Browser-side fetcher for SWR. Throws on non-2xx so SWR surfaces the error. */
export async function fetcher<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) {
    let message = `request failed with ${response.status}`
    try {
      const body = await response.json()
      if (body?.error) message = body.error
    } catch {
      // Non-JSON error body; keep the status message.
    }
    throw new Error(message)
  }
  return response.json() as Promise<T>
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    let message = `request failed with ${response.status}`
    try {
      const parsed = await response.json()
      if (parsed?.error) message = parsed.error
    } catch {
      // Keep the status message.
    }
    throw new Error(message)
  }
  return response.json() as Promise<T>
}

export async function patchJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`request failed with ${response.status}`)
  return response.json() as Promise<T>
}

export async function del(url: string): Promise<void> {
  const response = await fetch(url, { method: 'DELETE' })
  if (!response.ok) throw new Error(`request failed with ${response.status}`)
}
