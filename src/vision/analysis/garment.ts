/**
 * Garment analysis.
 *
 * Reads the per-pixel human parse (ATR 18 classes) to measure the clothing:
 * what it is, where it starts and ends, how long the sleeves are, what the
 * neckline does.
 *
 * ── Why parsing and not a silhouette ─────────────────────────────────────────
 * An earlier version of this file derived the garment by carving the head off
 * a human alpha matte. That produced numbers, and every one of them was
 * circular: the "garment top" was wherever the carve cut, so the neckline
 * estimate measured its own constant, and "sleeve length" compared silhouette
 * width at the wrist against silhouette width at the shoulder — which is the
 * width of the torso, not of a sleeve. Every test image reported the same
 * answer, which is what a fabricated measurement looks like.
 *
 * A matte fundamentally cannot answer these questions: it does not distinguish
 * a bare forearm from a flesh-toned sleeve, or a hemline from the top of a
 * boot. The parse can, because it labels `left_arm` and `upper_clothes`
 * separately. Every measurement below is now a direct read of labelled pixels.
 *
 * ── Degradation ──────────────────────────────────────────────────────────────
 * Without the parsing model there is no garment analysis. The function returns
 * `unknown` with zero confidence rather than substituting a silhouette-derived
 * guess. A caller can distinguish "no garment found" from "cannot measure" via
 * `available`.
 *
 * Pure functions.
 */

import type {
  Box,
  GarmentAnalysis,
  GarmentType,
  Keypoints,
  Neckline,
  PersonDetection,
  SleeveLength,
} from '@/vision/types'
import {
  ATR,
  GARMENT_CLASSES,
  LOWER_GARMENT_CLASSES,
  UPPER_GARMENT_CLASSES,
} from '@/vision/model-registry'
import {
  classFractionNear,
  countOf,
  highestRowOf,
  lowestRowOf,
  maskOfClasses,
  regionOf,
  rowCounts,
  type ParsingMap,
} from '@/vision/providers/onnx/parsing'

const UNAVAILABLE: GarmentAnalysis = {
  type: 'unknown',
  box: null,
  topY: null,
  hemY: null,
  sleeveLength: 'unknown',
  neckline: 'unknown',
  bodyCoverage: 0,
  hemCropped: false,
  confidence: 0,
}

export interface GarmentContext {
  imageWidth: number
  imageHeight: number
  person: PersonDetection | null
  parsing: ParsingMap | null
}

export interface GarmentResult {
  analysis: GarmentAnalysis
  /** Binary garment mask at parse resolution, or null when unmeasurable. */
  mask: { data: Uint8Array; width: number; height: number } | null
  /** False when the parsing model was unavailable — not the same as "no garment". */
  available: boolean
}

export function analyzeGarment(ctx: GarmentContext): GarmentResult {
  const map = ctx.parsing
  if (!map) {
    return { analysis: UNAVAILABLE, mask: null, available: false }
  }

  const region = regionOf(map, GARMENT_CLASSES)
  if (!region.bbox || region.pixelCount < 4) {
    // The parse ran and found no clothing. That is a real answer — a hardware
    // or fabric detail shot — distinct from the model being absent.
    return {
      analysis: { ...UNAVAILABLE, confidence: region.meanConfidence },
      mask: null,
      available: true,
    }
  }

  const box: Box = {
    left: region.bbox.left * map.scaleX,
    top: region.bbox.top * map.scaleY,
    right: region.bbox.right * map.scaleX,
    bottom: region.bbox.bottom * map.scaleY,
  }

  const topRow = highestRowOf(map, GARMENT_CLASSES)
  const hemRow = lowestRowOf(map, GARMENT_CLASSES)

  const topY = topRow !== null ? topRow * map.scaleY : box.top
  const hemY = hemRow !== null ? (hemRow + 1) * map.scaleY : box.bottom

  // The hem is unknown rather than measured when the garment runs off the
  // bottom of the frame.
  const hemCropped = hemRow !== null && hemRow >= map.height - 2

  const type = classifyGarmentType(map)
  const sleeveLength = measureSleeveLength(map, ctx.person)
  const neckline = measureNeckline(map, ctx.person)

  const personPixels = countOf(map, [
    ...GARMENT_CLASSES,
    ATR.face,
    ATR.hair,
    ATR.hat,
    ATR.left_arm,
    ATR.right_arm,
    ATR.left_leg,
    ATR.right_leg,
    ATR.left_shoe,
    ATR.right_shoe,
  ])
  const bodyCoverage = personPixels > 0 ? Math.min(1, region.pixelCount / personPixels) : 0

  const mask = {
    data: maskOfClasses(map, GARMENT_CLASSES),
    width: map.width,
    height: map.height,
  }

  return {
    analysis: {
      type,
      box,
      topY,
      hemY,
      sleeveLength,
      neckline,
      bodyCoverage,
      hemCropped,
      // Confidence is the parse's own mean confidence over garment pixels —
      // a real signal from the model, not a fixed constant.
      confidence: region.meanConfidence,
    },
    mask,
    available: true,
  }
}

// ─── Category ────────────────────────────────────────────────────────────────

/**
 * Category from which garment classes dominate.
 *
 * `dress` is its own ATR class, so a one-piece is identified directly rather
 * than inferred from "covers torso and legs" — which is the case a
 * silhouette-based rule cannot separate from a top worn with trousers.
 */
function classifyGarmentType(map: ParsingMap): GarmentType {
  const dress = countOf(map, [ATR.dress])
  const upper = countOf(map, [ATR.upper_clothes])
  const skirt = countOf(map, [ATR.skirt])
  const pants = countOf(map, [ATR.pants])
  const scarf = countOf(map, [ATR.scarf])
  const bag = countOf(map, [ATR.bag])

  const lower = skirt + pants
  const total = dress + upper + lower + scarf

  if (total < 4) {
    // Almost no clothing pixels, but a bag or belt present — an accessory shot.
    return bag > 0 ? 'accessory' : 'unknown'
  }

  // A dress reading covers torso and legs in one class.
  if (dress > upper && dress > lower) return 'full_outfit'

  const hasUpper = upper > total * 0.15
  const hasLower = lower > total * 0.15

  if (hasUpper && hasLower) return 'full_outfit'
  if (hasUpper) {
    // Distinguishing outerwear from a plain top needs layering evidence. A
    // coat over a visible inner layer shows both `upper_clothes` and a
    // substantial `scarf`/`belt` presence at the shoulders; without a separate
    // outerwear class in ATR, claiming to tell them apart would be a guess.
    return 'upper_body'
  }
  if (hasLower) return 'lower_body'
  if (scarf > total * 0.4 || bag > 0) return 'accessory'

  return 'unknown'
}

// ─── Sleeves ─────────────────────────────────────────────────────────────────

/**
 * Sleeve length from what covers the arm at the elbow and the wrist.
 *
 * Sampled directly at the pose keypoints: a disc around the wrist is either
 * mostly `left_arm`/`right_arm` (bare) or mostly `upper_clothes`/`dress`
 * (covered). Both arms are checked and the longer reading wins, because one
 * arm is frequently occluded by the body or a bag.
 *
 * Returns `unknown` — not a guess — when the arm keypoints are not visible.
 */
function measureSleeveLength(map: ParsingMap, person: PersonDetection | null): SleeveLength {
  if (!person) return 'unknown'
  const kps = person.keypoints

  const readings: SleeveLength[] = []

  for (const side of ['left', 'right'] as const) {
    const shoulder = kps[`${side}_shoulder`]
    const elbow = kps[`${side}_elbow`]
    const wrist = kps[`${side}_wrist`]
    if (!shoulder.visible) continue

    const covered = (kp: Keypoints[keyof Keypoints]) =>
      classFractionNear(map, kp.x, kp.y, UPPER_GARMENT_CLASSES, 2)
    const skin = (kp: Keypoints[keyof Keypoints]) =>
      classFractionNear(map, kp.x, kp.y, [ATR.left_arm, ATR.right_arm], 2)

    if (wrist.visible) {
      const c = covered(wrist)
      const s = skin(wrist)
      // Require a clear winner; an ambiguous cell says nothing.
      if (c > 0.35 && c > s) {
        readings.push('long')
        continue
      }
    }

    if (elbow.visible) {
      const c = covered(elbow)
      const s = skin(elbow)
      if (c > 0.35 && c > s) {
        readings.push('three_quarter')
        continue
      }
    }

    // Neither elbow nor wrist covered — decide between short and sleeveless by
    // sampling the upper arm, a third of the way from shoulder to elbow.
    if (elbow.visible) {
      const midX = shoulder.x + (elbow.x - shoulder.x) * 0.35
      const midY = shoulder.y + (elbow.y - shoulder.y) * 0.35
      const c = classFractionNear(map, midX, midY, UPPER_GARMENT_CLASSES, 2)
      const s = classFractionNear(map, midX, midY, [ATR.left_arm, ATR.right_arm], 2)
      readings.push(c > 0.35 && c > s ? 'short' : 'sleeveless')
    }
  }

  if (readings.length === 0) return 'unknown'

  // Longest reading wins — the shorter one is usually an occluded arm.
  const rank: Record<SleeveLength, number> = {
    unknown: -1,
    sleeveless: 0,
    short: 1,
    three_quarter: 2,
    long: 3,
  }
  return readings.reduce((best, r) => (rank[r] > rank[best] ? r : best), readings[0])
}

// ─── Neckline ────────────────────────────────────────────────────────────────

/**
 * Neckline from where clothing starts relative to the shoulder line and the
 * chin.
 *
 * Non-circular because the garment top is read from `upper_clothes`/`dress`
 * pixels, while the reference points come from the pose and the face — three
 * independent sources. The vertical gap is normalised by shoulder span so the
 * thresholds are resolution- and subject-size-independent.
 */
function measureNeckline(map: ParsingMap, person: PersonDetection | null): Neckline {
  if (!person) return 'unknown'
  const kps = person.keypoints
  const ls = kps.left_shoulder
  const rs = kps.right_shoulder
  if (!ls.visible || !rs.visible) return 'unknown'

  const shoulderSpan = Math.abs(ls.x - rs.x)
  if (shoulderSpan < 1) return 'unknown'
  const shoulderY = (ls.y + rs.y) / 2

  const topRow = highestRowOf(map, UPPER_GARMENT_CLASSES, 2)
  if (topRow === null) return 'unknown'
  const garmentTopY = topRow * map.scaleY

  // Positive = clothing begins BELOW the shoulder line.
  const drop = (garmentTopY - shoulderY) / shoulderSpan

  // Off-shoulder: clothing starts at or below the shoulders while the shoulder
  // points themselves read as bare skin.
  const shoulderSkin = Math.max(
    classFractionNear(map, ls.x, ls.y, [ATR.left_arm, ATR.right_arm], 2),
    classFractionNear(map, rs.x, rs.y, [ATR.left_arm, ATR.right_arm], 2)
  )
  if (drop > -0.02 && shoulderSkin > 0.4) return 'off_shoulder'

  // A collar or high neck rises above the shoulder line toward the chin.
  if (drop < -0.15) return 'high'
  if (drop < 0.06) return 'crew'
  return 'v_or_scoop'
}

// ─── Extra geometry for anchors ──────────────────────────────────────────────

/**
 * Crown of the head from the parse — the topmost hair, hat or face pixel.
 *
 * More reliable than the alpha matte's topmost row, which is whatever is
 * highest in frame and may be a raised arm. Returns source-space y.
 */
export function parsedHeadTop(map: ParsingMap): number | null {
  const row = highestRowOf(map, [ATR.hat, ATR.hair, ATR.face, ATR.sunglasses], 2)
  return row === null ? null : row * map.scaleY
}

/** Lowest foot or shoe pixel, in source-space y. */
export function parsedFeetBottom(map: ParsingMap): number | null {
  const row = lowestRowOf(
    map,
    [ATR.left_shoe, ATR.right_shoe, ATR.left_leg, ATR.right_leg],
    2
  )
  return row === null ? null : (row + 1) * map.scaleY
}

/**
 * Horizontal centre of the garment at its widest row — a better horizontal
 * anchor for a garment-focused template than the whole-subject centroid, which
 * is pulled sideways by an outstretched arm or a handbag.
 */
export function parsedGarmentCenterX(map: ParsingMap): number | null {
  const counts = rowCounts(map, GARMENT_CLASSES)
  let widestRow = -1
  let widestCount = 0
  for (let y = 0; y < counts.length; y++) {
    if (counts[y] > widestCount) {
      widestCount = counts[y]
      widestRow = y
    }
  }
  if (widestRow < 0 || widestCount === 0) return null

  let sum = 0
  let n = 0
  const row = widestRow * map.width
  for (let x = 0; x < map.width; x++) {
    const cls = map.data[row + x]
    if (GARMENT_CLASSES.includes(cls)) {
      sum += x
      n++
    }
  }
  return n > 0 ? (sum / n) * map.scaleX : null
}

/** Lowest pixel of lower-body clothing (skirt/pants) in source-space y. */
export function parsedLowerHem(map: ParsingMap): number | null {
  const row = lowestRowOf(map, LOWER_GARMENT_CLASSES, 2)
  return row === null ? null : (row + 1) * map.scaleY
}
