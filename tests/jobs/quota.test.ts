import { describe, it, expect, beforeEach } from 'vitest'
import { createTestTenant } from '../helpers/tenancy-fixture'
import * as queue from '@/jobs/queue'
import {
  assertCanEnqueue,
  assertImagesPerBatch,
  assertStorageBudget,
  tryAcquireUploadSlot,
  releaseUploadSlot,
  QuotaExceededError,
} from '@/jobs/quota'
import { quotas, usageCounters } from '@/db/control-repositories'
import { getControlDb } from '@/db/client'
import { migrateControl } from '@/db/migrate'

describe('quota enforcement', () => {
  beforeEach(() => {
    migrateControl(getControlDb())
  })

  it('assertCanEnqueue passes under the limit and throws with a stable code over it', () => {
    const t = createTestTenant('T')
    expect(() => assertCanEnqueue(t.tenantId, 1)).not.toThrow()

    const quota = quotas.getOrThrow(t.tenantId)
    queue.enqueue(
      t.tenantId,
      Array.from({ length: quota.maxQueuedJobs }, (_, i) => ({
        kind: 'vision' as const,
        payload: { imageId: `i${i}`, sourceHash: `h${i}`, storageKey: 'k' },
      }))
    )

    try {
      assertCanEnqueue(t.tenantId, 1)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError)
      expect((err as QuotaExceededError).code).toBe('max_queued_jobs')
      expect((err as QuotaExceededError).limit).toBe(quota.maxQueuedJobs)
    }
  })

  it('assertImagesPerBatch throws with the batch-size code when over the per-batch limit', () => {
    const t = createTestTenant('T')
    const quota = quotas.getOrThrow(t.tenantId)
    expect(() => assertImagesPerBatch(t.tenantId, quota.maxImagesPerBatch)).not.toThrow()

    try {
      assertImagesPerBatch(t.tenantId, quota.maxImagesPerBatch + 1)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError)
      expect((err as QuotaExceededError).code).toBe('max_images_per_batch')
    }
  })

  it('assertStorageBudget accounts for existing usage, not just the new bytes', () => {
    const t = createTestTenant('T')
    const quota = quotas.getOrThrow(t.tenantId)
    usageCounters.setStorageBytes(t.tenantId, quota.maxStorageBytes - 100)

    expect(() => assertStorageBudget(t.tenantId, 50)).not.toThrow()
    try {
      assertStorageBudget(t.tenantId, 200)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError)
      expect((err as QuotaExceededError).code).toBe('max_storage_bytes')
    }
  })

  it('upload concurrency slots are per-tenant and released correctly', () => {
    const t = createTestTenant('T')
    const quota = quotas.getOrThrow(t.tenantId)

    const acquired: boolean[] = []
    for (let i = 0; i < quota.maxConcurrentUploads; i++) {
      acquired.push(tryAcquireUploadSlot(t.tenantId))
    }
    expect(acquired.every(Boolean)).toBe(true)

    // One more is over capacity.
    expect(tryAcquireUploadSlot(t.tenantId)).toBe(false)

    // Releasing one frees exactly one slot.
    releaseUploadSlot(t.tenantId)
    expect(tryAcquireUploadSlot(t.tenantId)).toBe(true)
    expect(tryAcquireUploadSlot(t.tenantId)).toBe(false)
  })

  it('upload slots are isolated per tenant — one tenant at capacity does not block another', () => {
    const a = createTestTenant('A')
    const b = createTestTenant('B')
    const quota = quotas.getOrThrow(a.tenantId)

    for (let i = 0; i < quota.maxConcurrentUploads; i++) {
      expect(tryAcquireUploadSlot(a.tenantId)).toBe(true)
    }
    expect(tryAcquireUploadSlot(a.tenantId)).toBe(false)
    expect(tryAcquireUploadSlot(b.tenantId)).toBe(true) // unaffected by A's saturation
  })
})
