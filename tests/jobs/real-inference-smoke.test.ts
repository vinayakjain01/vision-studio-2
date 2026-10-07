import sharp from 'sharp'
import { describe, it, expect, vi } from 'vitest'
import { createTestTenant } from '../helpers/tenancy-fixture'
import { runWithTenant } from '@/tenancy/context'
import { putOriginal } from '@/storage/media-store'
import { handleVisionJob, handleRenderJob, handleBackgroundFillJob } from '@/jobs/worker'
import { images, products, imports, templates } from '@/db/repositories'
import { createDefaultTemplate } from '@/templates/types'

vi.mock('@/jobs/ai-extend-dispatcher', async importOriginal => {
  const actual = await importOriginal<typeof import('@/jobs/ai-extend-dispatcher')>()
  return {
    ...actual,
    // The REAL dispatcher (quota/concurrency/retry) stays in place; only the
    // underlying Cloudinary call — the one outbound network dependency this
    // app has, and the one that spends real money — is replaced with a
    // trivial fake. This is the "provider mocked" the spec asks for.
    dispatchGenerativeFill: vi.fn(async (_opts, request) => ({
      bytes: await sharp({
        create: { width: request.canvasWidth, height: request.canvasHeight, channels: 3, background: '#888' },
      })
        .jpeg()
        .toBuffer(),
      width: request.canvasWidth,
      height: request.canvasHeight,
    })),
  }
})

/**
 * Real vision inference (the actual ONNX models already present under
 * models/, loaded once and shared, exactly as production does) and real
 * render compositing, across two tenants, in a temp data dir — proving the
 * pipeline as a whole behaves identically to single-tenant operation and
 * leaves no cross-tenant trace, not just the pieces tested in isolation
 * elsewhere in this suite. AI Extend's Cloudinary call is mocked (see
 * above) — never real, never billed.
 *
 * A single synthetic 400x600 JPEG (no real photo needed): the vision engine
 * is expected to find no person/face in it, which is a perfectly valid,
 * exercised code path (an unanalysable or subject-free image must still
 * produce a 'ready' analysis and a plain-fit render, never a crash) — this
 * test is about pipeline correctness and isolation, not detection accuracy.
 */
describe('real-inference smoke test (two tenants, real vision engine, mocked AI Extend)', () => {
  async function setupTenant(label: string) {
    const tenant = createTestTenant(label)
    const ctx = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' as const }

    return runWithTenant(ctx, async () => {
      const photo = await sharp({
        create: { width: 400, height: 600, channels: 3, background: { r: 200, g: 180, b: 160 } },
      })
        .jpeg()
        .toBuffer()

      const { hash, key } = await putOriginal(photo, 'image/jpeg')
      const imp = imports.create({ name: `${label}-import` })
      const product = products.upsert({
        importId: imp.id,
        name: `${label} product`,
        slug: 'p',
        folderPath: 'p',
        category: null,
      })
      const image = images.create({
        productId: product.id,
        importId: imp.id,
        sourceHash: hash,
        storageKey: key,
        fileName: 'photo.jpg',
        relativePath: 'p/photo.jpg',
        mimeType: 'image/jpeg',
        byteSize: photo.byteLength,
        width: 400,
        height: 600,
        exifOrientation: null,
        hasAlpha: false,
        colorSpace: 'srgb',
        capturedAt: null,
        cameraMake: null,
        cameraModel: null,
        position: 0,
        isPrimary: true,
      })

      // createDefaultTemplate() defaults background.mode to 'ai_extend' (see
      // DEFAULT_BACKGROUND in templates/types.ts) — overridden to 'solid'
      // here for the plain-render test, which has nothing to do with AI
      // Extend at all and must not need the dispatcher/background_fill
      // dependency to complete.
      const plainDoc = createDefaultTemplate('4:5')
      plainDoc.background.mode = 'solid'
      const template = templates.create({ name: `${label} template`, document: plainDoc })

      const aiExtendDoc = createDefaultTemplate('4:5')
      aiExtendDoc.background.mode = 'ai_extend'
      const aiExtendTemplate = templates.create({ name: `${label} ai-extend template`, document: aiExtendDoc })

      return { tenant, ctx, image, product, template, aiExtendTemplate, sourceHash: hash }
    })
  }

  it('runs real vision analysis + render for two tenants, with correctly isolated results', async () => {
    const a = await setupTenant('A')
    const b = await setupTenant('B')

    // Real vision analysis — the actual ONNX engine, not a mock.
    const visionA = await runWithTenant(a.ctx, () =>
      handleVisionJob({ imageId: a.image.id, sourceHash: a.sourceHash, storageKey: a.image.storageKey })
    )
    const visionB = await runWithTenant(b.ctx, () =>
      handleVisionJob({ imageId: b.image.id, sourceHash: b.sourceHash, storageKey: b.image.storageKey })
    )
    expect(visionA).toBeTruthy()
    expect(visionB).toBeTruthy()

    const readyA = await runWithTenant(a.ctx, () => Promise.resolve(images.get(a.image.id)))
    const readyB = await runWithTenant(b.ctx, () => Promise.resolve(images.get(b.image.id)))
    expect(readyA?.visionStatus).toBe('ready')
    expect(readyB?.visionStatus).toBe('ready')

    // Real render compositing — plain template, no AI Extend needed here.
    const renderA = await runWithTenant(a.ctx, () =>
      handleRenderJob(
        { imageId: a.image.id, productId: a.product.id, templateId: a.template.id, sourceHash: a.sourceHash },
        { batchId: null }
      )
    )
    const renderB = await runWithTenant(b.ctx, () =>
      handleRenderJob(
        { imageId: b.image.id, productId: b.product.id, templateId: b.template.id, sourceHash: b.sourceHash },
        { batchId: null }
      )
    )
    expect(renderA).toMatchObject({ width: expect.any(Number), height: expect.any(Number) })
    expect(renderB).toMatchObject({ width: expect.any(Number), height: expect.any(Number) })

    // Each tenant's creative exists under its OWN root and nowhere else —
    // same content-addressed inputs (identical synthetic photo), fully
    // separate output storage.
    const { creatives } = await import('@/db/repositories')
    const creativeA = await runWithTenant(a.ctx, () =>
      Promise.resolve(creatives.findByImageAndTemplate(a.image.id, a.template.id))
    )
    const creativeB = await runWithTenant(b.ctx, () =>
      Promise.resolve(creatives.findByImageAndTemplate(b.image.id, b.template.id))
    )
    expect(creativeA).not.toBeNull()
    expect(creativeB).not.toBeNull()

    const { readMedia } = await import('@/storage/media-store')
    const bytesA = await runWithTenant(a.ctx, () => readMedia('creatives', creativeA!.storageKey))
    const bytesB = await runWithTenant(b.ctx, () => readMedia('creatives', creativeB!.storageKey))
    expect(bytesA.length).toBeGreaterThan(0)
    expect(bytesB.length).toBeGreaterThan(0)

    // Tenant A's storage key must not exist under B's root (dedup-separation
    // reconfirmed end-to-end through the real handler, not just media-store
    // directly, per tests/isolation/dedup-separation.test.ts).
    const { mediaExists } = await import('@/storage/media-store')
    const bHasAsKey = await runWithTenant(b.ctx, () => mediaExists('creatives', creativeA!.storageKey))
    expect(bHasAsKey).toBe(false)
  }, 60_000)

  it('ai_extend render uses the MOCKED dispatcher, never a real Cloudinary call, and produces a valid creative', async () => {
    const a = await setupTenant('A-ai-extend')

    // First call for this photo+template queues a background_fill job — this
    // test calls the handler directly (no pool), mirroring the dependency
    // the real render job declines to block on.
    try {
      await runWithTenant(a.ctx, () =>
        handleRenderJob(
          {
            imageId: a.image.id,
            productId: a.product.id,
            templateId: a.aiExtendTemplate.id,
            sourceHash: a.sourceHash,
          },
          { batchId: null }
        )
      )
      throw new Error('expected BackgroundNotReadyError on the first attempt')
    } catch (err) {
      expect((err as Error).name).toBe('BackgroundNotReadyError')
    }

    const backgroundFillResult = await runWithTenant(a.ctx, () =>
      handleBackgroundFillJob({
        imageId: a.image.id,
        productId: a.product.id,
        templateId: a.aiExtendTemplate.id,
        sourceHash: a.sourceHash,
      })
    )
    expect(backgroundFillResult).toMatchObject({ cached: true, billed: true })

    // Now the render finds the (mock-generated) cached background and succeeds.
    const render = await runWithTenant(a.ctx, () =>
      handleRenderJob(
        {
          imageId: a.image.id,
          productId: a.product.id,
          templateId: a.aiExtendTemplate.id,
          sourceHash: a.sourceHash,
        },
        { batchId: null }
      )
    )
    expect(render).toMatchObject({ width: expect.any(Number), height: expect.any(Number) })
  }, 60_000)
})
