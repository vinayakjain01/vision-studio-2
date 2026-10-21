import { describe, it, expect } from 'vitest'
import { solveFraming, isAnchorTrustworthy } from '@/framing/solver'
import { FRAMING_PRESETS, type FramingSubject } from '@/framing/types'
import type { Anchor, Anchors } from '@/vision/types'

function anchor(x: number, y: number, confidence = 0.8, source: Anchor['source'] = 'keypoints'): Anchor {
  return { x, y, confidence, source }
}

function subject(
  anchors: Anchors,
  shotType: FramingSubject['shotType'] = 'full_body',
  imageHeight = 1600
): FramingSubject {
  return {
    image: { width: 1200, height: imageHeight },
    anchors,
    shotType,
    subjectBox: { left: 300, top: 0, right: 900, bottom: imageHeight },
  }
}

const CANVAS = { width: 1080, height: 1350 }

/**
 * Phase 2 (docs/ISSUES.md issues 1/11): `isAnchorTrustworthy`/the anchor
 * filters it feeds (`hasAnchor` for strategy selection, `enforceKeepInside`'s
 * point set) are the fix for "half-face becomes full-face" and the
 * mannequin's phantom-head distortion — a head-derived anchor extrapolated
 * ABOVE the frame (y < 0, see estimateHead's person-box/face-box fallbacks
 * in src/vision/analysis/anchors.ts) is a guess at a head the photo never
 * showed, not evidence of one, and must never be forced into frame.
 */
describe('isAnchorTrustworthy (pure decision logic)', () => {
  it('trusts a head anchor within the frame', () => {
    expect(isAnchorTrustworthy('head_top', anchor(100, 50))).toBe(true)
    expect(isAnchorTrustworthy('eye_line', anchor(100, 80))).toBe(true)
    expect(isAnchorTrustworthy('chin', anchor(100, 120))).toBe(true)
  })

  it('distrusts a head anchor extrapolated above the frame (y < 0)', () => {
    expect(isAnchorTrustworthy('head_top', anchor(100, -1))).toBe(false)
    expect(isAnchorTrustworthy('eye_line', anchor(100, -50))).toBe(false)
    expect(isAnchorTrustworthy('chin', anchor(100, -10))).toBe(false)
  })

  it('a head anchor at exactly y=0 is still trusted (sits on the top edge, not extrapolated past it)', () => {
    expect(isAnchorTrustworthy('head_top', anchor(100, 0))).toBe(true)
  })

  it('is confidence-independent — even a high-confidence extrapolation above frame is distrusted', () => {
    expect(isAnchorTrustworthy('head_top', anchor(100, -50, 0.99, 'face_landmarks'))).toBe(false)
  })

  it('does not apply the above-frame rule to non-head anchors — e.g. feet legitimately extending below frame is a different, already-handled case', () => {
    expect(isAnchorTrustworthy('feet', anchor(100, 2000))).toBe(true)
    expect(isAnchorTrustworthy('knee_center', anchor(100, -50))).toBe(true)
  })
})

describe('solveFraming: a cropped head never gets forced into frame (issues 1/11)', () => {
  it('rejects head_to_knees when head_top is extrapolated above the frame, even with high confidence, falling through to the anchor-free fallback', () => {
    const half_body = subject(
      {
        head_top: anchor(600, -120, 0.7, 'face_landmarks'), // confidently detected, but cropped — the half-face case
        knee_center: anchor(600, 1100, 0.8),
        subject_center: anchor(600, 800, 0.9, 'person_mask'),
      },
      'half_body'
    )

    const result = solveFraming(half_body, FRAMING_PRESETS.full_body_editorial.spec, CANVAS)

    // head_to_knees requires head_top+knee_center at minConfidence 0.35 —
    // both would pass a confidence-only check, so landing on subject_fit
    // proves the trustworthiness filter, not a confidence gap, is what
    // rejected it.
    expect(result.strategyId).toBe('subject_fit')
    expect(result.usedFallback).toBe(true)

    // The old bug: enforceKeepInside would force the y=-120 point into
    // frame, requiring a large zoom-out. Confirm no such violation fired.
    const keepInsideViolation = result.violations.find(v => v.code === 'keep_inside_violated')
    expect(keepInsideViolation).toBeUndefined()
  })

  it('DOES use head_to_knees when the same anchors are trustworthy (within frame) — confirms the fix does not over-reject', () => {
    const half_body = subject(
      {
        head_top: anchor(600, 80, 0.7, 'face_landmarks'),
        knee_center: anchor(600, 1100, 0.8),
        subject_center: anchor(600, 800, 0.9, 'person_mask'),
      },
      'half_body'
    )

    const result = solveFraming(half_body, FRAMING_PRESETS.full_body_editorial.spec, CANVAS)

    // head_to_feet (index 0) is correctly skipped on a half_body shot (its
    // shotTypes is ['full_body'] only) — landing on head_to_knees here is
    // the chain's own by-design degradation, not evidence of a problem;
    // `usedFallback` just means "not index 0", so it's true here regardless.
    expect(result.strategyId).toBe('head_to_knees')
    expect(result.usedFallback).toBe(true)
  })

  it('enforceKeepInside does not grow the crop to include an above-frame head_top even when a DIFFERENT strategy wins', () => {
    // full_body shot type so head_to_feet is eligible via feet, but head_top
    // itself is still the cropped/untrustworthy one — keepInside names all
    // three (head_top, feet, knee_center) on this preset, so this isolates
    // enforceKeepInside's own filter from selectStrategy's.
    const full_body = subject(
      {
        head_top: anchor(600, -300, 0.9, 'face_box'),
        feet: anchor(600, 1550, 0.9),
        knee_center: anchor(600, 1100, 0.8),
        subject_center: anchor(600, 800, 0.9, 'person_mask'),
      },
      'full_body'
    )

    const result = solveFraming(full_body, FRAMING_PRESETS.full_body_editorial.spec, CANVAS)

    // head_to_feet is missing an in-frame head_top too, so this also falls
    // through — but the key assertion is no keep-inside zoom-out happened
    // trying to reach y=-300.
    const keepInsideViolation = result.violations.find(v => v.code === 'keep_inside_violated')
    expect(keepInsideViolation).toBeUndefined()
  })
})

/**
 * Phase 2/3 (docs/ISSUES.md issue 2 — "full-length pants become short
 * pants"): empirically disproves the originally-hypothesized mechanism
 * (an ANCHOR_FLOOR vs. strategy minConfidence gap on the `feet` anchor
 * itself) — enforceKeepInside already protects a low-confidence-but-
 * PRESENT `feet` anchor regardless of the winning strategy, confirmed
 * below. The real, confirmed gap: `ankle_center` is a SEPARATE anchor from
 * `feet` (src/vision/analysis/anchors.ts), classification already trusts
 * it alone to call a shot `full_body` (`anklesVisible` in shot-type.ts),
 * but the solver's `keepInside` list never named it — so a confident ankle
 * detection got silently cropped out whenever `feet` itself was weak or
 * entirely absent (no garment-parse/mask pixel reached the floor).
 */
describe('solveFraming: a confident ankle is not cropped out when feet is weak/absent (issue 2)', () => {
  it('a low-confidence-but-present feet anchor was ALREADY protected by enforceKeepInside before this fix — confirming the original hypothesis was wrong', () => {
    const full_body = subject(
      {
        head_top: anchor(600, 100, 0.8, 'face_box'),
        knee_center: anchor(600, 1300, 0.6),
        ankle_center: anchor(600, 1650, 0.3), // passes classification's ANCHOR_FLOOR (0.25), below the strategy's minConfidence (0.35)
        feet: anchor(600, 1790, 0.15, 'extrapolated'), // present, but also below minConfidence
      },
      'full_body',
      1800
    )

    const result = solveFraming(full_body, FRAMING_PRESETS.full_body_editorial.spec, CANVAS)

    // head_to_feet correctly can't use this low-confidence `feet` as its own
    // anchor, but keepInside still pulls the crop down to include it.
    expect(result.crop.y + result.crop.height).toBeGreaterThanOrEqual(1790)
  })

  it('the REAL gap: a confident ankle_center is cropped out when feet is entirely absent — now fixed by adding ankle_center to keepInside', () => {
    const full_body = subject(
      {
        head_top: anchor(600, 100, 0.8, 'face_box'),
        knee_center: anchor(600, 1300, 0.6),
        ankle_center: anchor(600, 1650, 0.3),
        // no `feet` anchor at all — e.g. garment parsing/mask never reached the floor.
      },
      'full_body',
      1800
    )

    const result = solveFraming(full_body, FRAMING_PRESETS.full_body_editorial.spec, CANVAS)

    const cropBottom = result.crop.y + result.crop.height
    expect(cropBottom).toBeGreaterThanOrEqual(1650)
  })
})
