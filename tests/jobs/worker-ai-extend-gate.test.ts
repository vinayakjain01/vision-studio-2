import { describe, it, expect } from 'vitest'
import { resolveEffectiveBackground } from '@/jobs/worker'
import { DEFAULT_BACKGROUND } from '@/templates/types'

/**
 * Phase 2/3 (docs/ISSUES.md issue 7 — "hanger tilted or line above it in
 * no-model shots"): resolveEffectiveBackground is the pure decision behind
 * both handleRenderJob and handleBackgroundFillJob's shot-type gate —
 * downgrading `ai_extend` to `edge_extend` (no network call, no
 * compositing seam) for a shot with no model in frame, regardless of what
 * the template itself is configured to use.
 *
 * `product_only` was removed from the gate (2026-10-21): a real render
 * batch showed AI Extend producing a clean background and a correctly-drawn
 * hanger on these photos, while the forced edge-stretch produced a worse
 * duplicated-pixel artifact than the seam this gate was meant to prevent.
 * `flat_lay` stays gated — no real evidence yet either way for it.
 */
describe('resolveEffectiveBackground', () => {
  const aiExtendBackground = { ...DEFAULT_BACKGROUND, mode: 'ai_extend' as const }

  it('leaves ai_extend unchanged for a product_only shot (reverted 2026-10-21)', () => {
    const result = resolveEffectiveBackground(aiExtendBackground, 'product_only')
    expect(result.mode).toBe('ai_extend')
  })

  it('downgrades ai_extend to edge_extend for a flat_lay shot', () => {
    const result = resolveEffectiveBackground(aiExtendBackground, 'flat_lay')
    expect(result.mode).toBe('edge_extend')
  })

  it('leaves ai_extend unchanged for an on-model shot (no over-rejection)', () => {
    const result = resolveEffectiveBackground(aiExtendBackground, 'full_body')
    expect(result.mode).toBe('ai_extend')
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

  it('preserves every other background field when downgrading (color, prompt, etc.)', () => {
    const background = { ...aiExtendBackground, color: '#abcdef', backdropPrompt: 'a marble floor' }
    const result = resolveEffectiveBackground(background, 'flat_lay')
    expect(result.color).toBe('#abcdef')
    expect(result.backdropPrompt).toBe('a marble floor')
  })

  it('does not mutate the input object', () => {
    const background = { ...aiExtendBackground }
    resolveEffectiveBackground(background, 'flat_lay')
    expect(background.mode).toBe('ai_extend')
  })
})
