import { describe, it, expect, vi } from 'vitest'
import { createTestTenant } from '../helpers/tenancy-fixture'
import { runWithTenant } from '@/tenancy/context'
import { batches, templates, products, images, imports } from '@/db/repositories'
import { createDefaultTemplate } from '@/templates/types'
import * as queue from '@/jobs/queue'

/**
 * `waitingForWorker` (P4 §8): true only when THIS tenant has jobs waiting
 * AND every worker in the shared pool is busy — real contention, not just
 * "nothing started yet" or "the pool happens to be idle". Mocks
 * `getPool().status()` directly rather than spawning real workers, since
 * what's under test is the boolean's LOGIC (the AND condition and its two
 * operands), not the worker pool itself — that's already covered by
 * `child-process-recovery.test.ts` and `pool-watchdog.test.ts`.
 */
vi.mock('@/jobs/pool', async () => {
  const actual = await vi.importActual<typeof import('@/jobs/pool')>('@/jobs/pool')
  return {
    ...actual,
    getPool: vi.fn(),
  }
})

import { getPool } from '@/jobs/pool'
import { getBatchProgress } from '@/services/generation-service'

function mockWorkers(states: ('busy' | 'idle')[]) {
  vi.mocked(getPool).mockReturnValue({
    status: () => ({
      running: true,
      workers: states.map((state, i) => ({ id: `w${i}`, kinds: ['render'], state, pid: 1 })),
      completed: 0,
      failed: 0,
      startedAt: null,
    }),
  } as any)
}

async function setupPendingBatch() {
  const tenant = createTestTenant('WaitingForWorker')
  const ctx = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' as const }
  let batchId = ''

  await runWithTenant(ctx, async () => {
    const imp = imports.create({ name: 'WaitingImport' })
    const template = templates.create({ name: 'T', document: createDefaultTemplate('4:5') })
    const product = products.upsert({ importId: imp.id, name: 'P', slug: 'p', folderPath: 'p', category: null })
    const image = images.create({
      productId: product.id,
      importId: imp.id,
      sourceHash: 'h',
      storageKey: 'k',
      fileName: 'f.jpg',
      relativePath: 'p/f.jpg',
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
    const batch = batches.create('waiting-batch')
    batchId = batch.id
    queue.enqueue(tenant.tenantId, [
      {
        kind: 'render',
        batchId: batch.id,
        payload: { imageId: image.id, productId: product.id, templateId: template.id, sourceHash: 'h' },
      },
    ])
  })

  return { tenant, ctx, batchId }
}

describe('getBatchProgress: waitingForWorker', () => {
  it('true when this tenant has a pending job and every worker is busy', async () => {
    const { ctx, batchId } = await setupPendingBatch()
    mockWorkers(['busy', 'busy'])

    const progress = await runWithTenant(ctx, () => Promise.resolve(getBatchProgress(batchId)))
    expect(progress?.waitingForWorker).toBe(true)
  })

  it('false when a worker is idle, even with a pending job (contention is not real)', async () => {
    const { ctx, batchId } = await setupPendingBatch()
    mockWorkers(['busy', 'idle'])

    const progress = await runWithTenant(ctx, () => Promise.resolve(getBatchProgress(batchId)))
    expect(progress?.waitingForWorker).toBe(false)
  })

  it('false when the pool reports no workers at all', async () => {
    const { ctx, batchId } = await setupPendingBatch()
    mockWorkers([])

    const progress = await runWithTenant(ctx, () => Promise.resolve(getBatchProgress(batchId)))
    expect(progress?.waitingForWorker).toBe(false)
  })
})
