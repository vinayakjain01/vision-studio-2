/**
 * SCRFD decoding — face boxes with 5-point landmarks.
 *
 * Verified output signature (read from a real run at 640×640):
 *
 *   input   input.1   float32 [1, 3, H, W]   BGR, (px − 127.5) / 128
 *   outputs 9 tensors, in `session.outputNames` order:
 *     [0] 12800×1   [1] 3200×1   [2] 800×1     scores,  strides 8 / 16 / 32
 *     [3] 12800×4   [4] 3200×4   [5] 800×4     bbox distances
 *     [6] 12800×10  [7] 3200×10  [8] 800×10    5 landmark offsets
 *
 * 12800 = (640/8)² × 2 anchors, 3200 = (640/16)² × 2, 800 = (640/32)² × 2.
 *
 * SCRFD is anchor-free with distance encoding: each cell predicts the distance
 * from its own centre to the four box edges, in stride units. Anchor centres
 * are generated row-major with the two anchors at a location adjacent, which is
 * the ordering InsightFace's reference implementation uses — get it wrong and
 * every other face lands one cell off.
 *
 * Padding is flush top-left, NOT centred. This is the reference behaviour and
 * differs from YOLO; see `preprocess.ts`'s `align` option.
 */

import type * as ort from 'onnxruntime-node'
import type { Box, DecodedImage, FaceDetection, FaceLandmarks, Point } from '@/vision/types'
import { FACE_INPUT_SIZE, SCRFD_STRIDES, SCRFD_ANCHORS_PER_LOCATION } from '@/vision/model-registry'
import { letterboxToTensor, unletterboxPoint, clampBox, type Letterbox } from './preprocess'
import { nonMaximumSuppression } from './postprocess'
import { tensor, asFloat32, type LoadedSession } from './session'

export interface FaceOptions {
  scoreThreshold: number
  nmsIou: number
  maxDetections?: number
}

export async function runFace(
  loaded: LoadedSession,
  image: DecodedImage,
  options: FaceOptions
): Promise<FaceDetection[]> {
  const { data, letterbox } = letterboxToTensor(image, {
    inputWidth: FACE_INPUT_SIZE,
    inputHeight: FACE_INPUT_SIZE,
    padValue: 0,
    align: 'topleft',
    channelOrder: 'bgr',
    mean: 127.5,
    std: 128.0,
  })

  const inputName = loaded.inputNames[0]
  const outputs = await loaded.session.run({
    [inputName]: tensor(data, [1, 3, FACE_INPUT_SIZE, FACE_INPUT_SIZE]),
  })

  return decodeFaces(outputs, loaded.outputNames, letterbox, image, options)
}

/**
 * Anchor centres for one stride, in model-input pixels.
 *
 * Order: row-major over the grid, with `anchorsPerLocation` consecutive
 * duplicates at each cell —  index = (y * gridW + x) * anchors + a.
 */
function anchorCenters(
  inputW: number,
  inputH: number,
  stride: number,
  anchorsPerLocation: number
): Float32Array {
  const gridW = Math.floor(inputW / stride)
  const gridH = Math.floor(inputH / stride)
  const centers = new Float32Array(gridW * gridH * anchorsPerLocation * 2)

  let i = 0
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const cx = x * stride
      const cy = y * stride
      for (let a = 0; a < anchorsPerLocation; a++) {
        centers[i++] = cx
        centers[i++] = cy
      }
    }
  }
  return centers
}

export function decodeFaces(
  outputs: Record<string, ort.Tensor>,
  outputNames: readonly string[],
  letterbox: Letterbox,
  image: DecodedImage,
  options: FaceOptions
): FaceDetection[] {
  const strideCount = SCRFD_STRIDES.length
  if (outputNames.length < strideCount * 3) return []

  const toSourceX = image.scaleX
  const toSourceY = image.scaleY

  interface Candidate {
    box: Box
    score: number
    landmarks: FaceLandmarks | null
  }
  const candidates: Candidate[] = []

  for (let s = 0; s < strideCount; s++) {
    const stride = SCRFD_STRIDES[s]
    const scores = asFloat32(outputs[outputNames[s]])
    const bboxes = asFloat32(outputs[outputNames[s + strideCount]])
    const kpsRaw = asFloat32(outputs[outputNames[s + strideCount * 2]])

    const count = scores.length
    if (count === 0) continue

    const centers = anchorCenters(
      letterbox.inputWidth,
      letterbox.inputHeight,
      stride,
      SCRFD_ANCHORS_PER_LOCATION
    )
    // Defensive: if the generated grid disagrees with the tensor, the stride
    // assumption is wrong and decoding would silently misplace every face.
    if (centers.length / 2 !== count) continue

    const hasKps = kpsRaw.length >= count * 10

    for (let i = 0; i < count; i++) {
      const score = scores[i]
      if (score < options.scoreThreshold) continue

      const cx = centers[i * 2]
      const cy = centers[i * 2 + 1]

      // Distances are in stride units, measured outward from the cell centre.
      const l = bboxes[i * 4] * stride
      const t = bboxes[i * 4 + 1] * stride
      const r = bboxes[i * 4 + 2] * stride
      const b = bboxes[i * 4 + 3] * stride

      const modelBox: Box = { left: cx - l, top: cy - t, right: cx + r, bottom: cy + b }

      const toSource = (p: Point): Point => {
        const a = unletterboxPoint(p, letterbox)
        return { x: a.x * toSourceX, y: a.y * toSourceY }
      }

      const tl = toSource({ x: modelBox.left, y: modelBox.top })
      const br = toSource({ x: modelBox.right, y: modelBox.bottom })
      const sourceBox = clampBox(
        { left: tl.x, top: tl.y, right: br.x, bottom: br.y },
        image.sourceWidth,
        image.sourceHeight
      )

      if (sourceBox.right - sourceBox.left <= 1 || sourceBox.bottom - sourceBox.top <= 1) {
        continue
      }

      let landmarks: FaceLandmarks | null = null
      if (hasKps) {
        const pts: Point[] = []
        for (let k = 0; k < 5; k++) {
          const dx = kpsRaw[i * 10 + k * 2] * stride
          const dy = kpsRaw[i * 10 + k * 2 + 1] * stride
          pts.push(toSource({ x: cx + dx, y: cy + dy }))
        }
        // SCRFD landmark order is fixed: eyes, nose, mouth corners — and the
        // indices are IMAGE-space, i.e. point 0 is the eye nearer the left of
        // the frame, not the subject's own left eye. `FaceLandmarks` documents
        // the same image-space convention, so these map straight across.
        landmarks = {
          leftEye: pts[0],
          rightEye: pts[1],
          nose: pts[2],
          leftMouth: pts[3],
          rightMouth: pts[4],
        }
      }

      candidates.push({ box: sourceBox, score, landmarks })
    }
  }

  if (candidates.length === 0) return []

  const kept = nonMaximumSuppression(candidates, options.nmsIou, options.maxDetections ?? 20)

  return kept.map(i => {
    const c = candidates[i]
    return {
      box: c.box,
      score: c.score,
      landmarks: c.landmarks,
      roll: c.landmarks ? computeRoll(c.landmarks) : null,
    }
  })
}

/**
 * Head roll in degrees, measured from the eye line.
 *
 * The landmarks are IMAGE-space: `leftEye` is the eye nearer the left edge of
 * the frame. Sweeping left→right therefore gives 0° for a level head, positive
 * when the right-hand eye sits lower (head tilted clockwise on screen), and
 * negative for the mirror case — all within ±90° for any upright pose.
 *
 * Measuring the other way round produces values near ±180° for a level head,
 * which is the same angle geometrically but useless as a tilt reading and wrong
 * as an input to `levelEyeLine`.
 */
function computeRoll(landmarks: FaceLandmarks): number {
  const dx = landmarks.rightEye.x - landmarks.leftEye.x
  const dy = landmarks.rightEye.y - landmarks.leftEye.y
  if (dx === 0 && dy === 0) return 0
  return (Math.atan2(dy, dx) * 180) / Math.PI
}

/**
 * Match a face to the subject.
 *
 * Containment, not proximity: a face belongs to the person whose box encloses
 * it. Distance alone mismatches on a lookbook spread where two models stand
 * shoulder to shoulder and one leans toward the other's box.
 */
export function selectPrimaryFace(
  faces: FaceDetection[],
  personBox: Box | null
): number | null {
  if (faces.length === 0) return null
  if (!personBox) {
    // No person to attribute to — take the largest face, which is the subject
    // in a portrait-only crop.
    let best = 0
    let bestArea = -1
    faces.forEach((f, i) => {
      const area = (f.box.right - f.box.left) * (f.box.bottom - f.box.top)
      if (area > bestArea) {
        bestArea = area
        best = i
      }
    })
    return best
  }

  let best: number | null = null
  let bestScore = -Infinity

  faces.forEach((face, index) => {
    const fw = face.box.right - face.box.left
    const fh = face.box.bottom - face.box.top
    if (fw <= 0 || fh <= 0) return

    const overlapW = Math.max(
      0,
      Math.min(face.box.right, personBox.right) - Math.max(face.box.left, personBox.left)
    )
    const overlapH = Math.max(
      0,
      Math.min(face.box.bottom, personBox.bottom) - Math.max(face.box.top, personBox.top)
    )
    const containment = (overlapW * overlapH) / (fw * fh)

    // A face barely clipping the person box belongs to someone else.
    if (containment < 0.5) return

    // Among contained faces prefer the larger and more confident one — that is
    // the subject rather than a face in a background poster.
    const score = containment * 0.5 + face.score * 0.3 + Math.min(1, (fw * fh) / (
      (personBox.right - personBox.left) * (personBox.bottom - personBox.top) * 0.15
    )) * 0.2

    if (score > bestScore) {
      bestScore = score
      best = index
    }
  })

  return best
}
