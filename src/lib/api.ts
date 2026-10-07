/**
 * Browser-side fetch helpers for SWR and client components.
 *
 * Deliberately dependency-free beyond the global `fetch` — safe to import
 * from any client component. Route-handler-side helpers (`handler`, `ok`,
 * `badRequest`, ...) live in `src/lib/api-handler.ts` instead, a separate
 * module specifically so this one never pulls in server-only code
 * (ultimately better-sqlite3, through the auth/tenancy chain `handler()`
 * needs) that webpack can't bundle for the browser. See that file's doc
 * comment for the exact breakage this split fixes.
 */

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

export async function del(url: string, body?: unknown): Promise<void> {
  const response = await fetch(url, {
    method: 'DELETE',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
}
