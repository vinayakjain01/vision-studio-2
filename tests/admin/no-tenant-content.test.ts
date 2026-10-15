import { describe, it, expect, beforeAll } from 'vitest'
import { createTestTenant, cookieHeader } from '../helpers/tenancy-fixture'
import { makeRequest } from '../helpers/request'
import { runWithTenant } from '@/tenancy/context'
import { imports, products, images, templates, creatives, batches } from '@/db/repositories'
import { createDefaultTemplate } from '@/templates/types'
import { writeFileAtomic } from '@/storage/media-store'
import { users } from '@/db/control-repositories'
import { createSession } from '@/auth/session'
import { listTenantsWithMetrics, getGlobalPanelStats, getDiagnostics } from '@/services/admin-service'
import { GET as adminTenantsGet } from '@/app/api/admin/tenants/route'
import { GET as adminGlobalGet } from '@/app/api/admin/global/route'
import { GET as adminDiagGet } from '@/app/api/admin/diag/route'

/**
 * P5 §5: "the admin UI and its APIs expose counts, sizes, and timings only.
 * No tenant media, thumbnails, filenames, product names, or template
 * content."
 *
 * Seeds a tenant with deliberately distinctive, easy-to-grep business data
 * — a product name, an image filename, a template name, none of which an
 * admin has any legitimate reason to see — then scans the admin
 * endpoints' JSON responses for every one of those exact strings. A tenant
 * NAME is not treated as forbidden content: it's the admin's own label for
 * the workspace it manages, structurally necessary to identify which row
 * is which, unlike a photo filename or product title that belongs to that
 * tenant's own catalog.
 */
describe('admin responses contain no tenant content', () => {
  const PRODUCT_NAME = 'Distinctive Product Name Zephyr-9000'
  const IMAGE_FILENAME = 'distinctive-photo-secret-98765.jpg'
  const TEMPLATE_NAME = 'Distinctive Template Name Quasar-7'
  const FORBIDDEN_STRINGS = [PRODUCT_NAME, IMAGE_FILENAME, TEMPLATE_NAME]

  let adminCookie: string

  beforeAll(async () => {
    const tenant = createTestTenant('NoContentLeakTenant')
    const ctx = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' as const }

    await runWithTenant(ctx, async () => {
      const imp = imports.create({ name: 'content-leak-import' })
      const product = products.upsert({
        importId: imp.id,
        name: PRODUCT_NAME,
        slug: 'zephyr-9000',
        folderPath: 'content-leak-import/zephyr-9000',
        category: null,
      })
      const image = images.create({
        productId: product.id,
        importId: imp.id,
        sourceHash: 'leakhash' + 'a'.repeat(10),
        storageKey: 'll/ll/leakhash.jpg',
        fileName: IMAGE_FILENAME,
        relativePath: `content-leak-import/zephyr-9000/${IMAGE_FILENAME}`,
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
      const template = templates.create({ name: TEMPLATE_NAME, document: createDefaultTemplate('4:5') })
      const batch = batches.create('content-leak-batch')
      await writeFileAtomic('creatives', `${batch.id}/leak.jpg`, Buffer.from('fake-creative-bytes'))
      creatives.put({
        productId: product.id,
        imageId: image.id,
        templateId: template.id,
        batchId: batch.id,
        sourceHash: 'leakhash' + 'a'.repeat(10),
        visionId: null,
        storageKey: `${batch.id}/leak.jpg`,
        mimeType: 'image/jpeg',
        width: 10,
        height: 10,
        byteSize: 10,
        framing: null,
        renderMs: 1,
      })
    })

    const admin = users.create({ email: 'no-content-leak-admin@test.local', passwordHash: 'unused', isPlatformAdmin: true })
    const { token } = createSession(admin.id)
    adminCookie = cookieHeader(token)
  })

  it('listTenantsWithMetrics() contains none of the tenant\'s product/filename/template content', () => {
    const json = JSON.stringify(listTenantsWithMetrics())
    for (const forbidden of FORBIDDEN_STRINGS) {
      expect(json).not.toContain(forbidden)
    }
  })

  it('getGlobalPanelStats() contains none of it either', async () => {
    const json = JSON.stringify(await getGlobalPanelStats())
    for (const forbidden of FORBIDDEN_STRINGS) {
      expect(json).not.toContain(forbidden)
    }
  })

  it('GET /api/admin/tenants response body contains none of it', async () => {
    const request = makeRequest('http://localhost:3000/api/admin/tenants', { cookie: adminCookie })
    const res = await (adminTenantsGet as any)(request)
    const text = await res.text()
    for (const forbidden of FORBIDDEN_STRINGS) {
      expect(text).not.toContain(forbidden)
    }
  })

  it('GET /api/admin/global response body contains none of it', async () => {
    const request = makeRequest('http://localhost:3000/api/admin/global', { cookie: adminCookie })
    const res = await (adminGlobalGet as any)(request)
    const text = await res.text()
    for (const forbidden of FORBIDDEN_STRINGS) {
      expect(text).not.toContain(forbidden)
    }
  })

  it('getDiagnostics() contains none of it either', async () => {
    const json = JSON.stringify(await getDiagnostics())
    for (const forbidden of FORBIDDEN_STRINGS) {
      expect(json).not.toContain(forbidden)
    }
  })

  it('GET /api/admin/diag response body contains none of it', async () => {
    const request = makeRequest('http://localhost:3000/api/admin/diag', { cookie: adminCookie })
    const res = await (adminDiagGet as any)(request)
    const text = await res.text()
    for (const forbidden of FORBIDDEN_STRINGS) {
      expect(text).not.toContain(forbidden)
    }
  })
})
