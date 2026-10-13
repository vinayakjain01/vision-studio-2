import crypto from 'crypto'
import { describe, it, expect } from 'vitest'
import { createTestTenant, cookieHeader } from '../helpers/tenancy-fixture'
import { makeRequest, makeParams } from '../helpers/request'
import { runWithTenant, type TenantContext } from '@/tenancy/context'
import { imports, products, images } from '@/db/repositories'
import { writeFileAtomic } from '@/storage/media-store'
import { GET as getProduct } from '@/app/api/products/[productId]/route'

const productDetail = getProduct as unknown as (...args: unknown[]) => Promise<Response>

/** A product with `count` images, for exercising pagination directly (no fixture image reuse — each needs its own sourceHash/storageKey). */
async function seedProductWithImages(tenant: Awaited<ReturnType<typeof createTestTenant>>, count: number) {
  const ctx: TenantContext = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }
  return runWithTenant(ctx, async () => {
    const imp = imports.create({ name: 'pagination-test-import', totalFiles: count })
    const product = products.upsert({
      importId: imp.id,
      name: 'Paginated Product',
      slug: 'paginated-product',
      folderPath: 'paginated-product',
      category: null,
    })

    for (let i = 0; i < count; i++) {
      const sourceHash = crypto.createHash('sha256').update(`${tenant.tenantId}-photo-${i}`).digest('hex')
      const originalKey = `${sourceHash.slice(0, 2)}/${sourceHash.slice(2, 4)}/${sourceHash}.jpg`
      await writeFileAtomic('originals', originalKey, Buffer.from(`bytes-${i}`))
      const image = images.create({
        productId: product.id,
        importId: imp.id,
        sourceHash,
        storageKey: originalKey,
        fileName: `photo-${i}.jpg`,
        relativePath: `paginated-product/photo-${i}.jpg`,
        mimeType: 'image/jpeg',
        byteSize: 100,
        width: 100,
        height: 100,
        exifOrientation: null,
        hasAlpha: false,
        colorSpace: 'srgb',
        capturedAt: null,
        cameraMake: null,
        cameraModel: null,
        position: i,
        isPrimary: i === 0,
      })
      images.setVisionStatus(image.id, 'ready')
    }

    return product
  })
}

describe('GET /api/products/[productId] — pagination', () => {
  it('defaults to page 1 with the built-in page size when no params are given', async () => {
    const tenant = await createTestTenant('PaginationDefault')
    const product = await seedProductWithImages(tenant, 5)

    const res = await productDetail(
      makeRequest(`http://localhost:3000/api/products/${product.id}`, { cookie: cookieHeader(tenant.sessionToken) }),
      makeParams({ productId: product.id })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.page).toBe(1)
    expect(body.imagesTotal).toBe(5)
    expect(body.images).toHaveLength(5) // under one default page size (40)
  })

  it('slices correctly across pages and reports accurate totals', async () => {
    const tenant = await createTestTenant('PaginationSlicing')
    const product = await seedProductWithImages(tenant, 5)

    const page1 = await productDetail(
      makeRequest(`http://localhost:3000/api/products/${product.id}?page=1&pageSize=2`, {
        cookie: cookieHeader(tenant.sessionToken),
      }),
      makeParams({ productId: product.id })
    )
    const body1 = await page1.json()
    expect(body1.images.map((i: { fileName: string }) => i.fileName)).toEqual(['photo-0.jpg', 'photo-1.jpg'])
    expect(body1.imagesTotal).toBe(5)
    expect(body1.pageSize).toBe(2)

    const page3 = await productDetail(
      makeRequest(`http://localhost:3000/api/products/${product.id}?page=3&pageSize=2`, {
        cookie: cookieHeader(tenant.sessionToken),
      }),
      makeParams({ productId: product.id })
    )
    const body3 = await page3.json()
    // Last page, partial — only the one remaining image, not a short error.
    expect(body3.images.map((i: { fileName: string }) => i.fileName)).toEqual(['photo-4.jpg'])
    expect(body3.imagesTotal).toBe(5)
  })

  it('an out-of-range page returns an empty images array, not an error', async () => {
    const tenant = await createTestTenant('PaginationOutOfRange')
    const product = await seedProductWithImages(tenant, 3)

    const res = await productDetail(
      makeRequest(`http://localhost:3000/api/products/${product.id}?page=99&pageSize=2`, {
        cookie: cookieHeader(tenant.sessionToken),
      }),
      makeParams({ productId: product.id })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.images).toEqual([])
    expect(body.imagesTotal).toBe(3)
  })

  it('clamps a huge pageSize rather than returning everything unbounded', async () => {
    const tenant = await createTestTenant('PaginationClamp')
    const product = await seedProductWithImages(tenant, 3)

    const res = await productDetail(
      makeRequest(`http://localhost:3000/api/products/${product.id}?pageSize=999999`, {
        cookie: cookieHeader(tenant.sessionToken),
      }),
      makeParams({ productId: product.id })
    )
    const body = await res.json()
    expect(body.pageSize).toBeLessThanOrEqual(200)
  })
})
