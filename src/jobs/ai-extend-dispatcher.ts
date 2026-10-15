/**
 * AI Extend dispatcher — the one place every `background_fill` job's actual
 * Cloudinary call goes through.
 *
 * Sits between `handleBackgroundFillJob` (src/jobs/worker.ts) and the
 * provider (`cloudinaryProvider` in src/services/cloudinary-service.ts,
 * behind the `GenerativeFillProvider` interface so a future provider swap —
 * or a test double — never touches this file's logic). Four concerns live
 * here, all because Cloudinary credentials are ONE shared, global account
 * (docs/MULTI_TENANCY.md §3.4) called from several separate
 * `background_fill` WORKER PROCESSES at once:
 *
 *  1. Quota — checked BEFORE spending any concurrency slot or making any
 *     call, both the tenant's own monthly cap and the whole account's
 *     circuit breaker (AI_EXTEND_GLOBAL_MONTHLY_CAP). Usage is only ever
 *     incremented AFTER a successful generation — a failed or retried
 *     attempt that never actually produced an image does not count against
 *     either.
 *  2. Concurrency — a global slot count and a per-tenant slot count, both
 *     SQLite-backed (control-schema.sql's `ai_extend_global_state`/
 *     `ai_extend_tenant_state`) rather than an in-process JS semaphore: each
 *     `background_fill` job runs in its OWN OS process (see pool.ts), so
 *     in-memory state in one process cannot coordinate with the others —
 *     only something every process can see, like a SQLite row, actually
 *     enforces a GLOBAL limit here.
 *  3. Rate limiting — a token bucket, same SQLite-backed reasoning.
 *  4. Retry policy — bounded (`AI_EXTEND_MAX_ATTEMPTS`, default 3, since
 *     every attempt can spend a paid credit), exponential backoff with
 *     jitter, honoring a `Retry-After` header when Cloudinary sent one.
 *     Retries only on `rate_limited`/`server_error`/`timeout`/`unreachable`
 *     — a deterministic 4xx (`auth`, `credits`, `rejected`) is never retried,
 *     since trying again cannot change the answer and only burns the
 *     attempt budget faster.
 *
 * Server-only.
 */

import { getControlDb, nowIso, transactionOn } from '@/db/client'
import { quotas, usageCounters, currentPeriod } from '@/db/control-repositories'
import { config } from '@/config'
import { logStageTiming } from '@/lib/stage-timer'
import {
  CloudinaryServiceError,
  cloudinaryProvider,
  type GenerativeFillProvider,
  type GenerativeFillRequest,
  type GenerativeFillResult,
} from '@/services/cloudinary-service'

export class AiExtendQuotaExceededError extends Error {
  constructor(
    message: string,
    readonly limit: number,
    readonly current: number
  ) {
    super(message)
    this.name = 'AiExtendQuotaExceededError'
  }
}

/** Capacity (concurrency or rate limit) was not available within a reasonable wait. Retryable — a property of the moment, not the request. */
export class AiExtendBusyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AiExtendBusyError'
  }
}

const RETRYABLE_KINDS: ReadonlySet<string> = new Set(['rate_limited', 'server_error', 'timeout', 'unreachable'])

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ─── Concurrency (global + per-tenant), SQLite-backed ───────────────────────

function tryAcquireSlots(tenantId: string): boolean {
  return transactionOn(getControlDb(), db => {
    const global = db.prepare('SELECT in_flight FROM ai_extend_global_state WHERE id = 1').get() as
      | { in_flight: number }
      | undefined
    const tenant = db
      .prepare('SELECT in_flight FROM ai_extend_tenant_state WHERE tenant_id = ?')
      .get(tenantId) as { in_flight: number } | undefined

    if ((global?.in_flight ?? 0) >= config.aiExtendDispatcher.globalConcurrency) return false
    if ((tenant?.in_flight ?? 0) >= config.aiExtendDispatcher.perTenantConcurrency) return false

    db.prepare(
      `INSERT INTO ai_extend_global_state (id, in_flight, tokens, last_refill_at) VALUES (1, 1, 0, ?)
       ON CONFLICT (id) DO UPDATE SET in_flight = in_flight + 1`
    ).run(nowIso())
    db.prepare(
      `INSERT INTO ai_extend_tenant_state (tenant_id, in_flight) VALUES (?, 1)
       ON CONFLICT (tenant_id) DO UPDATE SET in_flight = in_flight + 1`
    ).run(tenantId)
    return true
  })
}

function releaseSlots(tenantId: string): void {
  transactionOn(getControlDb(), db => {
    db.prepare('UPDATE ai_extend_global_state SET in_flight = MAX(0, in_flight - 1) WHERE id = 1').run()
    db.prepare('UPDATE ai_extend_tenant_state SET in_flight = MAX(0, in_flight - 1) WHERE tenant_id = ?').run(
      tenantId
    )
  })
}

// ─── Token bucket (global), SQLite-backed ───────────────────────────────────

function tryConsumeToken(): boolean {
  return transactionOn(getControlDb(), db => {
    const row = db.prepare('SELECT tokens, last_refill_at FROM ai_extend_global_state WHERE id = 1').get() as
      | { tokens: number; last_refill_at: string }
      | undefined

    const now = Date.now()
    const last = row ? new Date(row.last_refill_at).getTime() : now
    const elapsedSeconds = Math.max(0, (now - last) / 1000)
    const before = row?.tokens ?? config.aiExtendDispatcher.rateLimitBurst
    const refilled = Math.min(
      config.aiExtendDispatcher.rateLimitBurst,
      before + elapsedSeconds * config.aiExtendDispatcher.rateLimitPerSecond
    )

    const granted = refilled >= 1
    const remaining = granted ? refilled - 1 : refilled

    db.prepare(
      `INSERT INTO ai_extend_global_state (id, in_flight, tokens, last_refill_at) VALUES (1, 0, ?, ?)
       ON CONFLICT (id) DO UPDATE SET tokens = excluded.tokens, last_refill_at = excluded.last_refill_at`
    ).run(remaining, nowIso())

    return granted
  })
}

/** Waits (polling the shared bucket) until a token is available or `timeoutMs` elapses. */
async function awaitToken(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (tryConsumeToken()) return true
    if (Date.now() >= deadline) return false
    await sleep(100)
  }
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

export interface DispatchOptions {
  tenantId: string
  /** Defaults to the real Cloudinary provider — overridden in tests with a mock satisfying `GenerativeFillProvider`. */
  provider?: GenerativeFillProvider
  /** For the per-stage timing log (docs/ISSUES.md Phase 1.2) — optional so existing test call sites with no job in scope keep working unchanged. */
  jobId?: string
}

/**
 * Quota-check, acquire capacity, call the provider with its own bounded
 * retry loop, meter usage on success, release capacity. Throws
 * `AiExtendQuotaExceededError` (not retryable — a human must raise the quota
 * or wait for the next period), `AiExtendBusyError` (retryable — capacity
 * freed up shortly), or the provider's own `CloudinaryServiceError` once
 * retries are exhausted.
 */
export async function dispatchGenerativeFill(
  options: DispatchOptions,
  request: GenerativeFillRequest
): Promise<GenerativeFillResult> {
  const { tenantId, provider = cloudinaryProvider, jobId } = options
  const period = currentPeriod()

  // ── Quota — before spending a call slot, let alone a credit. ──────────────
  const quota = quotas.getOrThrow(tenantId)
  const usage = usageCounters.get(tenantId, period)
  if (usage.aiExtendCalls >= quota.maxAiExtendPerMonth) {
    throw new AiExtendQuotaExceededError(
      `AI Extend monthly quota reached (${usage.aiExtendCalls}/${quota.maxAiExtendPerMonth} this period).`,
      quota.maxAiExtendPerMonth,
      usage.aiExtendCalls
    )
  }

  const globalCap = config.aiExtendDispatcher.globalMonthlyCap
  const globalUsage = usageCounters.globalAiExtendCalls(period)
  if (globalUsage >= globalCap) {
    throw new AiExtendQuotaExceededError(
      `The shared AI Extend account has reached its global monthly cap (${globalUsage}/${globalCap}) — ` +
        'this protects the whole account from runaway spend, not just one tenant; contact an operator.',
      globalCap,
      globalUsage
    )
  }
  if (globalUsage >= globalCap * 0.8) {
    console.warn(
      `[ai-extend] global monthly usage at ${globalUsage}/${globalCap} ` +
        `(${Math.round((100 * globalUsage) / globalCap)}%)`
    )
  }

  // ── Concurrency ─────────────────────────────────────────────────────────────
  if (!tryAcquireSlots(tenantId)) {
    throw new AiExtendBusyError(
      'AI Extend is at capacity (global or per-tenant concurrency) — try again shortly.'
    )
  }

  try {
    let lastError: CloudinaryServiceError | null = null

    for (let attempt = 1; attempt <= config.aiExtendDispatcher.maxAttempts; attempt++) {
      // Rate-limit wait does not consume a Cloudinary-call attempt — no call
      // has been made yet, so no credit is at stake.
      const gotToken = await awaitToken(30_000)
      if (!gotToken) {
        throw new AiExtendBusyError('AI Extend rate limit reached — try again shortly.')
      }

      try {
        const callStart = performance.now()
        const result = await provider.generativeFill(request)
        if (jobId) {
          logStageTiming({ tenantId, jobId, stage: 'ai_extend:provider_request', durationMs: performance.now() - callStart, attempt })
        }
        usageCounters.incrementAiExtendCalls(tenantId, period)
        return result
      } catch (err) {
        const cloudinaryErr =
          err instanceof CloudinaryServiceError ? err : new CloudinaryServiceError(String(err))
        lastError = cloudinaryErr

        const retryable = RETRYABLE_KINDS.has(cloudinaryErr.kind)
        if (!retryable || attempt === config.aiExtendDispatcher.maxAttempts) throw cloudinaryErr

        const backoff = Math.min(
          config.aiExtendDispatcher.maxBackoffMs,
          config.aiExtendDispatcher.baseBackoffMs * 2 ** (attempt - 1)
        )
        const waitMs = cloudinaryErr.retryAfterMs ?? Math.round(backoff + Math.random() * backoff * 0.3)
        console.warn(
          `[ai-extend] attempt ${attempt}/${config.aiExtendDispatcher.maxAttempts} failed ` +
            `(${cloudinaryErr.kind}), retrying in ${waitMs}ms: ${cloudinaryErr.message}`
        )
        await sleep(waitMs)
      }
    }

    // Unreachable in practice (the loop above always returns or throws), but
    // TypeScript can't see that — and re-throwing the last real error here is
    // more honest than an `as never` cast.
    throw lastError ?? new CloudinaryServiceError('AI Extend failed for an unknown reason')
  } finally {
    releaseSlots(tenantId)
  }
}
