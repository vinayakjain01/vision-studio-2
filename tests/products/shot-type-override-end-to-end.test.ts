import crypto from 'crypto'
import { describe, it, expect } from 'vitest'
import { createTestTenant, cookieHeader } from '../helpers/tenancy-fixture'
import { makeRequest } from '../helpers/request'
import { runWithTenant, type TenantContext } from '@/tenancy/context'
import { imports, products, images, visionAnalyses } from '@/db/repositories'
import { writeFileAtomic } from '@/storage/media-store'
import { GET as listProductsImpl } from '@/app/api/products/route'
import { GET as previewSubjectsImpl } from '@/app/api/preview/subjects/route'
import type { VisionMetadata } from '@/vision/types'

const listProducts = listProductsImpl as unknown as (...args: unknown[]) => Promise<Response>
const previewSubjects = previewSubjectsImpl as unknown as (...args: unknown[]) => Promise<Response>

function buildMetadata(sourceHash: string, shotType: VisionMetadata['shot']['type']): VisionMetadata {
  return {
    schemaVersion: 1,
    sourceHash,
    image: { width: 1200, height: 1800 },
    persons: [],
    primaryPersonIndex: null,
    faces: [],
    primaryFaceIndex: null,
    segmentation: { person: null, garment: null },
    garment: { type: 'unknown', box: null } as unknown as VisionMetadata['garment'],
    anchors: {} as unknown as VisionMetadata['anchors'],
    shot: { type: shotType, confidence: 1, reasoning: 'test fixture', signals: {} as any },
    quality: { overall: 1 } as unknown as VisionMetadata['quality'],
    engineVersion: 'test-engine',
    provider: 'test',
    modelVersions: {},
    timings: {},
    durationMs: 1,
    createdAt: new Date().toISOString(),
  }
}

/**
 * End-to-end check for the actual bug report (2026-10-27): a colorway-grid
 * sheet got "Product only" in one sheet and "Half body" in the next, so the
 * same template rule cropped them inconsistently. These exercise the fix
 * through the two routes the report's screenshots came from — the Products
 * grid badge and the template builder's preview/subjects feed — rather than
 * just the unit-level pieces already covered elsewhere.
 */
describe('shot-type override — end to end through real routes', () => {
  async function seedProductWithOneReadyPhoto(
    tenant: Awaited<ReturnType<typeof createTestTenant>>,
    detectedShotType: VisionMetadata['shot']['type']
  ) {
    const ctx: TenantContext = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }
    return runWithTenant(ctx, async () => {
      const imp = imports.create({ name: 'e2e-override-import' })
      const product = products.upsert({
        importId: imp.id,
        name: 'Color',
        slug: 'color',
        folderPath: 'color',
        category: null,
      })

      const sourceHash = crypto.createHash('sha256').update(`${tenant.tenantId}-e2e`).digest('hex')
      const originalKey = `${sourceHash.slice(0, 2)}/${sourceHash.slice(2, 4)}/${sourceHash}.jpg`
      await writeFileAtomic('originals', originalKey, Buffer.from('bytes'))
      const image = images.create({
        productId: product.id,
        importId: imp.id,
        sourceHash,
        storageKey: originalKey,
        fileName: 'AN50 CLOSEUP.png',
        relativePath: 'color/AN50 CLOSEUP.png',
        mimeType: 'image/jpeg',
        byteSize: 100,
        width: 1200,
        height: 1800,
        exifOrientation: null,
        hasAlpha: false,
        colorSpace: 'srgb',
        capturedAt: null,
        cameraMake: null,
        cameraModel: null,
        position: 0,
        isPrimary: true,
      })
      images.setVisionStatus(image.id, 'ready')
      visionAnalyses.put(buildMetadata(sourceHash, detectedShotType))

      return product
    })
  }

  it('Products grid badge reflects the override, not the per-photo detection', async () => {
    const tenant = await createTestTenant('E2EProductsBadge')
    const product = await seedProductWithOneReadyPhoto(tenant, 'product_only')
    const ctx: TenantContext = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }
    await runWithTenant(ctx, async () => products.setShotTypeOverride(product.id, 'flat_lay'))

    const res = await listProducts(makeTenantRequest(tenant, 'http://localhost:3000/api/products'))
    const body = await res.json()
    const summary = body.products.find((p: { id: string }) => p.id === product.id)
    expect(summary.shotType).toBe('flat_lay')
    expect(summary.shotTypeOverride).toBe('flat_lay')
  })

  it('template builder preview reflects the override for every photo in the folder', async () => {
    const tenant = await createTestTenant('E2EPreviewSubjects')
    const product = await seedProductWithOneReadyPhoto(tenant, 'half_body')
    const ctx: TenantContext = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }
    await runWithTenant(ctx, async () => products.setShotTypeOverride(product.id, 'flat_lay'))

    const res = await previewSubjects(
      makeTenantRequest(tenant, `http://localhost:3000/api/preview/subjects?productId=${product.id}`)
    )
    const body = await res.json()
    expect(body.subjects).toHaveLength(1)
    expect(body.subjects[0].shotType).toBe('flat_lay')
  })

  it('without an override, both routes still show the real detected shot type — unchanged behaviour', async () => {
    const tenant = await createTestTenant('E2ENoOverride')
    const product = await seedProductWithOneReadyPhoto(tenant, 'full_body')

    const listRes = await listProducts(makeTenantRequest(tenant, 'http://localhost:3000/api/products'))
    const listBody = await listRes.json()
    const summary = listBody.products.find((p: { id: string }) => p.id === product.id)
    expect(summary.shotType).toBe('full_body')
    expect(summary.shotTypeOverride).toBeNull()

    const previewRes = await previewSubjects(
      makeTenantRequest(tenant, `http://localhost:3000/api/preview/subjects?productId=${product.id}`)
    )
    const previewBody = await previewRes.json()
    expect(previewBody.subjects[0].shotType).toBe('full_body')
  })
})

function makeTenantRequest(tenant: Awaited<ReturnType<typeof createTestTenant>>, url: string) {
  return makeRequest(url, { cookie: cookieHeader(tenant.sessionToken) })
}
