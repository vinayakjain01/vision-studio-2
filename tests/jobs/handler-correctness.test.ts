import sharp from 'sharp'
import { describe, it, expect } from 'vitest'
import { createTestTenant } from '../helpers/tenancy-fixture'
import { runWithTenant } from '@/tenancy/context'
import { putOriginal } from '@/storage/media-store'
import { handleRenderJob } from '@/jobs/worker'
import { images, products, imports, templates, batches, creatives } from '@/db/repositories'
import { createDefaultTemplate } from '@/templates/types'

async function setup(label: string) {
  const tenant = createTestTenant(label)
  const ctx = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' as const }

  return runWithTenant(ctx, async () => {
    const photo = await sharp({ create: { width: 200, height: 300, channels: 3, background: '#a08060' } })
      .jpeg()
      .toBuffer()
    const { hash, key } = await putOriginal(photo, 'image/jpeg')
    const imp = imports.create({ name: `${label}-import` })
    const product = products.upsert({ importId: imp.id, name: 'p', slug: 'p', folderPath: 'p', category: null })
    const image = images.create({
      productId: product.id,
      importId: imp.id,
      sourceHash: hash,
      storageKey: key,
      fileName: 'photo.jpg',
      relativePath: 'p/photo.jpg',
      mimeType: 'image/jpeg',
      byteSize: photo.byteLength,
      width: 200,
      height: 300,
      exifOrientation: null,
      hasAlpha: false,
      colorSpace: 'srgb',
      capturedAt: null,
      cameraMake: null,
      cameraModel: null,
      position: 0,
      isPrimary: true,
    })
    const doc = createDefaultTemplate('4:5')
    doc.background.mode = 'solid' // no AI Extend dependency for these tests
    const template = templates.create({ name: 't', document: doc })
    const batch = batches.create(`${label}-batch`)

    return { ctx, image, product, template, batch, sourceHash: hash }
  })
}

describe('render handler correctness', () => {
  it('running the same render job twice (at-least-once delivery) produces identical, non-duplicated results', async () => {
    const s = await setup('Idem')

    const payload = {
      imageId: s.image.id,
      productId: s.product.id,
      templateId: s.template.id,
      sourceHash: s.sourceHash,
    }

    const first = await runWithTenant(s.ctx, () => handleRenderJob(payload, { batchId: s.batch.id }))
    const second = await runWithTenant(s.ctx, () => handleRenderJob(payload, { batchId: s.batch.id }))

    expect(first).toMatchObject({ width: expect.any(Number), height: expect.any(Number) })
    expect(second).toMatchObject({ width: expect.any(Number), height: expect.any(Number) })
    expect(first.storageKey).toBe(second.storageKey) // same deterministic key, not a second file

    // creatives.put() upserts on (image_id, template_id) — exactly one row,
    // not two, after running the handler twice for the same image+template.
    const rows = await runWithTenant(s.ctx, () =>
      Promise.resolve(creatives.listByProduct(s.product.id))
    )
    expect(rows).toHaveLength(1)
  })

  it('cancelling a batch WHILE a job is already mid-render discards that job\'s output (never persisted)', async () => {
    const s = await setup('Cancel')

    const payload = {
      imageId: s.image.id,
      productId: s.product.id,
      templateId: s.template.id,
      sourceHash: s.sourceHash,
    }

    // handleRenderJob is async and checks isBatchCancelled synchronously at
    // its very top, before its first `await` — calling it starts that
    // synchronous prefix (batch not yet cancelled, so it proceeds) and then
    // yields control back here at its first real await. Setting the batch
    // to 'cancelled' on THIS tick, before awaiting the promise, lands
    // exactly in the "already running when cancellation happens" window —
    // the scenario `cancelBatch()` deliberately leaves alone (it only
    // touches pending/claimed rows) and the render handler's SECOND
    // isBatchCancelled check (added for this) is the only thing that can
    // still catch.
    const renderPromise = runWithTenant(s.ctx, () => handleRenderJob(payload, { batchId: s.batch.id }))
    await runWithTenant(s.ctx, () => Promise.resolve(batches.setStatus(s.batch.id, 'cancelled')))

    const result = await renderPromise
    expect(result).toEqual({ skipped: true, reason: 'batch cancelled' })

    const rows = await runWithTenant(s.ctx, () => Promise.resolve(creatives.listByProduct(s.product.id)))
    expect(rows).toHaveLength(0) // no creative was ever persisted
  })
})
