import { describe, it, expect } from 'vitest'
import { needsGroundedFeet } from '@/render/compositor'
import type { Anchor, VisionMetadata } from '@/vision/types'

function anchor(x = 0, y = 0): Anchor {
  return { x, y, confidence: 0.8, source: 'keypoints' }
}

function visionWith(anchors: Partial<VisionMetadata['anchors']>): VisionMetadata {
  return { anchors } as VisionMetadata
}

const OVERFLOW_BOTTOM = { left: 0, top: 0, right: 0, bottom: 10 }
const OVERFLOW_NONE = { left: 0, top: 0, right: 0, bottom: 0 }
const OVERFLOW_TOP_ONLY = { left: 0, top: 10, right: 0, bottom: 0 }

/**
 * Phase 2/3 (docs/ISSUES.md issue 5 — "floating model with head-space
 * padding"): needsGroundedFeet decides whether buildFillPrompt should ask
 * Cloudinary for a grounded contact shadow at the bottom edge.
 */
describe('needsGroundedFeet', () => {
  it('true when the bottom edge is padded and a feet anchor exists', () => {
    expect(needsGroundedFeet(OVERFLOW_BOTTOM, visionWith({ feet: anchor() }))).toBe(true)
  })

  it('true when the bottom edge is padded and only ankle_center exists (feet derivation failed)', () => {
    expect(needsGroundedFeet(OVERFLOW_BOTTOM, visionWith({ ankle_center: anchor() }))).toBe(true)
  })

  it('false when the bottom edge is not padded, even with a confident feet anchor', () => {
    expect(needsGroundedFeet(OVERFLOW_NONE, visionWith({ feet: anchor() }))).toBe(false)
  })

  it('false when only the TOP edge is padded (head-space), not the bottom', () => {
    expect(needsGroundedFeet(OVERFLOW_TOP_ONLY, visionWith({ feet: anchor() }))).toBe(false)
  })

  it('false when the bottom edge is padded but neither feet nor ankle_center exists', () => {
    expect(needsGroundedFeet(OVERFLOW_BOTTOM, visionWith({}))).toBe(false)
  })

  it('false when vision is null (no analysis yet)', () => {
    expect(needsGroundedFeet(OVERFLOW_BOTTOM, null)).toBe(false)
  })
})
