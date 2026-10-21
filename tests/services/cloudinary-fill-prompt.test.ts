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
})
