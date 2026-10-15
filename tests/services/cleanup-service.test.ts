import { describe, it, expect, beforeEach } from 'vitest'
import { createTestTenant } from '../helpers/tenancy-fixture'
import { runWithTenant } from '@/tenancy/context'
import { imports, products, images } from '@/db/repositories'
import { getControlDb } from '@/db/client'
import { migrateControl } from '@/db/migrate'
import * as queue from '@/jobs/queue'
import { deleteProduct, deleteImport } from '@/services/cleanup-service'

/**
 * Phase 1.5 (docs/ISSUES.md issue 10's bonus finding): deleting a product or
 * import used to leave its images' queued/running jobs behind — orphaned
 * rows pointing at an image that no longer exists, later failing with
 * ENOENT when a worker finally claimed one (confirmed on production: 25
 * such failures for tenant "Noman"). No test ever caught this because no
 * test exercised delete + an in-flight job together — this file is that
 * missing coverage, not just the regression check for the fix.
 */
describe('cleanup-service: deleting a product/import cancels its images\' queued jobs', () => {
  beforeEach(() => {
    migrateControl(getControlDb())
  })

  function seedProductWithImage(tenant: Awaited<ReturnType<typeof createTestTenant>>) {
    const ctx = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' as const }
    return runWithTenant(ctx, () => {
      const imp = imports.create({ name: 'cleanup-test-import' })
      const product = products.upsert({
        importId: imp.id,
        name: 'Cleanup Test Product',
        slug: 'cleanup-test-product',
        folderPath: 'cleanup-test-import/cleanup-test-product',
        category: null,
      })
      const image = images.create({
        productId: product.id,
        importId: imp.id,
        sourceHash: 'cleanuphash' + 'a'.repeat(10),
        storageKey: 'cc/cc/cleanuphash.jpg',
        fileName: 'photo.jpg',
        relativePath: `cleanup-test-import/cleanup-test-product/photo.jpg`,
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
      return { importId: imp.id, productId: product.id, imageId: image.id }
    })
  }

  it('deleteProduct() deletes a PENDING vision job queued for one of its images', async () => {
    const tenant = createTestTenant('CleanupProduct')
    const { productId, imageId } = seedProductWithImage(tenant)

    const { ids } = queue.enqueue(tenant.tenantId, [
      { kind: 'vision', payload: { imageId, sourceHash: 'h1', storageKey: 'k1' } },
    ])
    expect(queue.get(tenant.tenantId, ids[0])).not.toBeNull()

    await runWithTenant({ tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }, () =>
      deleteProduct(productId)
    )

    expect(queue.get(tenant.tenantId, ids[0])).toBeNull()
  })

  it('deleteProduct() deletes a CLAIMED render job and decrements running_jobs', async () => {
    const tenant = createTestTenant('CleanupProductClaimed')
    const { productId, imageId } = seedProductWithImage(tenant)

    const { ids } = queue.enqueue(tenant.tenantId, [
      { kind: 'render', payload: { imageId, productId, templateId: 'tpl1', sourceHash: 'h1' } },
    ])
    const claimed = queue.claim('render', 'worker-1')
    expect(claimed?.id).toBe(ids[0])

    const runningBefore = (
      getControlDb().prepare('SELECT running_jobs FROM tenant_queue_state WHERE tenant_id = ?').get(tenant.tenantId) as
        | { running_jobs: number }
        | undefined
    )?.running_jobs
    expect(runningBefore).toBeGreaterThan(0)

    await runWithTenant({ tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }, () =>
      deleteProduct(productId)
    )

    expect(queue.get(tenant.tenantId, ids[0])).toBeNull()
    const runningAfter = (
      getControlDb().prepare('SELECT running_jobs FROM tenant_queue_state WHERE tenant_id = ?').get(tenant.tenantId) as
        | { running_jobs: number }
        | undefined
    )?.running_jobs
    expect(runningAfter).toBe(0)
  })

  it('deleteProduct() leaves another product\'s jobs untouched', async () => {
    const tenant = createTestTenant('CleanupProductSibling')
    const target = seedProductWithImage(tenant)
    const sibling = seedProductWithImage(tenant)

    const { ids: targetIds } = queue.enqueue(tenant.tenantId, [
      { kind: 'vision', payload: { imageId: target.imageId, sourceHash: 'h1', storageKey: 'k1' } },
    ])
    const { ids: siblingIds } = queue.enqueue(tenant.tenantId, [
      { kind: 'vision', payload: { imageId: sibling.imageId, sourceHash: 'h2', storageKey: 'k2' } },
    ])

    await runWithTenant({ tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }, () =>
      deleteProduct(target.productId)
    )

    expect(queue.get(tenant.tenantId, targetIds[0])).toBeNull()
    expect(queue.get(tenant.tenantId, siblingIds[0])).not.toBeNull()
  })

  it('deleteImport() deletes queued jobs for every image under that import', async () => {
    const tenant = createTestTenant('CleanupImport')
    const { importId, imageId } = seedProductWithImage(tenant)

    const { ids } = queue.enqueue(tenant.tenantId, [
      { kind: 'background_fill', payload: { imageId, productId: 'unused', templateId: 'tpl1', sourceHash: 'h1' } },
    ])

    await runWithTenant({ tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }, () =>
      deleteImport(importId)
    )

    expect(queue.get(tenant.tenantId, ids[0])).toBeNull()
  })

  it('is scoped to its own tenant — never deletes another tenant\'s job even with a matching imageId', async () => {
    const tenantA = createTestTenant('CleanupTenantA')
    const tenantB = createTestTenant('CleanupTenantB')
    const a = seedProductWithImage(tenantA)

    // Deliberately reuse tenant A's imageId as tenant B's job payload — an
    // adversarial case: deleting A's product must never touch B's row even
    // if the (impossible in practice, but not structurally prevented)
    // imageId happened to collide.
    const { ids: bIds } = queue.enqueue(tenantB.tenantId, [
      { kind: 'vision', payload: { imageId: a.imageId, sourceHash: 'h1', storageKey: 'k1' } },
    ])

    await runWithTenant({ tenantId: tenantA.tenantId, userId: tenantA.userId, role: 'owner' }, () =>
      deleteProduct(a.productId)
    )

    expect(queue.get(tenantB.tenantId, bIds[0])).not.toBeNull()
  })
})
