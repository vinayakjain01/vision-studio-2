import { describe, it, expect } from 'vitest'
import { createTestTenant, cookieHeader } from '../helpers/tenancy-fixture'
import { makeRequest, makeParams } from '../helpers/request'
import { runWithTenant, type TenantContext } from '@/tenancy/context'
import { imports, products } from '@/db/repositories'
import { POST as postOverrideImpl } from '@/app/api/products/[productId]/shot-type-override/route'

const postOverride = postOverrideImpl as unknown as (...args: unknown[]) => Promise<Response>

async function seedProduct(tenant: Awaited<ReturnType<typeof createTestTenant>>) {
  const ctx: TenantContext = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }
  return runWithTenant(ctx, async () => {
    const imp = imports.create({ name: 'override-api-import' })
    return products.upsert({
      importId: imp.id,
      name: 'Color',
      slug: 'color',
      folderPath: 'color',
      category: null,
    })
  })
}

describe('POST /api/products/[productId]/shot-type-override', () => {
  it('sets the override and persists it', async () => {
    const tenant = await createTestTenant('OverrideApiSet')
    const product = await seedProduct(tenant)

    const res = await postOverride(
      makeRequest(`http://localhost:3000/api/products/${product.id}/shot-type-override`, {
        method: 'POST',
        cookie: cookieHeader(tenant.sessionToken),
        json: { shotType: 'flat_lay' },
      }),
      makeParams({ productId: product.id })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.shotTypeOverride).toBe('flat_lay')

    const ctx: TenantContext = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }
    await runWithTenant(ctx, async () => {
      expect(products.get(product.id)?.shotTypeOverride).toBe('flat_lay')
    })
  })

  it('clears the override when shotType is null', async () => {
    const tenant = await createTestTenant('OverrideApiClear')
    const product = await seedProduct(tenant)
    const ctx: TenantContext = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }
    await runWithTenant(ctx, async () => products.setShotTypeOverride(product.id, 'flat_lay'))

    const res = await postOverride(
      makeRequest(`http://localhost:3000/api/products/${product.id}/shot-type-override`, {
        method: 'POST',
        cookie: cookieHeader(tenant.sessionToken),
        json: { shotType: null },
      }),
      makeParams({ productId: product.id })
    )
    expect(res.status).toBe(200)

    await runWithTenant(ctx, async () => {
      expect(products.get(product.id)?.shotTypeOverride).toBeNull()
    })
  })

  it('rejects a shotType that is not a real shot type', async () => {
    const tenant = await createTestTenant('OverrideApiInvalid')
    const product = await seedProduct(tenant)

    const res = await postOverride(
      makeRequest(`http://localhost:3000/api/products/${product.id}/shot-type-override`, {
        method: 'POST',
        cookie: cookieHeader(tenant.sessionToken),
        json: { shotType: 'not_a_real_shot_type' },
      }),
      makeParams({ productId: product.id })
    )
    expect(res.status).toBe(400)
  })

  it('404s for a product that does not exist', async () => {
    const tenant = await createTestTenant('OverrideApiMissing')

    const res = await postOverride(
      makeRequest('http://localhost:3000/api/products/prd_missing/shot-type-override', {
        method: 'POST',
        cookie: cookieHeader(tenant.sessionToken),
        json: { shotType: 'flat_lay' },
      }),
      makeParams({ productId: 'prd_missing' })
    )
    expect(res.status).toBe(404)
  })

  it('401s without a session', async () => {
    const tenant = await createTestTenant('OverrideApiAuth')
    const product = await seedProduct(tenant)

    const res = await postOverride(
      makeRequest(`http://localhost:3000/api/products/${product.id}/shot-type-override`, {
        method: 'POST',
        json: { shotType: 'flat_lay' },
      }),
      makeParams({ productId: product.id })
    )
    expect(res.status).toBe(401)
  })
})
