import { describe, it, expect } from 'vitest'
import { isValidHexColor, sanitizeBackgroundColor, DEFAULT_BACKGROUND } from '@/templates/types'

/**
 * Phase 2/3 (docs/ISSUES.md issue 3 — "black bars top/bottom"). An invalid
 * or empty `background.color` reaching Canvas2D's `fillStyle` silently
 * paints black (confirmed directly against @napi-rs/canvas — an invalid
 * assignment keeps the PREVIOUS value, which defaults to black on a fresh
 * context). These two functions are the fix: reject it at save time
 * (isValidHexColor, used by the templates PATCH route) and never trust it
 * at render time either (sanitizeBackgroundColor, used by compositor.ts).
 */
describe('isValidHexColor', () => {
  it('accepts 3, 6 and 8-digit hex colors', () => {
    expect(isValidHexColor('#fff')).toBe(true)
    expect(isValidHexColor('#ffffff')).toBe(true)
    expect(isValidHexColor('#ffffffff')).toBe(true)
    expect(isValidHexColor('#ABC123')).toBe(true)
  })

  it('rejects the exact failure mode this bug reproduces: an empty string', () => {
    expect(isValidHexColor('')).toBe(false)
  })

  it('rejects missing/wrong-type values', () => {
    expect(isValidHexColor(undefined)).toBe(false)
    expect(isValidHexColor(null)).toBe(false)
    expect(isValidHexColor(123)).toBe(false)
  })

  it('rejects a color missing its leading #, and other malformed text a free-text field could produce', () => {
    expect(isValidHexColor('ffffff')).toBe(false)
    expect(isValidHexColor('white')).toBe(false)
    expect(isValidHexColor('#ggg')).toBe(false)
    expect(isValidHexColor('#ff')).toBe(false)
    expect(isValidHexColor('rgb(255,255,255)')).toBe(false)
  })
})

describe('sanitizeBackgroundColor', () => {
  it('passes a valid hex color through unchanged', () => {
    expect(sanitizeBackgroundColor('#336699')).toBe('#336699')
  })

  it('falls back to DEFAULT_BACKGROUND.color for an empty string', () => {
    expect(sanitizeBackgroundColor('')).toBe(DEFAULT_BACKGROUND.color)
  })

  it('falls back to DEFAULT_BACKGROUND.color for undefined/garbage', () => {
    expect(sanitizeBackgroundColor(undefined)).toBe(DEFAULT_BACKGROUND.color)
    expect(sanitizeBackgroundColor('not-a-color')).toBe(DEFAULT_BACKGROUND.color)
  })

  it('the fallback itself is always a valid hex color — never re-introduces the bug it exists to prevent', () => {
    expect(isValidHexColor(DEFAULT_BACKGROUND.color)).toBe(true)
  })
})
