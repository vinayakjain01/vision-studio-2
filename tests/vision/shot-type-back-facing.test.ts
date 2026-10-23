import { describe, it, expect } from 'vitest'
import { classifyShot, type ShotContext } from '@/vision/analysis/shot-type'
import { KEYPOINT_NAMES } from '@/vision/types'
import type {
  Anchor,
  Anchors,
  GarmentAnalysis,
  Keypoint,
  Keypoints,
  KeypointName,
  PersonDetection,
} from '@/vision/types'

/**
 * Phase 2/3 (docs/ISSUES.md — back-facing full-body misclassified
 * `product_only`): confirmed against the real "test" template catalog
 * (tenant tnt_YLUuygPCT0J72tRx). Two photos (DSC09434.png, DSC09580.png,
 * source hashes bb1a1732f93…/18e1d164785…) have shoulders, hips, knees and
 * ankles ALL visible with personHeightRatio ~0.95, but no face or head
 * keypoint — a model shot from behind. The single `anklesVisible &&
 * !headVisible` check classified them `product_only` alongside two genuinely
 * headless/bodyless shots in the same batch (every signal false). The fix
 * adds the combined shoulders/hips/knees check to tell the two apart.
 */

const IMAGE_WIDTH = 1000
const IMAGE_HEIGHT = 1500

function blankKeypoint(): Keypoint {
  return { x: 0, y: 0, score: 0, visible: false }
}

function makeKeypoints(overrides: Partial<Record<KeypointName, Keypoint>> = {}): Keypoints {
  const base = {} as Keypoints
  for (const name of KEYPOINT_NAMES) {
    base[name] = blankKeypoint()
  }
  return { ...base, ...overrides }
}

function makePerson(keypoints: Keypoints): PersonDetection {
  return {
    box: { left: 100, top: 50, right: 700, bottom: 1480 },
    score: 0.95,
    keypoints,
    keypointConfidence: 0.6,
    visibleKeypointCount: Object.values(keypoints).filter(k => k.visible).length,
    areaRatio: 0.6,
  }
}

function anchor(x: number, y: number, confidence: number): Anchor {
  return { x, y, confidence, source: 'keypoints' }
}

const BASE_GARMENT: GarmentAnalysis = {
  type: 'full_outfit',
  box: null,
  topY: null,
  hemY: null,
  sleeveLength: 'unknown',
  neckline: 'unknown',
  bodyCoverage: 0.5,
  hemCropped: false,
  confidence: 0.7,
}

function makeContext(overrides: Partial<ShotContext> = {}): ShotContext {
  return {
    imageWidth: IMAGE_WIDTH,
    imageHeight: IMAGE_HEIGHT,
    person: null,
    face: null,
    anchors: {},
    garment: BASE_GARMENT,
    personCoverage: 0.5,
    subjectBox: null,
    ...overrides,
  }
}

describe('classifyShot — back-facing full body (ankles visible, no head evidence)', () => {
  it('classifies full_body when shoulders, hips, knees and ankles are all visible but no head evidence exists', () => {
    // Mirrors the real catalog signals: strong leg/ankle keypoints (so
    // anklesVisible is true via knee+feet), but every head keypoint absent —
    // the model is photographed from behind.
    const keypoints = makeKeypoints({
      left_knee: { x: 300, y: 1100, score: 0.8, visible: true },
      right_knee: { x: 500, y: 1100, score: 0.8, visible: true },
      left_ankle: { x: 300, y: 1400, score: 0.75, visible: true },
      right_ankle: { x: 500, y: 1400, score: 0.75, visible: true },
    })

    const anchors: Anchors = {
      shoulder_center: anchor(400, 200, 0.8),
      hip_center: anchor(400, 800, 0.8),
      knee_center: anchor(400, 1100, 0.8),
      ankle_center: anchor(400, 1400, 0.75),
      feet: anchor(400, 1460, 0.6),
    }

    const ctx = makeContext({
      person: makePerson(keypoints),
      face: null,
      anchors,
      personCoverage: 0.55,
    })

    const result = classifyShot(ctx)

    expect(result.type).toBe('full_body')
    expect(result.signals.headVisible).toBe(false)
    expect(result.signals.anklesVisible).toBe(true)
    expect(result.signals.shouldersVisible).toBe(true)
    expect(result.signals.hipsVisible).toBe(true)
    expect(result.signals.kneesVisible).toBe(true)
  })

  it('still classifies product_only for a genuine lower-body-only crop (no shoulders or hips in frame)', () => {
    // Regression: a hem-and-shoes crop starting around the thigh — ankles
    // visible, but nothing above the knee. Must NOT be swept into full_body
    // by the new check.
    const keypoints = makeKeypoints({
      left_knee: { x: 300, y: 200, score: 0.8, visible: true },
      right_knee: { x: 500, y: 200, score: 0.8, visible: true },
      left_ankle: { x: 300, y: 1400, score: 0.75, visible: true },
      right_ankle: { x: 500, y: 1400, score: 0.75, visible: true },
    })

    const anchors: Anchors = {
      knee_center: anchor(400, 200, 0.8),
      ankle_center: anchor(400, 1400, 0.75),
      feet: anchor(400, 1460, 0.6),
    }

    const ctx = makeContext({
      person: makePerson(keypoints),
      face: null,
      anchors,
      personCoverage: 0.3,
    })

    const result = classifyShot(ctx)

    expect(result.type).toBe('product_only')
    expect(result.signals.shouldersVisible).toBe(false)
    expect(result.signals.hipsVisible).toBe(false)
  })

  it('still classifies product_only when ankles are visible with hips but knees are not resolved', () => {
    // Partial match on the new combined check (shoulders+hips present, knees
    // missing) must not be enough to flip to full_body.
    const keypoints = makeKeypoints({
      left_ankle: { x: 300, y: 1400, score: 0.75, visible: true },
      right_ankle: { x: 500, y: 1400, score: 0.75, visible: true },
    })

    const anchors: Anchors = {
      shoulder_center: anchor(400, 200, 0.8),
      hip_center: anchor(400, 800, 0.8),
      ankle_center: anchor(400, 1400, 0.75),
      feet: anchor(400, 1460, 0.6),
    }

    const ctx = makeContext({
      person: makePerson(keypoints),
      face: null,
      anchors,
      personCoverage: 0.5,
    })

    const result = classifyShot(ctx)

    expect(result.type).toBe('product_only')
    expect(result.signals.kneesVisible).toBe(false)
  })

  it('classifies full_body via the original head+ankles rule when a head keypoint IS present (unaffected by the new branch)', () => {
    const keypoints = makeKeypoints({
      nose: { x: 400, y: 100, score: 0.95, visible: true },
      left_knee: { x: 300, y: 1100, score: 0.8, visible: true },
      right_knee: { x: 500, y: 1100, score: 0.8, visible: true },
      left_ankle: { x: 300, y: 1400, score: 0.75, visible: true },
      right_ankle: { x: 500, y: 1400, score: 0.75, visible: true },
    })

    const anchors: Anchors = {
      shoulder_center: anchor(400, 200, 0.8),
      hip_center: anchor(400, 800, 0.8),
      knee_center: anchor(400, 1100, 0.8),
      ankle_center: anchor(400, 1400, 0.75),
      feet: anchor(400, 1460, 0.6),
    }

    const ctx = makeContext({
      person: makePerson(keypoints),
      face: null,
      anchors,
      personCoverage: 0.55,
    })

    const result = classifyShot(ctx)

    expect(result.type).toBe('full_body')
    expect(result.signals.headVisible).toBe(true)
    expect(result.reasoning).toMatch(/Head and ankles/)
  })

  it('classifies product_only, not full_body, when the same combined signal touches the top of the frame (a cropped product shot, not a back-facing portrait)', () => {
    // Real case (2026-10-23, a different tenant's catalog): shoulders/hips/
    // knees/ankles all visible, no head evidence, personHeightRatio ~1.00,
    // subject touching both the top AND bottom of the frame — confirmed by
    // the reporting user to be a tightly cropped product shot, not a model
    // photographed from behind.
    const keypoints = makeKeypoints({
      left_knee: { x: 300, y: 1100, score: 0.8, visible: true },
      right_knee: { x: 500, y: 1100, score: 0.8, visible: true },
      left_ankle: { x: 300, y: 1400, score: 0.75, visible: true },
      right_ankle: { x: 500, y: 1400, score: 0.75, visible: true },
    })

    const anchors: Anchors = {
      shoulder_center: anchor(400, 200, 0.8),
      hip_center: anchor(400, 800, 0.8),
      knee_center: anchor(400, 1100, 0.8),
      ankle_center: anchor(400, 1400, 0.75),
      feet: anchor(400, 1460, 0.6),
    }

    const ctx = makeContext({
      person: makePerson(keypoints),
      face: null,
      anchors,
      personCoverage: 0.55,
      subjectBox: { left: 100, top: 0, right: 700, bottom: 1500 }, // top === 0: touches top
    })

    const result = classifyShot(ctx)

    expect(result.type).toBe('product_only')
    expect(result.signals.touchesTop).toBe(true)
  })
})
