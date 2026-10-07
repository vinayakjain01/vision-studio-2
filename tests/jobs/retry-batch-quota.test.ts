import { describe, it, expect, beforeEach } from 'vitest'
import { createTestTenant } from '../helpers/tenancy-fixture'
import { runWithTenant } from '@/tenancy/context'
import { getControlDb } from '@/db/client'
import { migrateControl } from '@/db/migrate'
import { batches, templates, products, images, imports } from '@/db/repositories'
import { createDefaultTemplate } from '@/templates/types'
import * as queue from '@/jobs/queue'
import { QuotaExceededError } from '@/jobs/quota'
import { retryBatchFailures } from '@/services/generation-service'

/**
 * `queue.retryBatch()`'s UPDATE moves 'failed' jobs back to 'pending' with no
 * quota check of its own — a failed job doesn't count against
 * `maxQueuedJobs` (only pending/claimed/running do), so resurrecting a pile
 * of them can push a tenant's live queue over its limit exactly as if they
 * were newly enqueued. `retryBatchFailures` is the one place that must catch
 * this before calling into `queue.retryBatch`.
 */
describe('retryBatchFailures is quota-checked', () => {
  // queue.claim() scans across every tenant in control.db — a leftover job
  // from the other `it` in this file (same temp data dir, created once per
  // FILE not per test) would otherwise get claimed instead of the one this
  // test just enqueued.
  beforeEach(() => {
    const db = getControlDb()
    migrateControl(db)
    db.exec('DELETE FROM jobs')
    db.exec('DELETE FROM tenant_queue_state')
    db.exec('DELETE FROM ai_extend_tenant_state')
    db.exec('DELETE FROM usage_counters')
    db.exec('DELETE FROM quotas')
    db.exec('DELETE FROM memberships')
    db.exec('DELETE FROM sessions')
    db.exec('DELETE FROM users')
    db.exec('DELETE FROM tenants')
  })

  async function setupFailedBatch(failedCount: number) {
    const tenant = createTestTenant('RetryQuota')
    const ctx = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' as const }
    let batchId = ''

    await runWithTenant(ctx, async () => {
      const imp = imports.create({ name: 'RetryQuotaImport' })
      const template = templates.create({ name: 'T', document: createDefaultTemplate('4:5') })
      const product = products.upsert({ importId: imp.id, name: 'P', slug: 'p', folderPath: 'p', category: null })
      const batch = batches.create('retry-quota-batch')
      batchId = batch.id

      const jobIds: string[] = []
      for (let i = 0; i < failedCount; i++) {
        const image = images.create({
          productId: product.id,
          importId: imp.id,
          sourceHash: `h-${i}`,
          storageKey: `k-${i}`,
          fileName: `f-${i}.jpg`,
          relativePath: `p/f-${i}.jpg`,
          mimeType: 'image/jpeg',
          byteSize: 10,
          width: 10,
          height: 10,
          exifOrientation: null,
          hasAlpha: false,
          colorSpace: 'srgb',
          capturedAt: null,
          cameraMake: null,
          cameraModel: null,
          position: 0,
          isPrimary: true,
        })
        const { ids } = queue.enqueue(tenant.tenantId, [
          {
            kind: 'render',
            batchId: batch.id,
            payload: { imageId: image.id, productId: product.id, templateId: template.id, sourceHash: `h-${i}` },
          },
        ])
        jobIds.push(ids[0])
      }

      // Fail every job directly and immediately (claim -> park), so each
      // lands in 'failed' status without cycling through a real worker or
      // a retry backoff window.
      for (const id of jobIds) {
        queue.claim('render', 'test-worker')
        queue.park(id, 'test-worker', 'synthetic failure')
      }
    })

    return { tenant, ctx, batchId }
  }

  it('throws QuotaExceededError rather than re-enqueuing past the queued-job limit', async () => {
    const { tenant, ctx, batchId } = await setupFailedBatch(3)

    // Lower this tenant's limit below the number of failed jobs being retried.
    getControlDb().prepare('UPDATE quotas SET max_queued_jobs = 1 WHERE tenant_id = ?').run(tenant.tenantId)

    expect(() => runWithTenant(ctx, () => retryBatchFailures(batchId))).toThrow(QuotaExceededError)

    // None of the failed jobs should have been moved to 'pending' — the
    // check runs BEFORE the UPDATE, so this is all-or-nothing, not a partial
    // retry.
    const counts = runWithTenant(ctx, () => queue.batchJobCounts(tenant.tenantId, batchId))
    expect(counts.failed).toBe(3)
    expect(counts.active).toBe(0)
  })

  it('succeeds normally when the retry fits within the quota', async () => {
    const { tenant, ctx, batchId } = await setupFailedBatch(2)

    const result = runWithTenant(ctx, () => retryBatchFailures(batchId))
    expect(result.retried).toBe(2)

    const counts = runWithTenant(ctx, () => queue.batchJobCounts(tenant.tenantId, batchId))
    expect(counts.active).toBe(2)
    expect(counts.failed).toBe(0)
  })
})
