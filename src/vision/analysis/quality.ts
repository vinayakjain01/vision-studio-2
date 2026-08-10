/**
 * Quality assessment.
 *
 * Bulk generation is where framing mistakes become expensive: a bad rule
 * silently produces four thousand wrong creatives. This scores each analysis so
 * the operator can sort by confidence and inspect the tail before committing,
 * and so the generation engine can be configured to skip or flag low-confidence
 * images rather than rendering them regardless.
 *
 * Warnings are specific and actionable. "low_keypoint_confidence" tells you to
 * look at the pose overlay; "head_cropped" tells you a head-anchored template
 * will fall back. A single opaque score would not.
 *
 * Pure function.
 */

import type {
  Anchors,
  FaceDetection,
  GarmentAnalysis,
  PersonDetection,
  QualityReport,
  QualityWarning,
  SegmentationResult,
  ShotClassification,
} from '@/vision/types'

export interface QualityContext {
  imageWidth: number
  imageHeight: number
  persons: PersonDetection[]
  primaryPerson: PersonDetection | null
  faces: FaceDetection[]
  primaryFace: FaceDetection | null
  anchors: Anchors
  segmentation: SegmentationResult
  garment: GarmentAnalysis
  shot: ShotClassification
  capabilities: { faceDetection: boolean; personSegmentation: boolean }
}

/** Anchors the framing solver most often depends on, and their relative weight. */
const KEY_ANCHORS: { name: keyof Anchors; weight: number }[] = [
  { name: 'head_top', weight: 3 },
  { name: 'eye_line', weight: 2 },
  { name: 'shoulder_center', weight: 2 },
  { name: 'hip_center', weight: 2 },
  { name: 'feet', weight: 2 },
  { name: 'garment_hem', weight: 1 },
  { name: 'subject_center', weight: 1 },
]

const MIN_USEFUL_DIMENSION = 640

export function assessQuality(ctx: QualityContext): QualityReport {
  const warnings: QualityWarning[] = []

  const detection = scoreDetection(ctx, warnings)
  const landmarks = scoreLandmarks(ctx, warnings)
  const segmentation = scoreSegmentation(ctx, warnings)

  checkFraming(ctx, warnings)
  checkResolution(ctx, warnings)

  // Landmarks carry the most weight because they are what framing consumes.
  // A crisp mask with no usable anchors is not a usable analysis.
  const overall = clamp01(detection * 0.3 + landmarks * 0.45 + segmentation * 0.25)

  return { overall, detection, landmarks, segmentation, warnings }
}

function scoreDetection(ctx: QualityContext, warnings: QualityWarning[]): number {
  if (ctx.persons.length === 0) {
    // Not an error — flat-lays and product-only shots legitimately have no
    // person. It is only worth flagging when the shot type expected one.
    const expectsPerson = !['flat_lay', 'product_only', 'detail'].includes(ctx.shot.type)
    warnings.push({
      code: 'no_person_detected',
      severity: expectsPerson ? 'warning' : 'info',
      message: expectsPerson
        ? 'No person detected. Body-relative framing will fall back to subject bounds.'
        : 'No person detected, consistent with a product-only or flat-lay shot.',
    })
    // A confident flat-lay is a good analysis; score it on the subject instead.
    return ctx.garment.box ? 0.6 : 0.25
  }

  if (ctx.persons.length > 1) {
    warnings.push({
      code: 'multiple_people',
      severity: 'info',
      message: `${ctx.persons.length} people detected. Framing follows the largest, most central subject.`,
    })
  }

  if (!ctx.primaryFace) {
    warnings.push({
      code: 'no_face_detected',
      severity: ctx.capabilities.faceDetection ? 'info' : 'warning',
      message: ctx.capabilities.faceDetection
        ? 'No face detected — head anchors are extrapolated from pose keypoints and are less precise.'
        : 'Face model unavailable — head anchors are extrapolated from pose keypoints.',
    })
  }

  const person = ctx.primaryPerson
  if (!person) return 0.3

  const faceBonus = ctx.primaryFace ? ctx.primaryFace.score * 0.3 : 0
  return clamp01(person.score * 0.7 + faceBonus)
}

function scoreLandmarks(ctx: QualityContext, warnings: QualityWarning[]): number {
  let weighted = 0
  let totalWeight = 0

  for (const { name, weight } of KEY_ANCHORS) {
    totalWeight += weight
    const anchor = ctx.anchors[name]
    if (anchor) weighted += anchor.confidence * weight
  }

  const score = totalWeight > 0 ? weighted / totalWeight : 0

  const person = ctx.primaryPerson
  if (person) {
    const completeness = person.visibleKeypointCount / 17
    if (completeness < 0.35 && person.keypointConfidence < 0.5) {
      warnings.push({
        code: 'low_keypoint_confidence',
        severity: 'warning',
        message: `Only ${person.visibleKeypointCount} of 17 keypoints are confident. Landmark framing may be unstable for this image.`,
      })
    }
  }

  return clamp01(score)
}

function scoreSegmentation(ctx: QualityContext, warnings: QualityWarning[]): number {
  const person = ctx.segmentation.person

  if (!person) {
    warnings.push({
      code: 'mask_unavailable',
      severity: ctx.capabilities.personSegmentation ? 'warning' : 'info',
      message: ctx.capabilities.personSegmentation
        ? 'Segmentation produced no mask for this image. Hem and feet anchors fall back to keypoints.'
        : 'Segmentation model unavailable. Mask-derived anchors are not available.',
    })
    return 0
  }

  // A matte covering essentially nothing or essentially everything did not
  // find the subject — it found noise or the backdrop.
  if (person.coverage < 0.01) {
    warnings.push({
      code: 'mask_implausible',
      severity: 'warning',
      message: `Person mask covers only ${(person.coverage * 100).toFixed(1)}% of the frame — the subject may not have been isolated.`,
    })
    return 0.2
  }
  if (person.coverage > 0.97) {
    warnings.push({
      code: 'mask_implausible',
      severity: 'warning',
      message: 'Person mask covers almost the entire frame — the backdrop was probably not separated.',
    })
    return 0.3
  }

  // meanProbability is how decisive the matte is inside the subject. A soft,
  // uncertain matte has fuzzy edges, and fuzzy edges move the hem anchor.
  return clamp01(person.meanProbability * 0.6 + 0.4)
}

function checkFraming(ctx: QualityContext, warnings: QualityWarning[]): void {
  const { imageWidth, imageHeight } = ctx
  const head = ctx.anchors.head_top
  const feet = ctx.anchors.feet

  if (head && head.y < 0) {
    warnings.push({
      code: 'head_cropped',
      severity: 'warning',
      message: `The top of the head sits ${Math.round(-head.y)}px above the frame. Templates anchored to the head will use their fallback.`,
    })
  }

  if (feet && feet.y > imageHeight) {
    warnings.push({
      code: 'feet_cropped',
      severity: 'info',
      message: 'The feet extend below the frame. Full-body framing will use the visible extent.',
    })
  } else if (ctx.garment.hemCropped) {
    warnings.push({
      code: 'feet_cropped',
      severity: 'info',
      message: 'The garment hem runs to the bottom edge — the true hem position is unknown.',
    })
  }

  const centre = ctx.anchors.subject_center
  if (centre && imageWidth > 0) {
    const offset = Math.abs(centre.x - imageWidth / 2) / (imageWidth / 2)
    if (offset > 0.3) {
      warnings.push({
        code: 'subject_off_center',
        severity: 'info',
        message: `The subject sits ${Math.round(offset * 100)}% off centre. Horizontal anchoring will recentre it.`,
      })
    }
  }
}

function checkResolution(ctx: QualityContext, warnings: QualityWarning[]): void {
  const shortest = Math.min(ctx.imageWidth, ctx.imageHeight)
  if (shortest < MIN_USEFUL_DIMENSION) {
    warnings.push({
      code: 'low_resolution',
      severity: 'warning',
      message: `Source is ${ctx.imageWidth}×${ctx.imageHeight}. Upscaling beyond native resolution will soften the output.`,
    })
  }

  const aspect = ctx.imageWidth / Math.max(1, ctx.imageHeight)
  if (aspect > 3 || aspect < 1 / 3) {
    warnings.push({
      code: 'extreme_aspect_ratio',
      severity: 'info',
      message: `Source aspect ratio is ${aspect.toFixed(2)}:1. Framing to a standard canvas will crop heavily.`,
    })
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
