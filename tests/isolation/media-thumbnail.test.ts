import { describe, it, expect, beforeAll } from 'vitest'
import sharp from 'sharp'
import { createTestTenant, cookieHeader, type TestTenant } from '../helpers/tenancy-fixture'
import { makeRequest, makeParams } from '../helpers/request'
import { GET as mediaGet } from '@/app/api/media/[root]/[...key]/route'
import { runWithTenant, type TenantContext } from '@/tenancy/context'
import { writeFileAtomic, originalKey } from '@/storage/media-store'

/**
 * `?thumb=1` end to end through the real route (not just `ensureThumbnail`
 * directly — see tests/storage/thumbnail.test.ts for that) — confirms the
 * route actually serves the smaller cached file, with correct headers, and
 * that requesting it never crosses a tenant boundary (the same real concern
 * media-cross-tenant.test.ts covers for the plain-original case).
 */
describe('media route: ?thumb=1', () => {
  let tenant: TestTenant
  let storageKey: string

  beforeAll(async () => {
    tenant = createTestTenant('Thumb Tenant')
    const ctx: TenantContext = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }
    storageKey = originalKey('f'.repeat(64), 'image/jpeg')

    await runWithTenant(ctx, async () => {
      const bytes = await sharp({
        create: { width: 3000, height: 4000, channels: 3, background: { r: 10, g: 200, b: 100 } },
      })
        .jpeg({ quality: 95 })
        .toBuffer()
      await writeFileAtomic('originals', storageKey, bytes)
    })
  })

  function get(thumb: boolean) {
    const url = `http://localhost:3000/api/media/x${thumb ? '?thumb=1' : ''}`
    const request = makeRequest(url, { cookie: cookieHeader(tenant.sessionToken) })
    return mediaGet(request, makeParams({ root: 'originals', key: storageKey.split('/') }))
  }

  it('serves a dramatically smaller file than the plain original', async () => {
    const full = await get(false)
    const thumb = await get(true)

    expect(full.status).toBe(200)
    expect(thumb.status).toBe(200)

    const fullBytes = Buffer.from(await full.arrayBuffer())
    const thumbBytes = Buffer.from(await thumb.arrayBuffer())

    expect(thumbBytes.byteLength).toBeLessThan(fullBytes.byteLength / 4)
  })

  it('is still a valid, correctly-oriented JPEG at the expected width', async () => {
    const res = await get(true)
    const bytes = Buffer.from(await res.arrayBuffer())
    const meta = await sharp(bytes).metadata()

    expect(meta.format).toBe('jpeg')
    expect(meta.width).toBeLessThanOrEqual(640)
    expect(meta.width! / meta.height!).toBeCloseTo(3000 / 4000, 1)
  })

  it('serves it with the same immutable long-lived cache-control as any other content-addressed derived asset', async () => {
    const res = await get(true)
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
  })

  it('a second request for the same thumbnail returns 304 against its own ETag', async () => {
    const first = await get(true)
    const etag = first.headers.get('etag')
    expect(etag).toBeTruthy()

    const url = `http://localhost:3000/api/media/x?thumb=1`
    const request = makeRequest(url, {
      cookie: cookieHeader(tenant.sessionToken),
      headers: { 'if-none-match': etag! },
    })
    const second = await mediaGet(request, makeParams({ root: 'originals', key: storageKey.split('/') }))

    expect(second.status).toBe(304)
  })

  it('the full-original and thumbnail requests have DIFFERENT ETags from each other', async () => {
    const full = await get(false)
    const thumb = await get(true)
    expect(full.headers.get('etag')).not.toBe(thumb.headers.get('etag'))
  })

  it('an unauthenticated thumbnail request is still rejected before any file access', async () => {
    const url = `http://localhost:3000/api/media/x?thumb=1`
    const request = makeRequest(url)
    const res = await mediaGet(request, makeParams({ root: 'originals', key: storageKey.split('/') }))
    expect(res.status).toBe(401)
  })
})
