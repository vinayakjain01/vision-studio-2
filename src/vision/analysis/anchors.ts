/**
 * Anchor derivation — turning raw detections into the semantic points a
 * template frames against.
 *
 * This is the file that makes "keep the head 12% from the top and the hem at
 * 88%" a well-defined instruction. Everything a template can reference resolves
 * here, and every anchor carries both a confidence and the rule that produced
 * it, so the Vision Debug panel can always answer "why is the crop there".
 *
 * ── Precedence ───────────────────────────────────────────────────────────────
 * Each anchor lists its sources best-first. The first source with usable inputs
 * wins; later ones are strictly weaker fallbacks, and each carries a confidence
 * multiplier reflecting how much extrapolation it involved. A template written
 * against `head_top` therefore keeps working when the face detector misses,
 * just with a confidence the caller can threshold on.
 *
 * ── Anthropometric constants ─────────────────────────────────────────────────
 * Several derivations extrapolate through fixed body proportions. Those
 * constants are collected in ANTHROPOMETRY below with the measurement each
 * encodes, rather than being scattered as bare multipliers. They are population
 * averages: correct to within a few percent of head height for adults in
 * upright catalog poses, which is the only situation they are used in.
 *
 * Pure functions. No I/O, no model access.
 */

import type {
  Anchor,
  AnchorName,
  Anchors,
  AnchorSource,
  Box,
  FaceDetection,
  GarmentAnalysis,
  Keypoints,
  PersonDetection,
  Point,
  ProbabilityMask,
} from '@/vision/types'
import {
  highestSetRow,
  lowestSetRow,
  maskCentroid,
  maskStats,
  rowExtent,
} from '@/vision/providers/onnx/segmentation'
import type { ParsingMap } from '@/vision/providers/onnx/parsing'
import {
  parsedFeetBottom,
  parsedGarmentCenterX,
  parsedHeadTop,
} from './garment'

/**
 * Body proportions used when a landmark has to be extrapolated rather than
 * observed. Each is expressed as a ratio between two measurable quantities.
 */
const ANTHROPOMETRY = {
  /**
   * Total head height (crown → chin) as a multiple of a face detector's box
   * height. SCRFD boxes span roughly eyebrow to chin, which is about 70% of the
   * skull, so the crown sits ~0.43 box-heights above the box top.
   */
  headHeightPerFaceBox: 1.43,
  /** Crown offset above the face box top, in face-box heights. */
  crownAboveFaceBox: 0.43,
  /**
   * Head height as a multiple of the ear-to-ear span. Used when there is no
   * face box but the pose model found both ears.
   */
  headHeightPerEarSpan: 1.5,
  /**
   * Head height as a multiple of inter-ocular distance — the weakest head
   * estimate, used when only the eyes are visible.
   */
  headHeightPerEyeSpan: 2.4,
  /** Eye line's depth below the crown, as a fraction of head height. */
  eyeLineBelowCrown: 0.5,
  /** Chin's depth below the crown, as a fraction of head height. */
  chinBelowCrown: 1.0,
  /**
   * Neck position between the chin and the shoulder line. 0 = chin,
   * 1 = shoulder line.
   */
  neckBetweenChinAndShoulders: 0.55,
  /** Chest height between the shoulder line and the hip line. */
  chestBetweenShouldersAndHips: 0.3,
  /** Natural waist between the shoulder line and the hip line. */
  waistBetweenShouldersAndHips: 0.8,
  /**
   * Head height as a fraction of full standing height. Used only to estimate
   * the crown from a person box when nothing else is available.
   */
  headHeightPerStandingHeight: 0.13,
  /** Foot length below the ankle joint, as a fraction of head height. */
  footBelowAnklePerHeadHeight: 0.35,
} as const

/**
 * Confidence multipliers by derivation strength. An anchor's final confidence
 * is the confidence of its inputs times the factor for how it was obtained.
 */
const SOURCE_WEIGHT: Record<AnchorSource, number> = {
  face_landmarks: 1.0,
  face_box: 0.95,
  person_mask: 0.9,
  keypoints: 0.85,
  garment_mask: 0.8,
  interpolated: 0.7,
  person_box: 0.5,
  extrapolated: 0.45,
}

export interface AnchorContext {
  imageWidth: number
  imageHeight: number
  person: PersonDetection | null
  face: FaceDetection | null
  personMask: ProbabilityMask | null
  /** Multiply a mask x by this to reach source pixels. */
  maskScaleX: number
  maskScaleY: number
  maskThreshold: number
  garment: GarmentAnalysis
  /** Per-pixel class map, when the parsing model is available. */
  parsing: ParsingMap | null
}

function anchor(x: number, y: number, source: AnchorSource, inputConfidence: number): Anchor {
  return {
    x,
    y,
    source,
    confidence: Math.max(0, Math.min(1, inputConfidence * SOURCE_WEIGHT[source])),
  }
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** A keypoint is only usable when the model both scored it and placed it in frame. */
function visible(kp: Keypoints[keyof Keypoints] | undefined): boolean {
  return !!kp && kp.visible
}

/** Mean score of a set of keypoints, for propagating input confidence. */
function keypointConfidence(...kps: (Keypoints[keyof Keypoints] | undefined)[]): number {
  const scores = kps.filter(k => k && k.visible).map(k => k!.score)
  if (scores.length === 0) return 0
  return scores.reduce((a, b) => a + b, 0) / scores.length
}

// ─── Head geometry ───────────────────────────────────────────────────────────

interface HeadEstimate {
  crown: Point
  chin: Point
  eyeLine: Point
  /** Crown-to-chin distance in source pixels. */
  height: number
  source: AnchorSource
  confidence: number
}

/**
 * Estimate the head as a whole, then read `head_top`, `chin` and `eye_line` off
 * it. Deriving the three together rather than independently guarantees they
 * stay mutually consistent — an independently-derived chin can otherwise end up
 * above an independently-derived eye line on a tilted head.
 */
function estimateHead(ctx: AnchorContext): HeadEstimate | null {
  const face = ctx.face
  const kps = ctx.person?.keypoints

  // ── 1. Face box + landmarks — the strongest signal. ──────────────────────
  if (face) {
    const faceHeight = face.box.bottom - face.box.top
    if (faceHeight > 0) {
      const headHeight = faceHeight * ANTHROPOMETRY.headHeightPerFaceBox
      const centreX = (face.box.left + face.box.right) / 2

      const eyeLine = face.landmarks
        ? midpoint(face.landmarks.leftEye, face.landmarks.rightEye)
        : { x: centreX, y: face.box.top + faceHeight * 0.35 }

      const crownY = face.box.top - faceHeight * ANTHROPOMETRY.crownAboveFaceBox
      // Chin is measured, not extrapolated — it is the face box's own bottom.
      const chinY = face.box.bottom

      return {
        crown: { x: centreX, y: crownY },
        chin: { x: centreX, y: chinY },
        eyeLine,
        height: headHeight,
        source: face.landmarks ? 'face_landmarks' : 'face_box',
        confidence: face.score,
      }
    }
  }

  if (!kps) return null

  // ── 2. Pose facial keypoints. ────────────────────────────────────────────
  const leftEye = kps.left_eye
  const rightEye = kps.right_eye
  const leftEar = kps.left_ear
  const rightEar = kps.right_ear
  const nose = kps.nose

  let headHeight = 0
  let confidence = 0

  if (visible(leftEar) && visible(rightEar)) {
    headHeight = distance(leftEar, rightEar) * ANTHROPOMETRY.headHeightPerEarSpan
    confidence = keypointConfidence(leftEar, rightEar)
  } else if (visible(leftEye) && visible(rightEye)) {
    headHeight = distance(leftEye, rightEye) * ANTHROPOMETRY.headHeightPerEyeSpan
    confidence = keypointConfidence(leftEye, rightEye)
  }

  if (headHeight > 0) {
    const eyeLine =
      visible(leftEye) && visible(rightEye)
        ? midpoint(leftEye, rightEye)
        : visible(nose)
          ? { x: nose.x, y: nose.y - headHeight * 0.12 }
          : null

    if (eyeLine) {
      const crownY = eyeLine.y - headHeight * ANTHROPOMETRY.eyeLineBelowCrown
      const chinY =
        crownY + headHeight * ANTHROPOMETRY.chinBelowCrown
      return {
        crown: { x: eyeLine.x, y: crownY },
        chin: { x: eyeLine.x, y: chinY },
        eyeLine,
        height: headHeight,
        source: 'keypoints',
        confidence,
      }
    }
  }

  // ── 3. Person box proportions — a last resort, and scored like one. ──────
  const person = ctx.person
  if (person) {
    const personHeight = person.box.bottom - person.box.top
    if (personHeight > 0) {
      const estimated = personHeight * ANTHROPOMETRY.headHeightPerStandingHeight
      const centreX = (person.box.left + person.box.right) / 2
      const crownY = person.box.top
      return {
        crown: { x: centreX, y: crownY },
        chin: { x: centreX, y: crownY + estimated },
        eyeLine: { x: centreX, y: crownY + estimated * ANTHROPOMETRY.eyeLineBelowCrown },
        height: estimated,
        source: 'person_box',
        confidence: person.score,
      }
    }
  }

  return null
}

/**
 * Refine the crown against the person matte.
 *
 * The matte includes hair; a face box does not. On a tall updo or a hat that
 * difference is several percent of frame height, and it is exactly the pixel a
 * "head at 12%" rule is about. Only accepted when the matte's topmost pixel is
 * near the estimated crown — otherwise the topmost pixel belongs to a raised
 * arm and using it would jerk the framing.
 */
function refineCrownWithMask(
  estimate: HeadEstimate,
  ctx: AnchorContext
): { point: Point; source: AnchorSource; confidence: number } | null {
  const mask = ctx.personMask
  if (!mask) return null

  const topRow = highestSetRow(mask, ctx.maskThreshold)
  if (topRow === null) return null

  const maskTopY = topRow * ctx.maskScaleY
  const extent = rowExtent(mask, topRow, ctx.maskThreshold)

  // Accept the matte's top only if it is within one head-height of where the
  // head was estimated to be. Beyond that it is a different body part.
  const tolerance = Math.max(estimate.height, ctx.imageHeight * 0.02)
  if (Math.abs(maskTopY - estimate.crown.y) > tolerance) return null

  const x = extent
    ? ((extent.left + extent.right) / 2) * ctx.maskScaleX
    : estimate.crown.x

  return {
    point: { x, y: maskTopY },
    source: 'person_mask',
    confidence: estimate.confidence,
  }
}

// ─── Main derivation ─────────────────────────────────────────────────────────

export function deriveAnchors(ctx: AnchorContext): Anchors {
  const anchors: Anchors = {}
  const set = (name: AnchorName, value: Anchor | null) => {
    if (value) anchors[name] = value
  }

  const kps = ctx.person?.keypoints
  const head = estimateHead(ctx)

  // ── Head ──────────────────────────────────────────────────────────────────
  if (head) {
    // Precedence for the crown: the parse's hair/hat pixels beat the matte's
    // topmost row, which beats extrapolation from the face box. The parse knows
    // a raised arm is an arm; the matte only knows it is the highest thing in
    // frame, and would put the crown on a wrist.
    const parsedCrownY = ctx.parsing ? parsedHeadTop(ctx.parsing) : null
    const parsedUsable =
      parsedCrownY !== null &&
      Math.abs(parsedCrownY - head.crown.y) <= Math.max(head.height, ctx.imageHeight * 0.02)

    const refined = refineCrownWithMask(head, ctx)

    if (parsedUsable) {
      set('head_top', anchor(head.crown.x, parsedCrownY!, 'person_mask', head.confidence))
    } else if (refined) {
      set('head_top', anchor(refined.point.x, refined.point.y, refined.source, refined.confidence))
    } else {
      set(
        'head_top',
        anchor(
          head.crown.x,
          head.crown.y,
          head.source === 'face_landmarks' || head.source === 'face_box'
            ? 'face_box'
            : head.source,
          head.confidence
        )
      )
    }

    set('eye_line', anchor(head.eyeLine.x, head.eyeLine.y, head.source, head.confidence))
    set(
      'chin',
      anchor(
        head.chin.x,
        head.chin.y,
        head.source === 'face_landmarks' ? 'face_box' : head.source,
        head.confidence
      )
    )
  }

  // ── Shoulders ─────────────────────────────────────────────────────────────
  let shoulderCenter: Point | null = null
  if (kps) {
    const ls = kps.left_shoulder
    const rs = kps.right_shoulder

    if (visible(ls)) set('shoulder_left', anchor(ls.x, ls.y, 'keypoints', ls.score))
    if (visible(rs)) set('shoulder_right', anchor(rs.x, rs.y, 'keypoints', rs.score))

    if (visible(ls) && visible(rs)) {
      shoulderCenter = midpoint(ls, rs)
      set(
        'shoulder_center',
        anchor(shoulderCenter.x, shoulderCenter.y, 'keypoints', keypointConfidence(ls, rs))
      )
    } else if (visible(ls) || visible(rs)) {
      // One shoulder occluded (a three-quarter turn). Mirror it about the head
      // centre rather than dropping the anchor — half a shoulder line still
      // locates the torso well enough to frame against.
      const known = visible(ls) ? ls : rs
      const axisX = head?.crown.x ?? known.x
      shoulderCenter = { x: axisX, y: known.y }
      set('shoulder_center', anchor(axisX, known.y, 'extrapolated', known.score))
    }
  }

  // ── Hips ──────────────────────────────────────────────────────────────────
  let hipCenter: Point | null = null
  if (kps) {
    const lh = kps.left_hip
    const rh = kps.right_hip
    if (visible(lh) && visible(rh)) {
      hipCenter = midpoint(lh, rh)
      set(
        'hip_center',
        anchor(hipCenter.x, hipCenter.y, 'keypoints', keypointConfidence(lh, rh))
      )
    } else if (visible(lh) || visible(rh)) {
      const known = visible(lh) ? lh : rh
      const axisX = shoulderCenter?.x ?? known.x
      hipCenter = { x: axisX, y: known.y }
      set('hip_center', anchor(axisX, known.y, 'extrapolated', known.score))
    }
  }

  // ── Neck, chest, waist — interpolated along the torso axis ───────────────
  if (shoulderCenter && head) {
    const neck = lerp(head.chin, shoulderCenter, ANTHROPOMETRY.neckBetweenChinAndShoulders)
    set(
      'neck',
      anchor(
        neck.x,
        neck.y,
        'interpolated',
        Math.min(head.confidence, anchors.shoulder_center?.confidence ?? head.confidence)
      )
    )
  }

  if (shoulderCenter && hipCenter) {
    const torsoConfidence = Math.min(
      anchors.shoulder_center?.confidence ?? 0,
      anchors.hip_center?.confidence ?? 0
    )
    const chest = lerp(shoulderCenter, hipCenter, ANTHROPOMETRY.chestBetweenShouldersAndHips)
    const waist = lerp(shoulderCenter, hipCenter, ANTHROPOMETRY.waistBetweenShouldersAndHips)
    set('chest', anchor(chest.x, chest.y, 'interpolated', torsoConfidence))
    set('waist', anchor(waist.x, waist.y, 'interpolated', torsoConfidence))
  }

  // ── Knees and ankles ──────────────────────────────────────────────────────
  let ankleCenter: Point | null = null
  if (kps) {
    const lk = kps.left_knee
    const rk = kps.right_knee
    if (visible(lk) && visible(rk)) {
      const knee = midpoint(lk, rk)
      set('knee_center', anchor(knee.x, knee.y, 'keypoints', keypointConfidence(lk, rk)))
    } else if (visible(lk) || visible(rk)) {
      const known = visible(lk) ? lk : rk
      set('knee_center', anchor(known.x, known.y, 'keypoints', known.score * 0.8))
    }

    const la = kps.left_ankle
    const ra = kps.right_ankle
    if (visible(la) && visible(ra)) {
      ankleCenter = midpoint(la, ra)
      set(
        'ankle_center',
        anchor(ankleCenter.x, ankleCenter.y, 'keypoints', keypointConfidence(la, ra))
      )
    } else if (visible(la) || visible(ra)) {
      const known = visible(la) ? la : ra
      ankleCenter = { x: known.x, y: known.y }
      set('ankle_center', anchor(known.x, known.y, 'keypoints', known.score * 0.8))
    }
  }

  // ── Feet ──────────────────────────────────────────────────────────────────
  // Read from pixels, not the ankle joint: shoes, a gown's train and a
  // wide-leg hem all fall below the ankle, and cutting at the joint clips them.
  //
  // The parse is preferred over the matte because it distinguishes shoes and
  // legs from a shadow or a reflective floor, both of which the matte can
  // absorb into the silhouette and which would drag the feet anchor downward.
  const mask = ctx.personMask
  const parsedFeetY = ctx.parsing ? parsedFeetBottom(ctx.parsing) : null

  if (parsedFeetY !== null) {
    set(
      'feet',
      anchor(
        ankleCenter?.x ?? ctx.imageWidth / 2,
        parsedFeetY,
        'garment_mask',
        ctx.person?.score ?? 0.8
      )
    )
  } else if (mask) {
    const bottomRow = lowestSetRow(mask, ctx.maskThreshold)
    if (bottomRow !== null) {
      const y = (bottomRow + 1) * ctx.maskScaleY
      const extent = rowExtent(mask, bottomRow, ctx.maskThreshold)
      const x = extent
        ? ((extent.left + extent.right) / 2) * ctx.maskScaleX
        : (ankleCenter?.x ?? ctx.imageWidth / 2)
      set('feet', anchor(x, y, 'person_mask', ctx.person?.score ?? 0.8))
    }
  }
  if (!anchors.feet && ankleCenter && head) {
    const y = ankleCenter.y + head.height * ANTHROPOMETRY.footBelowAnklePerHeadHeight
    set(
      'feet',
      anchor(ankleCenter.x, y, 'extrapolated', anchors.ankle_center?.confidence ?? 0.5)
    )
  }

  // ── Subject extent ────────────────────────────────────────────────────────
  if (mask) {
    const stats = maskStats(mask, ctx.maskThreshold)
    const centroid = maskCentroid(mask, ctx.maskThreshold)
    const confidence = ctx.person?.score ?? 0.8

    if (centroid) {
      set(
        'subject_center',
        anchor(centroid.x * ctx.maskScaleX, centroid.y * ctx.maskScaleY, 'person_mask', confidence)
      )
    }
    if (stats.bbox) {
      const centreX = ((stats.bbox.left + stats.bbox.right) / 2) * ctx.maskScaleX
      set(
        'subject_top',
        anchor(centreX, stats.bbox.top * ctx.maskScaleY, 'person_mask', confidence)
      )
      set(
        'subject_bottom',
        anchor(centreX, stats.bbox.bottom * ctx.maskScaleY, 'person_mask', confidence)
      )
    }
  }

  if (!anchors.subject_center && ctx.person) {
    const b = ctx.person.box
    set(
      'subject_center',
      anchor((b.left + b.right) / 2, (b.top + b.bottom) / 2, 'person_box', ctx.person.score)
    )
    set('subject_top', anchor((b.left + b.right) / 2, b.top, 'person_box', ctx.person.score))
    set('subject_bottom', anchor((b.left + b.right) / 2, b.bottom, 'person_box', ctx.person.score))
  }

  // ── Garment ───────────────────────────────────────────────────────────────
  const garment = ctx.garment
  if (garment.box) {
    // Centre on the garment's widest row rather than its bounding box: a box
    // centre is pulled sideways by an outstretched sleeve, which visibly
    // off-centres a garment-anchored template.
    const centreX =
      (ctx.parsing ? parsedGarmentCenterX(ctx.parsing) : null) ??
      (garment.box.left + garment.box.right) / 2

    if (garment.topY !== null) {
      set('garment_top', anchor(centreX, garment.topY, 'garment_mask', garment.confidence))
    }
    if (garment.hemY !== null) {
      set('garment_hem', anchor(centreX, garment.hemY, 'garment_mask', garment.confidence))
    }
  }

  return anchors
}

/**
 * Bounding box of every derived anchor above a confidence floor.
 *
 * The framing solver uses this for `keepInside` — the constraint that a crop
 * must not cut off anything the template referenced.
 */
export function anchorBounds(anchors: Anchors, minConfidence = 0.2): Box | null {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  let found = false

  for (const value of Object.values(anchors)) {
    if (!value || value.confidence < minConfidence) continue
    found = true
    if (value.x < left) left = value.x
    if (value.x > right) right = value.x
    if (value.y < top) top = value.y
    if (value.y > bottom) bottom = value.y
  }

  return found ? { left, top, right, bottom } : null
}
