import { describe, it, expect } from 'vitest'
import { eligibleForAiExtend, AI_EXTEND_INELIGIBLE_SHOTS } from '@/vision/analysis/shot-type'
import { SHOT_TYPES } from '@/vision/types'

/**
 * Phase 2/3 (docs/ISSUES.md issue 7 — "hanger tilted or line above it in
 * no-model shots"): eligibleForAiExtend is the shot-type gate that was built
 * to stop a hanger/flat-lay/product-only photo from getting generative-fill
 * padding meant for an on-model shot. Both shot types it originally excluded
 * were later removed once real evidence contradicted the original fix —
 * `product_only` on 2026-10-21, `flat_lay` on 2026-10-23 — leaving the list
 * empty. The gate itself stays in the codebase (not deleted) as the one
 * place to re-add a shot type if real evidence ever justifies it again.
 */
describe('eligibleForAiExtend', () => {
  it('does NOT exclude flat_lay (reverted 2026-10-23): same reasoning as product_only, by explicit user request', () => {
    expect(eligibleForAiExtend('flat_lay')).toBe(true)
  })

  it('does NOT exclude product_only (reverted 2026-10-21): a real render batch showed AI Extend working fine on these, while the forced edge-stretch produced a worse duplicated-pixel artifact', () => {
    expect(eligibleForAiExtend('product_only')).toBe(true)
  })

  it('does NOT exclude "detail" — a different no-person shot type where extending the backdrop can be exactly what is wanted', () => {
    expect(eligibleForAiExtend('detail')).toBe(true)
  })

  it('every shot type is currently eligible — AI_EXTEND_INELIGIBLE_SHOTS is empty', () => {
    expect(AI_EXTEND_INELIGIBLE_SHOTS).toEqual([])
    for (const type of SHOT_TYPES) {
      expect(eligibleForAiExtend(type)).toBe(true)
    }
  })

  it('AI_EXTEND_INELIGIBLE_SHOTS contains only real ShotType values', () => {
    for (const type of AI_EXTEND_INELIGIBLE_SHOTS) {
      expect(SHOT_TYPES).toContain(type)
    }
  })
})
