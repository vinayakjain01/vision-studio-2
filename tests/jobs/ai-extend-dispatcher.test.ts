import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestTenant } from '../helpers/tenancy-fixture'
import {
  dispatchGenerativeFill,
  reconcileAiExtendConcurrency,
  AiExtendQuotaExceededError,
  AiExtendBusyError,
} from '@/jobs/ai-extend-dispatcher'
import { CloudinaryServiceError, type GenerativeFillProvider, type GenerativeFillRequest } from '@/services/cloudinary-service'
import { getControlDb } from '@/db/client'
import { migrateControl } from '@/db/migrate'
import { quotas, usageCounters, currentPeriod } from '@/db/control-repositories'
import { config } from '@/config'
import * as queue from '@/jobs/queue'
import { runWithTenant } from '@/tenancy/context'

const REQUEST: GenerativeFillRequest = {
  photo: Buffer.from('fake'),
  canvasWidth: 100,
  canvasHeight: 100,
  offsetX: 0,
  offsetY: 0,
  placedWidth: 100,
  placedHeight: 100,
}

function fakeResult() {
  return { bytes: Buffer.from('result'), width: 100, height: 100 }
}

describe('AI Extend dispatcher', () => {
  const observedWaits: number[] = []

  beforeEach(() => {
    observedWaits.length = 0
    // Every retry/backoff path in the dispatcher goes through `setTimeout` —
    // mocked here (not with `vi.useFakeTimers()`, which would also freeze
    // `Date.now()` and defeat the token bucket's own real-time refill logic)
    // so every test in this file resolves instantly in real wall-clock time
    // regardless of how many seconds of BACKOFF it models, while still
    // recording what each call actually asked to wait for assertions that
    // care (e.g. "honored the exact Retry-After value").
    vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      observedWaits.push(ms ?? 0)
      return setImmediate(fn) as unknown as NodeJS.Timeout
    }) as any)

    const db = getControlDb()
    migrateControl(db)
    db.exec('DELETE FROM ai_extend_global_state')
    db.exec('DELETE FROM ai_extend_tenant_state')
    db.exec('DELETE FROM usage_counters')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('a successful call increments usage exactly once', async () => {
    const t = createTestTenant('T')
    let calls = 0
    const provider: GenerativeFillProvider = {
      generativeFill: async () => {
        calls++
        return fakeResult()
      },
    }

    const result = await dispatchGenerativeFill({ tenantId: t.tenantId, provider }, REQUEST)
    expect(result.width).toBe(100)
    expect(calls).toBe(1)
    expect(usageCounters.get(t.tenantId).aiExtendCalls).toBe(1)
  })

  it('a tenant at its monthly quota is rejected before any provider call', async () => {
    const t = createTestTenant('T')
    const quota = quotas.getOrThrow(t.tenantId)
    // Exhaust the quota directly.
    for (let i = 0; i < quota.maxAiExtendPerMonth; i++) {
      usageCounters.incrementAiExtendCalls(t.tenantId)
    }

    let called = false
    const provider: GenerativeFillProvider = {
      generativeFill: async () => {
        called = true
        return fakeResult()
      },
    }

    await expect(dispatchGenerativeFill({ tenantId: t.tenantId, provider }, REQUEST)).rejects.toThrow(
      AiExtendQuotaExceededError
    )
    expect(called).toBe(false)
  })

  it('the global monthly cap rejects every tenant once reached, before any provider call', async () => {
    const t = createTestTenant('T')
    const period = currentPeriod()
    // Drive the GLOBAL total (summed across tenants) to the cap via a second tenant.
    const other = createTestTenant('Other')
    for (let i = 0; i < config.aiExtendDispatcher.globalMonthlyCap; i++) {
      usageCounters.incrementAiExtendCalls(other.tenantId, period)
    }

    let called = false
    const provider: GenerativeFillProvider = {
      generativeFill: async () => {
        called = true
        return fakeResult()
      },
    }

    await expect(dispatchGenerativeFill({ tenantId: t.tenantId, provider }, REQUEST)).rejects.toThrow(
      AiExtendQuotaExceededError
    )
    expect(called).toBe(false)
  })

  it('retries on rate_limited and honors Retry-After, then succeeds', async () => {
    const t = createTestTenant('T')
    let attempt = 0
    const provider: GenerativeFillProvider = {
      generativeFill: async () => {
        attempt++
        if (attempt === 1) {
          throw new CloudinaryServiceError('rate limited', 'rate_limited', 1234)
        }
        return fakeResult()
      },
    }

    const result = await dispatchGenerativeFill({ tenantId: t.tenantId, provider }, REQUEST)
    expect(attempt).toBe(2)
    expect(result.width).toBe(100)
    expect(observedWaits).toContain(1234) // honored the provider's Retry-After exactly
    expect(usageCounters.get(t.tenantId).aiExtendCalls).toBe(1) // only the SUCCESSFUL call is metered
  })

  it('never retries a deterministic failure (auth) — fails on the first attempt', async () => {
    const t = createTestTenant('T')
    let attempt = 0
    const provider: GenerativeFillProvider = {
      generativeFill: async () => {
        attempt++
        throw new CloudinaryServiceError('bad credentials', 'auth')
      },
    }

    await expect(dispatchGenerativeFill({ tenantId: t.tenantId, provider }, REQUEST)).rejects.toThrow(
      CloudinaryServiceError
    )
    expect(attempt).toBe(1)
    expect(usageCounters.get(t.tenantId).aiExtendCalls).toBe(0)
  })

  it('exhausts retries on a persistently retryable failure (server_error) and throws', async () => {
    const t = createTestTenant('T')
    let attempt = 0
    const provider: GenerativeFillProvider = {
      generativeFill: async () => {
        attempt++
        throw new CloudinaryServiceError('boom', 'server_error')
      },
    }

    await expect(dispatchGenerativeFill({ tenantId: t.tenantId, provider }, REQUEST)).rejects.toThrow(
      CloudinaryServiceError
    )
    expect(attempt).toBe(config.aiExtendDispatcher.maxAttempts)
  })

  it('releases its concurrency slot even when the provider throws', async () => {
    const t = createTestTenant('T')
    const provider: GenerativeFillProvider = {
      generativeFill: async () => {
        throw new CloudinaryServiceError('bad creds', 'auth')
      },
    }

    await expect(dispatchGenerativeFill({ tenantId: t.tenantId, provider }, REQUEST)).rejects.toThrow()

    const row = getControlDb().prepare('SELECT in_flight FROM ai_extend_global_state WHERE id = 1').get() as
      | { in_flight: number }
      | undefined
    expect(row?.in_flight ?? 0).toBe(0)
  })

  it('rejects when the per-tenant concurrency cap is already at capacity', async () => {
    const t = createTestTenant('T')
    // Saturate the tenant's own concurrency slots directly.
    getControlDb()
      .prepare(
        `INSERT INTO ai_extend_tenant_state (tenant_id, in_flight) VALUES (?, ?)
         ON CONFLICT (tenant_id) DO UPDATE SET in_flight = excluded.in_flight`
      )
      .run(t.tenantId, config.aiExtendDispatcher.perTenantConcurrency)

    let called = false
    const provider: GenerativeFillProvider = {
      generativeFill: async () => {
        called = true
        return fakeResult()
      },
    }

    await expect(dispatchGenerativeFill({ tenantId: t.tenantId, provider }, REQUEST)).rejects.toThrow(
      AiExtendBusyError
    )
    expect(called).toBe(false)
  })
})

/**
 * Confirmed in production (2026-11-05): `releaseSlots` only runs if the
 * worker holding a slot reaches its own `finally` — a hard kill (a crashed
 * or forcibly terminated worker process) skips that entirely, leaking the
 * slot forever. Nothing else ever decremented it, so `in_flight` was found
 * stuck at its configured cap with ZERO `background_fill` jobs actually
 * `running` and zero worker processes alive at all — every future AI Extend
 * call refused as "at capacity" regardless of real load. Same class of bug
 * `queue.reclaimStale()`/`reconcileRunningJobs()` already exists to fix for
 * the `jobs` table itself; this is the equivalent for the AI-Extend
 * concurrency counters, called the same way (pool start + periodic sweep).
 */
describe('reconcileAiExtendConcurrency', () => {
  beforeEach(() => {
    const db = getControlDb()
    migrateControl(db)
    db.exec('DELETE FROM ai_extend_global_state')
    db.exec('DELETE FROM ai_extend_tenant_state')
    db.exec('DELETE FROM jobs')
  })

  it('resets a leaked global in_flight counter to 0 when no background_fill job is actually running', () => {
    getControlDb()
      .prepare(
        `INSERT INTO ai_extend_global_state (id, in_flight, tokens, last_refill_at) VALUES (1, 4, 0, ?)`
      )
      .run(new Date().toISOString())

    reconcileAiExtendConcurrency()

    const row = getControlDb().prepare('SELECT in_flight FROM ai_extend_global_state WHERE id = 1').get() as {
      in_flight: number
    }
    expect(row.in_flight).toBe(0)
  })

  it('resets a leaked per-tenant in_flight counter to 0 when that tenant has no background_fill job running', () => {
    const t = createTestTenant('T')
    getControlDb()
      .prepare(
        `INSERT INTO ai_extend_tenant_state (tenant_id, in_flight) VALUES (?, ?)
         ON CONFLICT (tenant_id) DO UPDATE SET in_flight = excluded.in_flight`
      )
      .run(t.tenantId, 3)

    reconcileAiExtendConcurrency()

    const row = getControlDb().prepare('SELECT in_flight FROM ai_extend_tenant_state WHERE tenant_id = ?').get(t.tenantId) as {
      in_flight: number
    }
    expect(row.in_flight).toBe(0)
  })

  it('sets in_flight to the REAL count of running background_fill jobs, global and per tenant', () => {
    const t = createTestTenant('T')
    runWithTenant({ tenantId: t.tenantId, userId: t.userId, role: 'owner' }, () => {
      const { ids } = queue.enqueue(t.tenantId, [
        { kind: 'background_fill', payload: { imageId: 'i1' } as any },
        { kind: 'background_fill', payload: { imageId: 'i2' } as any },
      ])
      for (const id of ids) {
        const claimed = queue.claim('background_fill', 'w1')
        expect(claimed?.id).toBe(id) // claims in insertion order — asserts the seed, not the fix
        queue.markRunning(id, 'w1')
      }
    })

    getControlDb()
      .prepare(
        `INSERT INTO ai_extend_global_state (id, in_flight, tokens, last_refill_at) VALUES (1, 99, 0, ?)`
      )
      .run(new Date().toISOString())
    getControlDb()
      .prepare(
        `INSERT INTO ai_extend_tenant_state (tenant_id, in_flight) VALUES (?, ?)
         ON CONFLICT (tenant_id) DO UPDATE SET in_flight = excluded.in_flight`
      )
      .run(t.tenantId, 99)

    reconcileAiExtendConcurrency()

    const globalRow = getControlDb().prepare('SELECT in_flight FROM ai_extend_global_state WHERE id = 1').get() as {
      in_flight: number
    }
    const tenantRow = getControlDb()
      .prepare('SELECT in_flight FROM ai_extend_tenant_state WHERE tenant_id = ?')
      .get(t.tenantId) as { in_flight: number }
    expect(globalRow.in_flight).toBe(2)
    expect(tenantRow.in_flight).toBe(2)
  })

  it('is safe to call with no existing state rows at all', () => {
    expect(() => reconcileAiExtendConcurrency()).not.toThrow()
  })
})
