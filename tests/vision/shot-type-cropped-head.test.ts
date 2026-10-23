import { describe, it, expect } from 'vitest'
import { classifyShot, type ShotContext } from '@/vision/analysis/shot-type'
import { KEYPOINT_NAMES } from '@/vision/types'
import type {
  Anchor,
  Anchors,
  FaceDetection,
  GarmentAnalysis,
  Keypoint,
  Keypoints,
  KeypointName,
  PersonDetection,
} from '@/vision/types'

/**
 * A head "seen" only via a pose keypoint (no real face detection) is treated
 * as genuinely visible — deliberately, so a model photographed from behind
 * still counts (see `headVisible`'s own doc comment). But confirmed against
 * a real catalog photo flagged by the user (DSC08870.jpg, tenant
 * tnt_YLUuygPCT0J72tRx): no face detected, a head keypoint cleared the
 * floor, `personHeightRatio` ~1.00, and the subject box touching BOTH the
 * top and bottom edges of the frame — the head is cropped off at the top of
 * the shot, not turned away from the camera. That photo classified
 * `half_body` when the user wanted `product_only`, the same label a
 * neckline-down crop already gets.
 *
 * Checked against the rest of the same catalog (17 real photos with a
 * keypoint-only head) before fixing: DSC08870.jpg was the only one touching
 * the top edge — every genuine back-facing shot had the whole head
 * comfortably inside the frame. `!touchesTop` is what tells a cropped head
 * apart from a turned-away one.
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
    box: { left: 100, top: 0, right: 700, bottom: 1490 },
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
    personCoverage: 0.6,
    subjectBox: null,
    ...overrides,
  }
}

// A head keypoint well above HEAD_KEYPOINT_FLOOR (0.7), no face detection.
const KEYPOINT_ONLY_HEAD = makeKeypoints({
  nose: { x: 400, y: 20, score: 0.85, visible: true },
})

const BASE_ANCHORS: Anchors = {
  shoulder_center: anchor(400, 200, 0.8),
  hip_center: anchor(400, 800, 0.8),
}

describe('classifyShot — a keypoint-only head cropped off at the top of frame is not half_body', () => {
  it('classifies product_only when the subject touches the top edge (head genuinely cropped off)', () => {
    const ctx = makeContext({
      person: makePerson(KEYPOINT_ONLY_HEAD),
      face: null,
      anchors: BASE_ANCHORS,
      subjectBox: { left: 100, top: 0, right: 700, bottom: 1490 }, // top === 0: touches top
    })

    const result = classifyShot(ctx)

    expect(result.type).toBe('product_only')
    expect(result.signals.headVisible).toBe(false)
    expect(result.signals.touchesTop).toBe(true)
  })

  it('still classifies half_body when the same keypoint-only head does NOT touch the top edge (a genuine back-facing shot)', () => {
    const ctx = makeContext({
      person: makePerson(KEYPOINT_ONLY_HEAD),
      face: null,
      anchors: BASE_ANCHORS,
      subjectBox: { left: 100, top: 50, right: 700, bottom: 1490 }, // comfortably inside frame
    })

    const result = classifyShot(ctx)

    expect(result.type).toBe('half_body')
    expect(result.signals.headVisible).toBe(true)
    expect(result.signals.touchesTop).toBe(false)
  })

  it('a REAL face detection still counts as headVisible even when it touches the top edge — the gate is keypoint-path only', () => {
    const face: FaceDetection = {
      box: { left: 350, top: 0, right: 450, bottom: 140 },
      score: 0.95,
      landmarks: null,
      roll: null,
    }
    const ctx = makeContext({
      person: makePerson(KEYPOINT_ONLY_HEAD),
      face,
      anchors: BASE_ANCHORS,
      subjectBox: { left: 100, top: 0, right: 700, bottom: 1490 },
    })

    const result = classifyShot(ctx)

    expect(result.signals.headVisible).toBe(true)
    expect(result.type).toBe('half_body')
  })

  it('does not affect a genuine back-facing shot with no head evidence at all (issue 12 remains intact)', () => {
    // `headVisible`'s `!touchesTop` gate (this fix) only applies to the
    // keypoint-evidence path — it has nothing to say about a shot with NO
    // head evidence of any kind, keypoint or face. That separate branch
    // (issue 12) got its OWN `!touchesTop` gate later (2026-10-23, a
    // different real tenant's photo) — see
    // tests/vision/shot-type-back-facing.test.ts for that one specifically.
    // This test keeps subjectBox comfortably inside the frame so it isn't
    // exercising that second gate at all, only confirming this fix's own
    // scope.
    const noHeadKeypoints = makeKeypoints()
    const ctx = makeContext({
      person: makePerson(noHeadKeypoints),
      face: null,
      anchors: {
        ...BASE_ANCHORS,
        knee_center: anchor(400, 1100, 0.8),
        ankle_center: anchor(400, 1400, 0.75),
      },
      subjectBox: { left: 100, top: 50, right: 700, bottom: 1490 },
    })

    const result = classifyShot(ctx)

    expect(result.type).toBe('full_body')
    expect(result.signals.headVisible).toBe(false)
    expect(result.signals.touchesTop).toBe(false)
  })
})
