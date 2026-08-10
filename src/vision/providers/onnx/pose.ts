/**
 * YOLOv8-pose decoding — person boxes and the COCO-17 skeleton.
 *
 * Verified output signature (read from a real run, not documentation):
 *
 *   input   images    float32 [1, 3, 640, 640]   RGB, 0–1, letterboxed centred
 *   output  output0   float32 [1, 56, 8400]
 *
 * The tensor is CHANNELS-FIRST over anchors: element (c, a) lives at
 * `data[c * 8400 + a]`, not `data[a * 56 + c]`. Reading it the other way round
 * produces plausible-looking garbage — boxes in roughly the right part of the
 * image with nonsense keypoints — so the stride is spelled out explicitly below.
 *
 *   channels 0–3    cx, cy, w, h    in model-input pixels
 *   channel  4      person confidence (already sigmoid-activated in the export)
 *   channels 5–55   17 × (x, y, score)
 *
 * There is one class (person), so no class-score argmax is needed.
 */

import type * as ort from 'onnxruntime-node'
import {
  KEYPOINT_NAMES,
  type Keypoint,
  type Keypoints,
  type PersonDetection,
  type DecodedImage,
  boxArea,
} from '@/vision/types'
import { POSE_INPUT_SIZE, POSE_KEYPOINT_COUNT, POSE_CHANNELS } from '@/vision/model-registry'
import {
  letterboxToTensor,
  unletterboxPoint,
  unletterboxBox,
  clampBox,
  type Letterbox,
} from './preprocess'
import { centerToBox, nonMaximumSuppression, clamp, mean } from './postprocess'
import { tensor, asFloat32, type LoadedSession } from './session'

export interface PoseOptions {
  scoreThreshold: number
  nmsIou: number
  keypointThreshold: number
  maxDetections?: number
}

export async function runPose(
  loaded: LoadedSession,
  image: DecodedImage,
  options: PoseOptions
): Promise<PersonDetection[]> {
  const { data, letterbox } = letterboxToTensor(image, {
    inputWidth: POSE_INPUT_SIZE,
    inputHeight: POSE_INPUT_SIZE,
    // 114 is Ultralytics' letterbox grey. The model was trained with it; any
    // other pad colour is a small distribution shift at the border.
    padValue: 114,
    align: 'center',
    channelOrder: 'rgb',
    mean: 0,
    std: 255,
  })

  const inputName = loaded.inputNames[0]
  const outputs = await loaded.session.run({
    [inputName]: tensor(data, [1, 3, POSE_INPUT_SIZE, POSE_INPUT_SIZE]),
  })

  const raw = outputs[loaded.outputNames[0]] as ort.Tensor
  return decodePose(asFloat32(raw), raw.dims as number[], letterbox, image, options)
}

export function decodePose(
  out: Float32Array,
  dims: number[],
  letterbox: Letterbox,
  image: DecodedImage,
  options: PoseOptions
): PersonDetection[] {
  // dims = [1, 56, numAnchors]
  const channels = dims[1] ?? POSE_CHANNELS
  const numAnchors = dims[2] ?? 0
  if (numAnchors === 0 || channels < POSE_CHANNELS) return []

  // Composed transform: analysis-buffer pixels → source pixels.
  const toSourceX = image.scaleX
  const toSourceY = image.scaleY

  interface Candidate {
    box: ReturnType<typeof centerToBox>
    score: number
    keypoints: Keypoints
    keypointScores: number[]
    visibleCount: number
  }

  const candidates: Candidate[] = []

  for (let a = 0; a < numAnchors; a++) {
    const score = out[4 * numAnchors + a]
    if (score < options.scoreThreshold) continue

    const cx = out[0 * numAnchors + a]
    const cy = out[1 * numAnchors + a]
    const w = out[2 * numAnchors + a]
    const h = out[3 * numAnchors + a]

    // Model input pixels → analysis pixels → source pixels.
    const modelBox = centerToBox(cx, cy, w, h)
    const analysisBox = unletterboxBox(modelBox, letterbox)
    const sourceBox = clampBox(
      {
        left: analysisBox.left * toSourceX,
        top: analysisBox.top * toSourceY,
        right: analysisBox.right * toSourceX,
        bottom: analysisBox.bottom * toSourceY,
      },
      image.sourceWidth,
      image.sourceHeight
    )

    if (boxArea(sourceBox) <= 0) continue

    const keypoints = {} as Keypoints
    const keypointScores: number[] = []
    let visibleCount = 0

    for (let k = 0; k < POSE_KEYPOINT_COUNT; k++) {
      const base = 5 + k * 3
      const kx = out[base * numAnchors + a]
      const ky = out[(base + 1) * numAnchors + a]
      const ks = out[(base + 2) * numAnchors + a]

      const analysisPoint = unletterboxPoint({ x: kx, y: ky }, letterbox)
      const x = analysisPoint.x * toSourceX
      const y = analysisPoint.y * toSourceY

      // A keypoint the model placed outside the frame is an extrapolation of a
      // body part that was cropped away. Its coordinate is still informative
      // (it says "the ankles are below the bottom edge", which is exactly what
      // the shot classifier needs) so it is kept — but never marked visible,
      // so anchor derivation will not treat it as observed.
      const inFrame =
        x >= 0 && y >= 0 && x <= image.sourceWidth && y <= image.sourceHeight
      const visible = ks >= options.keypointThreshold && inFrame

      const kp: Keypoint = { x, y, score: ks, visible }
      keypoints[KEYPOINT_NAMES[k]] = kp

      if (visible) {
        visibleCount++
        keypointScores.push(ks)
      }
    }

    candidates.push({ box: sourceBox, score, keypoints, keypointScores, visibleCount })
  }

  if (candidates.length === 0) return []

  const kept = nonMaximumSuppression(
    candidates,
    options.nmsIou,
    options.maxDetections ?? 20
  )

  const imageArea = image.sourceWidth * image.sourceHeight

  return kept.map(i => {
    const c = candidates[i]
    return {
      box: c.box,
      score: c.score,
      keypoints: c.keypoints,
      keypointConfidence: mean(c.keypointScores),
      visibleKeypointCount: c.visibleCount,
      areaRatio: imageArea > 0 ? clamp(boxArea(c.box) / imageArea, 0, 1) : 0,
    }
  })
}

/**
 * Pick the subject.
 *
 * Fashion catalog photos usually contain one person, but not always — a
 * street-style shot has passers-by, a lookbook spread can have two models.
 * The subject is scored on how much frame it occupies, how confident the
 * detection is, how complete the skeleton is, and how close to centre it sits.
 * Area alone picks a foreground arm over a centred model; confidence alone
 * picks whichever bystander happens to be crisply lit.
 */
export function selectPrimaryPerson(
  persons: PersonDetection[],
  imageWidth: number
): number | null {
  if (persons.length === 0) return null
  if (persons.length === 1) return 0

  const centreX = imageWidth / 2
  let bestIndex = 0
  let bestScore = -Infinity

  persons.forEach((person, index) => {
    const personCentreX = (person.box.left + person.box.right) / 2
    // 1 when dead-centre, 0 at either edge.
    const centrality = 1 - Math.min(1, Math.abs(personCentreX - centreX) / (imageWidth / 2))
    const completeness = person.visibleKeypointCount / 17

    const score =
      person.areaRatio * 0.45 +
      person.score * 0.20 +
      completeness * 0.20 +
      centrality * 0.15

    if (score > bestScore) {
      bestScore = score
      bestIndex = index
    }
  })

  return bestIndex
}
