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
 * Reported 2026-10-30: photos cropped around knee/shin height — long garment
 * reaching the bottom of the frame, no shoe or ankle pixel anywhere in it —
 * were classified `full_body` instead of `three_quarter`. Confirmed against 5
 * real production photos (Athena Carolina, Diosa, Menaka catalogs): all had a
 * clearly resolved knee keypoint (score 0.37–0.91) but an ankle keypoint score
 * of 0.01–0.17 — essentially zero, `visible: false` — with the `feet` anchor
 * sitting exactly at the image's bottom edge (a person-mask/crop-boundary
 * artifact, not a real foot). `anklesVisible`'s fallback
 * (`has('feet') && has('knee_center')`) treated a visible KNEE as proof the
 * frame extends to the ANKLE, which it does not — those are different joints.
 *
 * A broader sweep of all 499 production `full_body` photos found 61 that only
 * qualified through this fallback (no real `ankle_center` anchor); 55 of them
 * had a best ankle-keypoint score under 0.2, matching this bug exactly.
 */

const IMAGE_WIDTH = 1200
const IMAGE_HEIGHT = 1800

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
    box: { left: 100, top: 100, right: 900, bottom: 1780 },
    score: 0.85,
    keypoints,
    keypointConfidence: 0.6,
    visibleKeypointCount: Object.values(keypoints).filter(k => k.visible).length,
    areaRatio: 0.4,
  }
}

function anchor(x: number, y: number, confidence: number, source: Anchor['source'] = 'keypoints'): Anchor {
  return { x, y, confidence, source }
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

const FACE: FaceDetection = {
  box: { left: 500, top: 200, right: 700, bottom: 400 },
  score: 0.95,
  landmarks: null,
  roll: null,
}

function makeContext(overrides: Partial<ShotContext> = {}): ShotContext {
  return {
    imageWidth: IMAGE_WIDTH,
    imageHeight: IMAGE_HEIGHT,
    person: null,
    face: null,
    anchors: {},
    garment: BASE_GARMENT,
    personCoverage: 0.4,
    subjectBox: null,
    ...overrides,
  }
}

describe('classifyShot — knee visible is not evidence of an ankle in frame', () => {
  it('classifies three_quarter, not full_body, when the knee resolves but the ankle keypoints are essentially unscored', () => {
    // Mirrors the real production signature (Diosa / AR_0557.jpg): head and
    // face present, knee keypoints resolved at a middling score, ankle
    // keypoints scoring 0.01–0.17 (visible: false), and a mask-derived `feet`
    // anchor sitting exactly at the frame's bottom edge because the garment
    // simply touches the crop boundary there, not because a foot was seen.
    const keypoints = makeKeypoints({
      nose: { x: 600, y: 300, score: 0.99, visible: true },
      left_eye: { x: 620, y: 280, score: 0.98, visible: true },
      right_eye: { x: 580, y: 280, score: 0.98, visible: true },
      left_shoulder: { x: 700, y: 500, score: 0.99, visible: true },
      right_shoulder: { x: 500, y: 500, score: 0.99, visible: true },
      left_hip: { x: 650, y: 1100, score: 0.98, visible: true },
      right_hip: { x: 550, y: 1100, score: 0.98, visible: true },
      left_knee: { x: 640, y: 1550, score: 0.48, visible: true },
      right_knee: { x: 560, y: 1530, score: 0.58, visible: true },
      left_ankle: { x: 630, y: 1750, score: 0.018, visible: false },
      right_ankle: { x: 570, y: 1740, score: 0.023, visible: false },
    })

    const anchors: Anchors = {
      shoulder_center: anchor(600, 500, 0.85),
      hip_center: anchor(600, 1100, 0.84),
      knee_center: anchor(600, 1540, 0.45),
      // No ankle_center — the keypoints above don't clear `visible()`.
      feet: anchor(600, IMAGE_HEIGHT, 0.84, 'person_mask'),
    }

    const ctx = makeContext({
      person: makePerson(keypoints),
      face: FACE,
      anchors,
      personCoverage: 0.36,
      subjectBox: { left: 100, top: 100, right: 900, bottom: IMAGE_HEIGHT },
    })

    const result = classifyShot(ctx)

    expect(result.signals.anklesVisible).toBe(false)
    expect(result.signals.kneesVisible).toBe(true)
    expect(result.type).toBe('three_quarter')
  })

  it('still classifies full_body when a real (even if weak) ankle keypoint backs up the feet anchor', () => {
    // Same shape, but the ankle keypoints clear the weak-evidence floor this
    // fix introduces (though still below the full `visible()` gate) — the
    // fallback should still fire, preserving the original full-length case it
    // was built for.
    const keypoints = makeKeypoints({
      nose: { x: 600, y: 300, score: 0.99, visible: true },
      left_eye: { x: 620, y: 280, score: 0.98, visible: true },
      right_eye: { x: 580, y: 280, score: 0.98, visible: true },
      left_shoulder: { x: 700, y: 500, score: 0.99, visible: true },
      right_shoulder: { x: 500, y: 500, score: 0.99, visible: true },
      left_hip: { x: 650, y: 1100, score: 0.98, visible: true },
      right_hip: { x: 550, y: 1100, score: 0.98, visible: true },
      left_knee: { x: 640, y: 1550, score: 0.7, visible: true },
      right_knee: { x: 560, y: 1530, score: 0.75, visible: true },
      left_ankle: { x: 630, y: 1750, score: 0.25, visible: false },
      right_ankle: { x: 570, y: 1740, score: 0.22, visible: false },
    })

    const anchors: Anchors = {
      shoulder_center: anchor(600, 500, 0.85),
      hip_center: anchor(600, 1100, 0.84),
      knee_center: anchor(600, 1540, 0.72),
      feet: anchor(600, IMAGE_HEIGHT, 0.84, 'person_mask'),
    }

    const ctx = makeContext({
      person: makePerson(keypoints),
      face: FACE,
      anchors,
      personCoverage: 0.36,
      subjectBox: { left: 100, top: 100, right: 900, bottom: IMAGE_HEIGHT },
    })

    const result = classifyShot(ctx)

    expect(result.signals.anklesVisible).toBe(true)
    expect(result.type).toBe('full_body')
  })
})
