import { describe, it, expect } from 'vitest'
import { createTestTenant, cookieHeader } from '../helpers/tenancy-fixture'
import { makeRequest } from '../helpers/request'
import { runWithTenant } from '@/tenancy/context'
import * as queue from '@/jobs/queue'
import { GET as visionStatusGet } from '@/app/api/vision/status/route'
import { GET as productsGet } from '@/app/api/products/route'

/**
 * Two P4 fixes bundled into one file since they touch the same endpoint:
 *
 *  1. `/api/vision/status`'s `queue` field used to call `queue.stats('vision')`
 *     with no tenantId — harmless before P3 (jobs lived in each tenant's own
 *     DB file, so an unscoped call was automatically tenant-scoped by file
 *     isolation), but after P3 moved jobs into one shared control.db table,
 *     the exact same call started returning every tenant's queue depth
 *     combined. Caught during this phase's audit, not by an existing test.
 *  2. `okWithEtag` — status/progress endpoints should answer 304 (no body)
 *     when nothing has changed since the client's last poll.
 */
describe('status endpoints: tenant-scoped queue counts + ETag/304', () => {
  it('/api/vision/status reports only the caller tenant\'s own queue depth, never another tenant\'s', async () => {
    const busyTenant = createTestTenant('StatusBusyTenant')
    const quietTenant = createTestTenant('StatusQuietTenant')

    // Enqueue real pending jobs for the BUSY tenant only.
    runWithTenant({ tenantId: busyTenant.tenantId, userId: busyTenant.userId, role: 'owner' }, () => {
      queue.enqueue(busyTenant.tenantId, [
        { kind: 'vision', payload: { imageId: 'img-1', sourceHash: 'h1', storageKey: 'k1' } },
        { kind: 'vision', payload: { imageId: 'img-2', sourceHash: 'h2', storageKey: 'k2' } },
      ])
    })

    const quietRequest = makeRequest('http://localhost:3000/api/vision/status', {
      cookie: cookieHeader(quietTenant.sessionToken),
    })
    const quietResponse = await (visionStatusGet as any)(quietRequest)
    const quietBody = await quietResponse.json()

    // The quiet tenant enqueued nothing — it must see zero pending vision
    // jobs, not the busy tenant's 2, even though both rows live in the same
    // shared control.db table.
    expect(quietBody.queue.vision.pending).toBe(0)

    const busyRequest = makeRequest('http://localhost:3000/api/vision/status', {
      cookie: cookieHeader(busyTenant.sessionToken),
    })
    const busyResponse = await (visionStatusGet as any)(busyRequest)
    const busyBody = await busyResponse.json()
    expect(busyBody.queue.vision.pending).toBe(2)
  })

  it('a second request with a matching If-None-Match gets a 304 with no body; a changed response gets a fresh ETag', async () => {
    const tenant = createTestTenant('StatusEtag')

    const first = await (visionStatusGet as any)(
      makeRequest('http://localhost:3000/api/vision/status', { cookie: cookieHeader(tenant.sessionToken) })
    )
    expect(first.status).toBe(200)
    const etag = first.headers.get('etag')
    expect(etag).toBeTruthy()

    const second = await (visionStatusGet as any)(
      makeRequest('http://localhost:3000/api/vision/status', {
        cookie: cookieHeader(tenant.sessionToken),
        headers: { 'if-none-match': etag! },
      })
    )
    expect(second.status).toBe(304)
    const secondBody = await second.text()
    expect(secondBody).toBe('')

    // Change this tenant's state, then confirm the ETag actually changes —
    // proof it's a real content hash, not a constant.
    runWithTenant({ tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }, () => {
      queue.enqueue(tenant.tenantId, [
        { kind: 'vision', payload: { imageId: 'img-x', sourceHash: 'hx', storageKey: 'kx' } },
      ])
    })

    const third = await (visionStatusGet as any)(
      makeRequest('http://localhost:3000/api/vision/status', {
        cookie: cookieHeader(tenant.sessionToken),
        headers: { 'if-none-match': etag! },
      })
    )
    expect(third.status).toBe(200)
    expect(third.headers.get('etag')).not.toBe(etag)
  })

  it('/api/products also answers 304 on a matching If-None-Match', async () => {
    const tenant = createTestTenant('ProductsEtag')
    const first = await (productsGet as any)(
      makeRequest('http://localhost:3000/api/products', { cookie: cookieHeader(tenant.sessionToken) })
    )
    expect(first.status).toBe(200)
    const etag = first.headers.get('etag')
    expect(etag).toBeTruthy()

    const second = await (productsGet as any)(
      makeRequest('http://localhost:3000/api/products', {
        cookie: cookieHeader(tenant.sessionToken),
        headers: { 'if-none-match': etag! },
      })
    )
    expect(second.status).toBe(304)
  })
})
