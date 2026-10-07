/**
 * Concurrency cap on export CONVERSIONS (`convertForExport` — sharp decode +
 * re-encode), shared by the single-creative export route and the bulk ZIP
 * route's per-file loop. Both run in the WEB process (never a worker), so a
 * plain in-process counter is correct here — unlike the AI Extend
 * dispatcher's SQLite-backed concurrency, which has to coordinate across
 * several separate background_fill WORKER PROCESSES.
 *
 * Two independent caps: GLOBAL (the whole process doing too many conversions
 * at once starves the event loop and every other request) and PER-TENANT (one
 * tenant's bulk export should not consume the server's entire export budget
 * and starve every other tenant's). A ZIP's own internal loop additionally
 * bounds itself to a small number of concurrent conversions (see the
 * download route) — that's a THIRD, per-request limit layered on top of
 * these two, not a replacement for them.
 */

import { config } from '@/config'

interface Waiter {
  resolve: () => void
}

class ConcurrencyLimiter {
  private inFlight = 0
  private readonly waiters: Waiter[] = []

  constructor(private readonly limit: number) {}

  get current(): number {
    return this.inFlight
  }

  private tryAcquireSync(): boolean {
    if (this.inFlight >= this.limit) return false
    this.inFlight++
    return true
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1)
    const next = this.waiters.shift()
    if (next) {
      this.inFlight++
      next.resolve()
    }
  }

  /** Resolves true once a slot is acquired, or false if `timeoutMs` elapses first — never queues forever. */
  async acquire(timeoutMs: number): Promise<boolean> {
    if (this.tryAcquireSync()) return true

    return new Promise<boolean>(resolve => {
      const waiter: Waiter = { resolve: () => resolve(true) }
      this.waiters.push(waiter)

      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter)
        if (index !== -1) {
          this.waiters.splice(index, 1)
          resolve(false)
        }
        // If not found, it was already resolved by release() concurrently —
        // that resolution wins, this timeout is a no-op.
      }, timeoutMs)
      // Don't hold the process open waiting on an export slot.
      timer.unref?.()
    })
  }
}

declare global {
  // Next.js dev hot-reloads modules; without a global, each reload would
  // create a fresh limiter with inFlight reset to 0 while real conversions
  // from the previous module instance are still running, undercounting.
  var __visionStudioExportGlobalLimiter: ConcurrencyLimiter | undefined
  var __visionStudioExportTenantLimiters: Map<string, ConcurrencyLimiter> | undefined
}

function globalLimiter(): ConcurrencyLimiter {
  if (!global.__visionStudioExportGlobalLimiter) {
    global.__visionStudioExportGlobalLimiter = new ConcurrencyLimiter(config.render.exportGlobalConcurrency)
  }
  return global.__visionStudioExportGlobalLimiter
}

function tenantLimiter(tenantId: string): ConcurrencyLimiter {
  if (!global.__visionStudioExportTenantLimiters) {
    global.__visionStudioExportTenantLimiters = new Map()
  }
  const map = global.__visionStudioExportTenantLimiters
  let limiter = map.get(tenantId)
  if (!limiter) {
    limiter = new ConcurrencyLimiter(config.render.exportPerTenantConcurrency)
    map.set(tenantId, limiter)
  }
  return limiter
}

/** Test-only introspection — lets a test confirm every acquired slot was released (e.g. after a client disconnect) without reaching into module-private state. */
export function __exportConcurrencySnapshot(tenantId: string): { global: number; tenant: number } {
  return { global: globalLimiter().current, tenant: tenantLimiter(tenantId).current }
}

export class ExportCapacityError extends Error {
  constructor(
    message: string,
    /** Seconds a client should wait before retrying — a plain, honest guess (the wait budget this call itself used), not a promise. */
    readonly retryAfterSeconds: number
  ) {
    super(message)
    this.name = 'ExportCapacityError'
  }
}

/**
 * Runs `fn` while holding both a global and a per-tenant export-conversion
 * slot, waiting briefly for one if the caps are currently saturated. Throws
 * `ExportCapacityError` (maps to 429/503 with Retry-After at the route
 * level) rather than queueing indefinitely — an export is something a
 * client can retry shortly, not something worth holding a request open for
 * an unbounded wait.
 */
export async function withExportSlot<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  const waitMs = config.render.exportSlotWaitMs
  const global_ = globalLimiter()
  const tenant = tenantLimiter(tenantId)

  const gotGlobal = await global_.acquire(waitMs)
  if (!gotGlobal) {
    throw new ExportCapacityError(
      'The server is converting the maximum number of exports right now — try again shortly.',
      Math.ceil(waitMs / 1000)
    )
  }

  const gotTenant = await tenant.acquire(waitMs)
  if (!gotTenant) {
    global_.release()
    throw new ExportCapacityError(
      'This workspace is already converting the maximum number of exports — try again shortly.',
      Math.ceil(waitMs / 1000)
    )
  }

  try {
    return await fn()
  } finally {
    tenant.release()
    global_.release()
  }
}
