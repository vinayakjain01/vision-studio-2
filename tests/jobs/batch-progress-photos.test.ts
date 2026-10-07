import { describe, it, expect } from 'vitest'
import { createTestTenant } from '../helpers/tenancy-fixture'
import { runWithTenant } from '@/tenancy/context'
import { batches, templates, products, images, imports } from '@/db/repositories'
import { createDefaultTemplate } from '@/templates/types'
import * as queue from '@/jobs/queue'
import { getBatchProgress } from '@/services/generation-service'

/**
 * `BatchProgress.photos` (P4 §8): one entry per photo in the batch, with
 * the job's queue status collapsed to the four states a user watches for
 * (plus 'cancelled') — queued / running / done / failed / cancelled.
 */
describe('getBatchProgress: per-photo states', () => {
  it('maps each job status to its photo-status label', async () => {
    const tenant = createTestTenant('BatchPhotos')
    const ctx = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' as const }

    const { batchId, imageIds } = await runWithTenant(ctx, async () => {
      const imp = imports.create({ name: 'PhotosImport' })
      const template = templates.create({ name: 'T', document: createDefaultTemplate('4:5') })
      const product = products.upsert({ importId: imp.id, name: 'P', slug: 'p', folderPath: 'p', category: null })
      const batch = batches.create('photos-batch')

      const imageIds: string[] = []
      for (let i = 0; i < 3; i++) {
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
        imageIds.push(image.id)
        queue.enqueue(tenant.tenantId, [
          {
            kind: 'render',
            batchId: batch.id,
            payload: { imageId: image.id, productId: product.id, templateId: template.id, sourceHash: `h-${i}` },
          },
        ])
      }

      return { batchId: batch.id, imageIds }
    })

    // Job 0 (image 0): claimed + markRunning -> 'running'.
    const claimed1 = queue.claim('render', 'w1')
    expect(claimed1?.payload && (claimed1.payload as any).imageId).toBe(imageIds[0])
    queue.markRunning(claimed1!.id, 'w1')

    // Job 1 (image 1): claimed + park -> 'failed'.
    const claimed2 = queue.claim('render', 'w2')
    expect(claimed2?.payload && (claimed2.payload as any).imageId).toBe(imageIds[1])
    queue.park(claimed2!.id, 'w2', 'synthetic failure')

    // Job 2 (image 2): never claimed -> stays 'pending' -> 'queued'.

    const progress = runWithTenant(ctx, () => getBatchProgress(batchId))!
    const byImage = new Map(progress.photos.map(p => [p.imageId, p.status]))

    expect(byImage.get(imageIds[0])).toBe('running')
    expect(byImage.get(imageIds[1])).toBe('failed')
    expect(byImage.get(imageIds[2])).toBe('queued')
  })
})
