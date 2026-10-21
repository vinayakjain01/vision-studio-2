import { describe, it, expect, vi, afterEach } from 'vitest'
import sharp from 'sharp'
import { encodeWithinSizeBudget } from '@/render/export-image'
import { config } from '@/config'

/**
 * Phase 2/3 (docs/ISSUES.md issue 9 — WebP download 502 Bad Gateway).
 * `encodeWithinSizeBudget`'s binary search naturally converges in ~7
 * sequential full-resolution encodes — markedly more expensive for WebP
 * than JPEG at comparable settings, and confirmed (via the nginx 502
 * screenshot plus the export code's own structure) as a plausible timeout
 * cause under concurrent bulk-ZIP load. These tests verify the actual
 * bound, by spying on real sharp encode calls, not by trusting the loop's
 * own logic to behave as intended.
 */
describe('encodeWithinSizeBudget', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function fixture(): Promise<Buffer> {
    return sharp({
      create: { width: 800, height: 1000, channels: 3, background: { r: 120, g: 140, b: 160 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer()
  }

  it('caps WebP encode attempts at 1 (the quality=1 floor) + webpSizeBudgetMaxIterations, even under a budget tight enough to force a full search', async () => {
    const webpSpy = vi.spyOn(sharp.prototype, 'webp')
    const bytes = await fixture()

    // An unreasonably tight budget that nothing but quality=1 can satisfy —
    // forces the search to explore the full low end of the range, the
    // worst case for iteration count.
    await encodeWithinSizeBudget(sharp(bytes), 'webp', 1)

    expect(webpSpy.mock.calls.length).toBeLessThanOrEqual(1 + config.render.webpSizeBudgetMaxIterations)
  })

  it('JPEG is NOT capped by the WebP limit — still converges naturally (not artificially truncated)', async () => {
    const jpegSpy = vi.spyOn(sharp.prototype, 'jpeg')
    const bytes = await fixture()

    await encodeWithinSizeBudget(sharp(bytes), 'jpeg', 1)

    // Natural binary-search convergence over 1-100 is at most 7 iterations
    // + the quality=1 floor encode — well above webpSizeBudgetMaxIterations
    // (4 by default), proving JPEG's own cap (7) is not the WebP one.
    expect(jpegSpy.mock.calls.length).toBeGreaterThan(1 + config.render.webpSizeBudgetMaxIterations)
    expect(jpegSpy.mock.calls.length).toBeLessThanOrEqual(8)
  })

  it('still returns a real, valid, non-empty image even when the search is capped before full convergence', async () => {
    const bytes = await fixture()
    const result = await encodeWithinSizeBudget(sharp(bytes), 'webp', 1)

    expect(result.length).toBeGreaterThan(0)
    const meta = await sharp(result).metadata()
    expect(meta.format).toBe('webp')
  })

  it('a generous budget that quality=1 already satisfies still returns quickly without needing the full search', async () => {
    const webpSpy = vi.spyOn(sharp.prototype, 'webp')
    const bytes = await fixture()

    // Budget so large even the lowest quality is instantly accepted and the
    // search climbs toward 100 — still bounded the same way.
    await encodeWithinSizeBudget(sharp(bytes), 'webp', 50 * 1024 * 1024)

    expect(webpSpy.mock.calls.length).toBeLessThanOrEqual(1 + config.render.webpSizeBudgetMaxIterations)
  })
})
