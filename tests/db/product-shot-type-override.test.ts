import { describe, it, expect } from 'vitest'
import { createTestTenant } from '../helpers/tenancy-fixture'
import { runWithTenant, type TenantContext } from '@/tenancy/context'
import { imports, products } from '@/db/repositories'

/**
 * User request (2026-10-27): a colorway/collage sheet (several garments in
 * one photo, e.g. a 2x2 grid of "Maroon / Olive / Navy / Black") gets a
 * different shot-type guess per sheet even though, to a human, every sheet
 * in the folder is the same kind of asset — so the same framing rule crops
 * them inconsistently. The fix is a per-product override: pick one of the
 * existing shot-type labels for the whole folder, which every downstream
 * consumer (framing, AI-Extend eligibility, the Products badge) then uses
 * instead of each photo's own detected type. Default is empty — unchanged,
 * auto-detected behaviour — until someone explicitly sets it.
 */
async function seedProduct(tenant: Awaited<ReturnType<typeof createTestTenant>>) {
  const ctx: TenantContext = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }
  return runWithTenant(ctx, async () => {
    const imp = imports.create({ name: 'override-test-import' })
    return products.upsert({
      importId: imp.id,
      name: 'Color',
      slug: 'color',
      folderPath: 'color',
      category: null,
    })
  })
}

describe('products.setShotTypeOverride', () => {
  it('defaults to no override — auto-detection, unchanged from today', async () => {
    const tenant = await createTestTenant('ShotOverrideDefault')
    const product = await seedProduct(tenant)
    const ctx: TenantContext = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }

    await runWithTenant(ctx, async () => {
      expect(products.get(product.id)?.shotTypeOverride).toBeNull()
    })
  })

  it('sets an override that a subsequent read reflects', async () => {
    const tenant = await createTestTenant('ShotOverrideSet')
    const product = await seedProduct(tenant)
    const ctx: TenantContext = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }

    await runWithTenant(ctx, async () => {
      products.setShotTypeOverride(product.id, 'flat_lay')
      expect(products.get(product.id)?.shotTypeOverride).toBe('flat_lay')
    })
  })

  it('clears an override back to null (auto-detect) when set to null', async () => {
    const tenant = await createTestTenant('ShotOverrideClear')
    const product = await seedProduct(tenant)
    const ctx: TenantContext = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }

    await runWithTenant(ctx, async () => {
      products.setShotTypeOverride(product.id, 'flat_lay')
      products.setShotTypeOverride(product.id, null)
      expect(products.get(product.id)?.shotTypeOverride).toBeNull()
    })
  })
})
