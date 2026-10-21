import { describe, it, expect } from 'vitest'
import { eligibleForAiExtend, AI_EXTEND_INELIGIBLE_SHOTS } from '@/vision/analysis/shot-type'
import { SHOT_TYPES } from '@/vision/types'

/**
 * Phase 2/3 (docs/ISSUES.md issue 7 — "hanger tilted or line above it in
 * no-model shots"): eligibleForAiExtend is the shot-type gate that stops a
 * hanger/flat-lay/product-only photo from getting generative-fill padding
 * meant for an on-model shot.
 */
describe('eligibleForAiExtend', () => {
  it('excludes flat_lay', () => {
    expect(eligibleForAiExtend('flat_lay')).toBe(false)
  })

  it('does NOT exclude product_only (reverted 2026-10-21): a real render batch showed AI Extend working fine on these, while the forced edge-stretch produced a worse duplicated-pixel artifact', () => {
    expect(eligibleForAiExtend('product_only')).toBe(true)
  })

  it('does NOT exclude "detail" — a different no-person shot type where extending the backdrop can be exactly what is wanted', () => {
    expect(eligibleForAiExtend('detail')).toBe(true)
  })

  it('every on-model shot type remains eligible', () => {
    for (const type of SHOT_TYPES) {
      if (AI_EXTEND_INELIGIBLE_SHOTS.includes(type)) continue
      expect(eligibleForAiExtend(type)).toBe(true)
    }
  })

  it('AI_EXTEND_INELIGIBLE_SHOTS contains only real ShotType values', () => {
    for (const type of AI_EXTEND_INELIGIBLE_SHOTS) {
      expect(SHOT_TYPES).toContain(type)
    }
  })
})
