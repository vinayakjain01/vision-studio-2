import { describe, it, expect } from 'vitest'
import { resolveEffectiveBackground } from '@/jobs/worker'
import { DEFAULT_BACKGROUND } from '@/templates/types'
import { SHOT_TYPES } from '@/vision/types'

/**
 * Phase 2/3 (docs/ISSUES.md issue 7 — "hanger tilted or line above it in
 * no-model shots"): resolveEffectiveBackground is the pure decision behind
 * both handleRenderJob and handleBackgroundFillJob's shot-type gate —
 * downgrading `ai_extend` to `edge_extend` (no network call, no compositing
 * seam) for a shot type `eligibleForAiExtend` says is ineligible.
 *
 * Both shot types this gate originally excluded were later removed once
 * real evidence contradicted the original fix — `product_only` on
 * 2026-10-21, `flat_lay` on 2026-10-23, by explicit user request — leaving
 * `AI_EXTEND_INELIGIBLE_SHOTS` empty. The downgrade branch below is kept in
 * the code (not deleted) for the next shot type real evidence justifies
 * excluding, but there is currently no real `ShotType` that exercises it —
 * these tests reflect that honestly rather than asserting a downgrade this
 * function can't currently produce.
 */
describe('resolveEffectiveBackground', () => {
  const aiExtendBackground = { ...DEFAULT_BACKGROUND, mode: 'ai_extend' as const }

  it('leaves ai_extend unchanged for every real shot type — AI_EXTEND_INELIGIBLE_SHOTS is currently empty', () => {
    for (const type of SHOT_TYPES) {
      const result = resolveEffectiveBackground(aiExtendBackground, type)
      expect(result.mode).toBe('ai_extend')
    }
  })

  it('leaves ai_extend unchanged when the shot type is unknown/not yet analyzed — never downgrade on absent evidence', () => {
    const result = resolveEffectiveBackground(aiExtendBackground, undefined)
    expect(result.mode).toBe('ai_extend')
  })

  it('never touches a non-ai_extend background, regardless of shot type', () => {
    const solidBackground = { ...DEFAULT_BACKGROUND, mode: 'solid' as const }
    const result = resolveEffectiveBackground(solidBackground, 'flat_lay')
    expect(result.mode).toBe('solid')
  })

  it('returns the exact same object (no copy) when nothing changes — the common case', () => {
    const result = resolveEffectiveBackground(aiExtendBackground, 'full_body')
    expect(result).toBe(aiExtendBackground)
  })

  it('does not mutate the input object', () => {
    const background = { ...aiExtendBackground }
    resolveEffectiveBackground(background, 'flat_lay')
    expect(background.mode).toBe('ai_extend')
  })
})
