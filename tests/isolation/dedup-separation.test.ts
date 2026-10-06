import { describe, it, expect } from 'vitest'
import { createTestTenant } from '../helpers/tenancy-fixture'
import { runWithTenant } from '@/tenancy/context'
import { putOriginal, mediaExists, deleteMedia, readMedia } from '@/storage/media-store'

/**
 * P2 #6: identical bytes uploaded by two tenants must be stored separately
 * — `putOriginal` content-addresses by sha256, and that hash is computed
 * the same way regardless of who uploads, so the only thing that can keep
 * two tenants' copies apart is the tenant root the key is resolved under
 * (`media-store.ts`'s `roots()`, keyed by `currentTenant()`). This proves
 * that's actually happening, not just architecturally implied.
 */
describe('per-tenant dedup separation', () => {
  it('stores identical bytes separately per tenant and keeps deletes scoped', async () => {
    const a = createTestTenant('Tenant A')
    const b = createTestTenant('Tenant B')

    const bytes = Buffer.from('identical-photo-bytes-' + 'x'.repeat(500))

    const resultA = await runWithTenant({ tenantId: a.tenantId, userId: a.userId, role: 'owner' }, () =>
      putOriginal(bytes, 'image/jpeg')
    )
    const resultB = await runWithTenant({ tenantId: b.tenantId, userId: b.userId, role: 'owner' }, () =>
      putOriginal(bytes, 'image/jpeg')
    )

    // Same content hash (it's a pure function of the bytes) ...
    expect(resultA.hash).toBe(resultB.hash)
    expect(resultA.key).toBe(resultB.key)
    // ... but neither tenant saw the other's copy as already present.
    expect(resultA.deduplicated).toBe(false)
    expect(resultB.deduplicated).toBe(false)

    // Both files actually exist on disk, independently, under each tenant's
    // own root — not the same file visible from both contexts.
    const existsForA = await runWithTenant({ tenantId: a.tenantId, userId: a.userId, role: 'owner' }, () =>
      mediaExists('originals', resultA.key)
    )
    const existsForB = await runWithTenant({ tenantId: b.tenantId, userId: b.userId, role: 'owner' }, () =>
      mediaExists('originals', resultB.key)
    )
    expect(existsForA).toBe(true)
    expect(existsForB).toBe(true)

    // Deleting tenant A's copy must not touch tenant B's.
    await runWithTenant({ tenantId: a.tenantId, userId: a.userId, role: 'owner' }, () =>
      deleteMedia('originals', resultA.key)
    )

    const stillExistsForB = await runWithTenant({ tenantId: b.tenantId, userId: b.userId, role: 'owner' }, () =>
      mediaExists('originals', resultB.key)
    )
    expect(stillExistsForB).toBe(true)

    const bBytes = await runWithTenant({ tenantId: b.tenantId, userId: b.userId, role: 'owner' }, () =>
      readMedia('originals', resultB.key)
    )
    expect(bBytes.equals(bytes)).toBe(true)

    const existsForAAfterDelete = await runWithTenant(
      { tenantId: a.tenantId, userId: a.userId, role: 'owner' },
      () => mediaExists('originals', resultA.key)
    )
    expect(existsForAAfterDelete).toBe(false)
  })
})
