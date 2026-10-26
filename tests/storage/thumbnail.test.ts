import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { createTestTenant } from '../helpers/tenancy-fixture'
import { runWithTenant, type TenantContext } from '@/tenancy/context'
import { writeFileAtomic, mediaExists, readMedia, originalKey, derivedKey } from '@/storage/media-store'
import { ensureThumbnail } from '@/storage/thumbnail'

/**
 * Phase 2/3 (user-reported: the Products page "stuck" loading thumbnails —
 * every grid card and photo-strip thumbnail was downloading the full
 * original upload, several thousand pixels and several megabytes on a real
 * photo, to render a few hundred CSS pixels). `ensureThumbnail` is the fix:
 * a small cached JPEG, generated once per photo and reused from then on.
 */

function makeTenantCtx(name: string): TenantContext {
  const tenant = createTestTenant(name)
  return { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }
}

async function makeRealJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 160, b: 200 } },
  })
    .jpeg()
    .toBuffer()
}

describe('ensureThumbnail', () => {
  it('generates and caches a smaller JPEG for a real original, well under its own size', async () => {
    const ctx = makeTenantCtx('thumb-basic')
    await runWithTenant(ctx, async () => {
      const bytes = await makeRealJpeg(2000, 3000)
      const hash = 'a'.repeat(64)
      const key = originalKey(hash, 'image/jpeg')
      await writeFileAtomic('originals', key, bytes)

      const thumbKey = await ensureThumbnail('originals', key)

      expect(thumbKey).not.toBeNull()
      expect(await mediaExists('derived', thumbKey!)).toBe(true)

      const thumbBytes = await readMedia('derived', thumbKey!)
      expect(thumbBytes.byteLength).toBeLessThan(bytes.byteLength)

      const meta = await sharp(thumbBytes).metadata()
      expect(meta.width).toBeLessThanOrEqual(640)
      // Aspect ratio preserved (2000x3000 is 2:3).
      expect(meta.width! / meta.height!).toBeCloseTo(2000 / 3000, 1)
    })
  })

  it('reuses the cached thumbnail on a second call instead of regenerating it', async () => {
    const ctx = makeTenantCtx('thumb-cache')
    await runWithTenant(ctx, async () => {
      const bytes = await makeRealJpeg(1000, 1000)
      const hash = 'b'.repeat(64)
      const key = originalKey(hash, 'image/jpeg')
      await writeFileAtomic('originals', key, bytes)

      const first = await ensureThumbnail('originals', key)
      const firstBytes = await readMedia('derived', first!)

      const second = await ensureThumbnail('originals', key)

      expect(second).toBe(first)
      const secondBytes = await readMedia('derived', second!)
      expect(secondBytes.equals(firstBytes)).toBe(true)
    })
  })

  it('does not enlarge a source already smaller than the thumbnail width', async () => {
    const ctx = makeTenantCtx('thumb-small-source')
    await runWithTenant(ctx, async () => {
      const bytes = await makeRealJpeg(200, 300)
      const hash = 'c'.repeat(64)
      const key = originalKey(hash, 'image/jpeg')
      await writeFileAtomic('originals', key, bytes)

      const thumbKey = await ensureThumbnail('originals', key)
      const thumbBytes = await readMedia('derived', thumbKey!)
      const meta = await sharp(thumbBytes).metadata()

      expect(meta.width).toBeLessThanOrEqual(200)
    })
  })

  it('returns null for a non-originals root without attempting anything', async () => {
    const ctx = makeTenantCtx('thumb-wrong-root')
    await runWithTenant(ctx, async () => {
      const result = await ensureThumbnail('derived', derivedKey('d'.repeat(64), 'person_mask', 'png'))
      expect(result).toBeNull()
    })
  })

  it('returns null, never throws, for a key that does not decode as an image', async () => {
    const ctx = makeTenantCtx('thumb-corrupt')
    await runWithTenant(ctx, async () => {
      const hash = 'e'.repeat(64)
      const key = originalKey(hash, 'image/jpeg')
      await writeFileAtomic('originals', key, Buffer.from('not actually a jpeg'))

      const result = await ensureThumbnail('originals', key)

      expect(result).toBeNull()
    })
  })

  it('returns null for a key whose basename is not a real content hash', async () => {
    const ctx = makeTenantCtx('thumb-bad-key')
    await runWithTenant(ctx, async () => {
      const result = await ensureThumbnail('originals', 'not/a/real/hash.jpg')
      expect(result).toBeNull()
    })
  })
})
