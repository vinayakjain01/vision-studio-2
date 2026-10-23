import { describe, it, expect } from 'vitest'
import { buildFillPrompt } from '@/services/cloudinary-service'
import type { EdgeContent } from '@/render/boundary-classify'

const NO_EDGES: EdgeContent = { top: null, left: null, right: null, bottom: null }

describe('buildFillPrompt', () => {
  it('returns the base prompt unchanged with no garment edges and no grounding needed', () => {
    const prompt = buildFillPrompt('a plain studio backdrop', NO_EDGES)
    expect(prompt).toBe('a plain studio backdrop')
  })

  it('falls back to the generic default when no base prompt is given', () => {
    const prompt = buildFillPrompt(undefined, NO_EDGES)
    expect(prompt.length).toBeGreaterThan(0)
    expect(prompt).not.toBe('')
  })

  it('appends the garment-continuation clause for an edge classified as garment', () => {
    const prompt = buildFillPrompt('backdrop', { ...NO_EDGES, bottom: 'garment' })
    expect(prompt).toContain('backdrop')
    expect(prompt).toContain('garment fabric')
    expect(prompt).toContain('bottom')
  })

  /**
   * Phase 2/3 (docs/ISSUES.md issue 5 — "floating model with head-space
   * padding"): the grounding clause is the actual fix — telling Cloudinary
   * explicitly where the feet are and asking for a contact shadow, instead
   * of the previous generic "continue backdrop" instruction with no
   * floor/feet awareness at all.
   */
  it('appends a grounding clause when groundFeet is true', () => {
    const prompt = buildFillPrompt('backdrop', NO_EDGES, true)
    expect(prompt).toContain('backdrop')
    expect(prompt).toContain('contact shadow')
    expect(prompt).toContain('floor')
  })

  it('does not append the grounding clause when groundFeet is false (default)', () => {
    const prompt = buildFillPrompt('backdrop', NO_EDGES)
    expect(prompt).not.toContain('contact shadow')
  })

  it('combines the garment and grounding clauses when both apply, without one overwriting the other', () => {
    const prompt = buildFillPrompt('backdrop', { ...NO_EDGES, bottom: 'garment' }, true)
    expect(prompt).toContain('garment fabric')
    expect(prompt).toContain('contact shadow')
  })

  it('the composed prompt contains none of the punctuation sanitizePrompt would otherwise strip, for either clause', () => {
    const withGarment = buildFillPrompt('backdrop', { ...NO_EDGES, left: 'garment', bottom: 'garment' }, true)
    expect(withGarment).not.toMatch(/[,;:/|.()[\]{}]/)
  })

  it('a different groundFeet value changes the resulting prompt string — this is what makes the AI-Extend cache key (aiExtendCacheKind) correctly vary with it too', () => {
    const without = buildFillPrompt('backdrop', NO_EDGES, false)
    const withGrounding = buildFillPrompt('backdrop', NO_EDGES, true)
    expect(without).not.toBe(withGrounding)
  })

  /**
   * Phase 2/3 (docs/ISSUES.md issue 14 follow-up, 2026-10-23): user
   * explicitly chose to keep spending a real Cloudinary credit on a
   * garment-only overflow (for the better pattern/embroidery/drape match
   * generation can produce) rather than the deterministic edge_extend
   * fallback, provided the prompt is as strong as possible against
   * generating a body part. `garmentOnly` replaces the base prompt entirely
   * rather than appending to it — no "continue the backdrop" language
   * anywhere, since there is no backdrop in this case at all.
   */
  describe('garmentOnly', () => {
    it('ignores the base/template prompt entirely and never mentions backdrop', () => {
      const prompt = buildFillPrompt('a sunlit marble backdrop', { ...NO_EDGES, bottom: 'garment' }, false, true)
      expect(prompt).not.toContain('backdrop')
      expect(prompt).not.toContain('marble')
    })

    it('explicitly rules out every kind of body part, not just skin and limbs', () => {
      const prompt = buildFillPrompt(undefined, { ...NO_EDGES, bottom: 'garment' }, false, true)
      expect(prompt).toContain('person')
      expect(prompt).toContain('body')
      expect(prompt).toContain('skin')
      expect(prompt).toContain('limb')
      expect(prompt).toContain('hand')
      expect(prompt).toContain('foot')
    })

    it('asks for the pattern, embroidery and drape to continue, not just plain fabric', () => {
      const prompt = buildFillPrompt(undefined, { ...NO_EDGES, bottom: 'garment' }, false, true)
      expect(prompt).toContain('embroidery')
      expect(prompt).toContain('pattern')
      expect(prompt).toContain('drape')
    })

    it('contains no punctuation sanitizePrompt would otherwise strip', () => {
      const prompt = buildFillPrompt(undefined, { ...NO_EDGES, bottom: 'garment' }, false, true)
      expect(prompt).not.toMatch(/[,;:/|.()[\]{}]/)
    })

    it('produces a different prompt string than the non-garmentOnly path for the same edges — a different AI-Extend cache entry', () => {
      const edges: EdgeContent = { ...NO_EDGES, bottom: 'garment' }
      const normal = buildFillPrompt('backdrop', edges, false, false)
      const garmentOnly = buildFillPrompt('backdrop', edges, false, true)
      expect(normal).not.toBe(garmentOnly)
    })

    it('ignores groundFeet when garmentOnly is true — there is no floor to ground against in an all-garment region', () => {
      const prompt = buildFillPrompt(undefined, { ...NO_EDGES, bottom: 'garment' }, true, true)
      expect(prompt).not.toContain('contact shadow')
    })
  })
})
