import crypto from 'crypto'
import { runWithTenant, type TenantContext } from '@/tenancy/context'
import { imports, products, images, templates, rules, batches, creatives } from '@/db/repositories'
import { createDefaultTemplate } from '@/templates/types'
import { writeFileAtomic } from '@/storage/media-store'
import type { TestTenant } from './tenancy-fixture'

export interface SeededResources {
  importId: string
  productId: string
  imageId: string
  sourceHash: string
  storageKey: string
  templateId: string
  ruleId: string
  batchId: string
  creativeId: string
}

/**
 * One fully-linked resource graph (import → product → image → template →
 * rule → batch → creative) owned by `tenant`, created directly against its
 * own DB via `runWithTenant` — not through the HTTP routes, since the
 * isolation suite's whole point is testing those routes, not relying on
 * them to seed their own test data. Every dynamic route in the app resolves
 * to one of these resource kinds by ID, so this one fixture covers the
 * "does route X leak tenant A's resource to tenant B" case for all of them.
 */
export async function seedResources(tenant: TestTenant): Promise<SeededResources> {
  const ctx: TenantContext = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }

  return runWithTenant(ctx, async () => {
    const imp = imports.create({ name: `${tenant.tenantId}-import`, totalFiles: 1 })

    const product = products.upsert({
      importId: imp.id,
      name: 'Test Product',
      slug: 'test-product',
      folderPath: 'test-product',
      category: null,
    })

    const sourceHash = crypto.createHash('sha256').update(`${tenant.tenantId}-photo`).digest('hex')
    const originalKey = `${sourceHash.slice(0, 2)}/${sourceHash.slice(2, 4)}/${sourceHash}.jpg`
    await writeFileAtomic('originals', originalKey, Buffer.from(`${tenant.tenantId}-original-bytes`))
    const image = images.create({
      productId: product.id,
      importId: imp.id,
      sourceHash,
      storageKey: originalKey,
      fileName: 'photo.jpg',
      relativePath: 'test-product/photo.jpg',
      mimeType: 'image/jpeg',
      byteSize: 12345,
      width: 1200,
      height: 1600,
      exifOrientation: null,
      hasAlpha: false,
      colorSpace: 'srgb',
      capturedAt: null,
      cameraMake: null,
      cameraModel: null,
      position: 0,
      isPrimary: true,
    })
    // 'pending' (the create-time default) is excluded from preview/subjects
    // and anywhere else that only surfaces analysed images — 'ready' makes
    // this fixture visible to those routes' tenancy checks too.
    images.setVisionStatus(image.id, 'ready')

    const template = templates.create({
      name: 'Test Template',
      document: createDefaultTemplate('4:5'),
    })

    const rule = rules.create({
      name: 'Test Rule',
      matchType: 'category',
      operator: 'equals',
      value: 'any',
      templateId: template.id,
      priority: 0,
      isActive: true,
    })

    const batch = batches.create(`${tenant.tenantId}-batch`)

    const creativeKey = `${batch.id}/creative.jpg`
    await writeFileAtomic('creatives', creativeKey, Buffer.from(`${tenant.tenantId}-creative-bytes`))
    const creative = creatives.put({
      productId: product.id,
      imageId: image.id,
      templateId: template.id,
      batchId: batch.id,
      sourceHash,
      visionId: null,
      storageKey: creativeKey,
      mimeType: 'image/jpeg',
      width: 1080,
      height: 1350,
      byteSize: 54321,
      framing: null,
      renderMs: 100,
    })

    return {
      importId: imp.id,
      productId: product.id,
      imageId: image.id,
      sourceHash,
      storageKey: image.storageKey,
      templateId: template.id,
      ruleId: rule.id,
      batchId: batch.id,
      creativeId: creative.id,
    }
  })
}
