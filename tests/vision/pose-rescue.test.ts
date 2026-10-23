import { describe, it, expect } from 'vitest'
import { decodePose, type PoseOptions } from '@/vision/providers/onnx/pose'
import { KEYPOINT_NAMES, type DecodedImage } from '@/vision/types'
import type { Letterbox } from '@/vision/providers/onnx/preprocess'

/**
 * Phase 2/3 (docs/ISSUES.md — a real mirror-selfie photo classified as a
 * no-person `flat_lay`): the pose model resolved a genuine person's face and
 * shoulders with 0.94-0.99 confidence, but the overall person-box score came
 * out at 0.267 — below the 0.35 default — so the WHOLE detection, keypoints
 * included, was discarded. A different real photo (a shirt on a hanger that
 * should NOT count as a person) scored a box at 0.21 with its best keypoints
 * under 0.3. `decodePose`'s rescue path (see `PERSON_RESCUE_KEYPOINTS`'s own
 * doc comment in pose.ts) is what tells these two apart: trust a low box
 * score anyway when enough face/shoulder keypoints are independently
 * overwhelming.
 */

const SOURCE_WIDTH = 790
const SOURCE_HEIGHT = 1280

// Identity letterbox: model-input pixels equal source pixels directly, so
// the fixture doesn't need to reproduce the real resize/pad math.
const IDENTITY_LETTERBOX: Letterbox = {
  scale: 1,
  padX: 0,
  padY: 0,
  inputWidth: SOURCE_WIDTH,
  inputHeight: SOURCE_HEIGHT,
  sourceWidth: SOURCE_WIDTH,
  sourceHeight: SOURCE_HEIGHT,
}

const IMAGE: DecodedImage = {
  data: new Uint8Array(0),
  width: SOURCE_WIDTH,
  height: SOURCE_HEIGHT,
  channels: 3,
  sourceWidth: SOURCE_WIDTH,
  sourceHeight: SOURCE_HEIGHT,
  scaleX: 1,
  scaleY: 1,
}

const OPTIONS: PoseOptions = {
  scoreThreshold: 0.35,
  nmsIou: 0.45,
  keypointThreshold: 0.3,
  maxDetections: 20,
}

interface CandidateSpec {
  box: { cx: number; cy: number; w: number; h: number }
  score: number
  /** Keypoint name -> score. Unlisted keypoints default to score 0 at (0, 0). */
  keypointScores?: Partial<Record<(typeof KEYPOINT_NAMES)[number], number>>
}

/** Builds a raw [1, 56, numAnchors] tensor (channels-first) from candidate specs. */
function buildTensor(candidates: CandidateSpec[]): { data: Float32Array; dims: number[] } {
  const numAnchors = candidates.length
  const channels = 56
  const data = new Float32Array(channels * numAnchors)

  candidates.forEach((c, a) => {
    data[0 * numAnchors + a] = c.box.cx
    data[1 * numAnchors + a] = c.box.cy
    data[2 * numAnchors + a] = c.box.w
    data[3 * numAnchors + a] = c.box.h
    data[4 * numAnchors + a] = c.score

    KEYPOINT_NAMES.forEach((name, k) => {
      const base = 5 + k * 3
      const score = c.keypointScores?.[name] ?? 0
      // Placed well inside the frame so `inFrame` (pose.ts) is true whenever
      // a test cares about `visible`, independent of the exact x/y chosen.
      data[base * numAnchors + a] = 100 + k // x
      data[(base + 1) * numAnchors + a] = 100 + k // y
      data[(base + 2) * numAnchors + a] = score
    })
  })

  return { data, dims: [1, channels, numAnchors] }
}

describe('decodePose — person-score rescue via strong face/shoulder keypoints', () => {
  it('admits a real mirror-selfie-style candidate: box score 0.267, nose/eyes/shoulders all 0.94+', () => {
    const { data, dims } = buildTensor([
      {
        box: { cx: 400, cy: 600, w: 600, h: 1100 },
        score: 0.267,
        keypointScores: {
          nose: 0.986,
          left_eye: 0.943,
          right_eye: 0.976,
          left_ear: 0.434,
          right_ear: 0.849,
          left_shoulder: 0.987,
          right_shoulder: 0.95,
        },
      },
    ])

    const persons = decodePose(data, dims, IDENTITY_LETTERBOX, IMAGE, OPTIONS)

    expect(persons).toHaveLength(1)
    expect(persons[0].score).toBeCloseTo(0.267, 5)
  })

  it('still rejects a real garment-hanger phantom: box score 0.21, nose/eyes all under 0.3', () => {
    const { data, dims } = buildTensor([
      {
        box: { cx: 400, cy: 300, w: 500, h: 500 },
        score: 0.21,
        keypointScores: {
          nose: 0.278,
          left_eye: 0.057,
          right_eye: 0.113,
          left_ear: 0.622,
          right_shoulder: 0.1,
        },
      },
    ])

    const persons = decodePose(data, dims, IDENTITY_LETTERBOX, IMAGE, OPTIONS)

    expect(persons).toHaveLength(0)
  })

  it('does not rescue a candidate with only 3 of the 5 required keypoints strong (one short of the floor)', () => {
    const { data, dims } = buildTensor([
      {
        box: { cx: 400, cy: 600, w: 600, h: 1100 },
        score: 0.25,
        keypointScores: {
          nose: 0.95,
          left_eye: 0.9,
          right_eye: 0.92,
          // left_shoulder and right_shoulder left at 0 — only 3 of 5 strong.
        },
      },
    ])

    const persons = decodePose(data, dims, IDENTITY_LETTERBOX, IMAGE, OPTIONS)

    expect(persons).toHaveLength(0)
  })

  it('a normal candidate clearing the real threshold is admitted regardless of keypoint strength (unaffected by this change)', () => {
    const { data, dims } = buildTensor([
      {
        box: { cx: 400, cy: 600, w: 600, h: 1100 },
        score: 0.8,
        keypointScores: { nose: 0.4 },
      },
    ])

    const persons = decodePose(data, dims, IDENTITY_LETTERBOX, IMAGE, OPTIONS)

    expect(persons).toHaveLength(1)
  })

  it('a true-background anchor scoring near zero is rejected outright, not decoded into a false rescue', () => {
    const { data, dims } = buildTensor([
      {
        box: { cx: 400, cy: 600, w: 600, h: 1100 },
        score: 0.001,
        keypointScores: {
          nose: 0.99,
          left_eye: 0.99,
          right_eye: 0.99,
          left_shoulder: 0.99,
          right_shoulder: 0.99,
        },
      },
    ])

    const persons = decodePose(data, dims, IDENTITY_LETTERBOX, IMAGE, OPTIONS)

    // Below PERSON_RESCUE_PREFILTER entirely — never even decoded, regardless
    // of how strong the (synthetic, unrealistic) keypoints are.
    expect(persons).toHaveLength(0)
  })
})
