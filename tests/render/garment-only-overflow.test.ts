import { describe, it, expect } from 'vitest'
import { isGarmentOnlyOverflow } from '@/render/compositor'
import type { EdgeContent } from '@/render/boundary-classify'

/**
 * Phase 2/3 (docs/ISSUES.md — "it should not generate the legs, it should
 * extend the garment only"): a real production photo (a floor-length velvet
 * kaftan, `hemCropped: true`, hem at the source image's exact bottom edge)
 * had its overflowing bottom edge correctly classified `garment` and the
 * fill prompt correctly told Cloudinary not to generate body parts there —
 * confirmed with the real masks and the real solver output, not assumed
 * (`scripts/_verify-kaftan-fill.ts`). Cloudinary's generative model still
 * sometimes drew legs anyway. `isGarmentOnlyOverflow` is the gate that lets
 * `handleRenderJob`/`handleBackgroundFillJob` skip the generative call
 * entirely in exactly this case, stretching the real fabric pixels instead —
 * a guarantee instead of a probability.
 */

const NO_OVERFLOW = { top: 0, left: 0, right: 0, bottom: 0 }

describe('isGarmentOnlyOverflow', () => {
  it('is true when the only overflowing edge (bottom) is garment', () => {
    const overflow = { ...NO_OVERFLOW, bottom: 533.9 }
    const edges: EdgeContent = { top: null, left: null, right: null, bottom: 'garment' }
    expect(isGarmentOnlyOverflow(overflow, edges)).toBe(true)
  })

  it('is false when there is no overflow at all', () => {
    const edges: EdgeContent = { top: null, left: null, right: null, bottom: null }
    expect(isGarmentOnlyOverflow(NO_OVERFLOW, edges)).toBe(false)
  })

  it('is false when the overflowing edge is background (a real backdrop to generate)', () => {
    const overflow = { ...NO_OVERFLOW, top: 100 }
    const edges: EdgeContent = { top: 'background', left: null, right: null, bottom: null }
    expect(isGarmentOnlyOverflow(overflow, edges)).toBe(false)
  })

  it('is false when the overflowing edge is skin (a body part genuinely continues there)', () => {
    const overflow = { ...NO_OVERFLOW, bottom: 200 }
    const edges: EdgeContent = { top: null, left: null, right: null, bottom: 'skin' }
    expect(isGarmentOnlyOverflow(overflow, edges)).toBe(false)
  })

  it('is false for a MIXED case — one overflowing edge is garment, another is background', () => {
    const overflow = { top: 50, left: 0, right: 0, bottom: 300 }
    const edges: EdgeContent = { top: 'background', left: null, right: null, bottom: 'garment' }
    expect(isGarmentOnlyOverflow(overflow, edges)).toBe(false)
  })

  it('is true when multiple overflowing edges are ALL garment', () => {
    const overflow = { top: 0, left: 80, right: 80, bottom: 300 }
    const edges: EdgeContent = { top: null, left: 'garment', right: 'garment', bottom: 'garment' }
    expect(isGarmentOnlyOverflow(overflow, edges)).toBe(true)
  })

  it('is false when an overflowing edge was never classified (null — no mask evidence)', () => {
    const overflow = { ...NO_OVERFLOW, bottom: 300 }
    const edges: EdgeContent = { top: null, left: null, right: null, bottom: null }
    expect(isGarmentOnlyOverflow(overflow, edges)).toBe(false)
  })

  it('ignores a non-overflowing edge even if it happens to be classified something else', () => {
    // Only bottom overflows; top is classified but irrelevant since it has no padding to fill.
    const overflow = { ...NO_OVERFLOW, bottom: 300 }
    const edges: EdgeContent = { top: 'skin', left: null, right: null, bottom: 'garment' }
    expect(isGarmentOnlyOverflow(overflow, edges)).toBe(true)
  })
})
