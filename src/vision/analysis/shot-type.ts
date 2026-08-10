/**
 * Shot classification.
 *
 * The question "what kind of photo is this" is answered by asking which body
 * landmarks are actually in frame, not by measuring the bounding box.
 *
 * That distinction is the whole reason this file exists. A bounding-box
 * heuristic — tall and narrow with high coverage means close-up — cannot
 * separate a genuine close-up from a full-length shot of a floor-length coat,
 * because those two produce the same box. Asking "are the ankles visible" and
 * "how much of the frame is the face" separates them immediately, and the
 * answer is a fact about the image rather than a threshold that needed tuning.
 *
 * The decision tree below is ordered most-specific first and every branch
 * records the reasoning string that the Vision Debug panel displays verbatim.
 *
 * Pure function.
 */

import type {
  Anchors,
  Box,
  FaceDetection,
  PersonDetection,
  ShotClassification,
  ShotSignals,
  ShotType,
} from '@/vision/types'
import type { GarmentAnalysis } from '@/vision/types'

export interface ShotContext {
  imageWidth: number
  imageHeight: number
  person: PersonDetection | null
  face: FaceDetection | null
  anchors: Anchors
  garment: GarmentAnalysis
  /** Person-matte coverage of the frame, 0–1. */
  personCoverage: number
  /** Subject box from the matte when available, else the person box. */
  subjectBox: Box | null
}

/** Anchors below this confidence are treated as not observed. */
const ANCHOR_FLOOR = 0.25

export function classifyShot(ctx: ShotContext): ShotClassification {
  const signals = computeSignals(ctx)

  const decide = (type: ShotType, confidence: number, reasoning: string): ShotClassification => ({
    type,
    confidence: Math.max(0, Math.min(1, confidence)),
    reasoning,
    signals,
  })

  // ── No person ─────────────────────────────────────────────────────────────
  if (!signals.hasPerson) {
    if (ctx.garment.type === 'accessory') {
      return decide(
        'product_only',
        0.7,
        'No person detected and the subject covers a small fraction of the frame — an isolated product or accessory shot.'
      )
    }
    if (ctx.personCoverage > 0.45) {
      return decide(
        'flat_lay',
        0.7,
        `No person detected and the subject fills ${pct(ctx.personCoverage)} of the frame — a garment laid flat or on a ghost mannequin.`
      )
    }
    if (ctx.personCoverage > 0.02) {
      return decide(
        'product_only',
        0.6,
        `No person detected; subject covers ${pct(ctx.personCoverage)} of the frame.`
      )
    }
    return decide(
      'detail',
      0.5,
      'No person and no clear subject silhouette — a fabric, texture or hardware detail shot.'
    )
  }

  // ── Person present: how much of them is in frame? ─────────────────────────

  // A face occupying a large share of the frame is a close-up regardless of
  // what else is visible.
  if (signals.hasFace && signals.faceHeightRatio > 0.42) {
    return decide(
      'close_up',
      0.9,
      `Face occupies ${pct(signals.faceHeightRatio)} of frame height — a tight beauty or detail crop.`
    )
  }

  if (signals.anklesVisible && signals.headVisible) {
    return decide(
      'full_body',
      0.92,
      'Head and ankles both visible — the full figure is in frame.'
    )
  }

  if (signals.anklesVisible && !signals.headVisible) {
    // Legs and feet but no head — a lower-body crop, framed on the garment.
    return decide(
      'three_quarter',
      0.6,
      'Ankles visible but the head is out of frame — a lower-body crop; head-relative framing will not apply.'
    )
  }

  if (signals.kneesVisible && signals.headVisible) {
    return decide(
      'three_quarter',
      0.85,
      'Head through knees visible, feet out of frame — a three-quarter length shot.'
    )
  }

  if (signals.hipsVisible && signals.headVisible) {
    return decide(
      'half_body',
      0.85,
      'Head through hips visible, legs out of frame — a half-body shot.'
    )
  }

  if (signals.shouldersVisible && signals.headVisible) {
    if (signals.faceHeightRatio > 0.25) {
      return decide(
        'close_up',
        0.75,
        `Head and shoulders only, with the face at ${pct(signals.faceHeightRatio)} of frame height — a tight portrait.`
      )
    }
    return decide(
      'portrait',
      0.85,
      'Head and shoulders visible, torso out of frame — a portrait crop.'
    )
  }

  if (signals.headVisible) {
    return decide(
      'close_up',
      0.7,
      'Head visible but shoulders are not — a tight facial crop.'
    )
  }

  // Person detected but no usable head — a torso or garment crop.
  if (signals.personHeightRatio > 0.8) {
    return decide(
      'detail',
      0.55,
      'A person was detected but no head landmarks are in frame — a garment or body-detail crop.'
    )
  }

  return decide(
    'unknown',
    0.3,
    'A person was detected but too few landmarks are in frame to classify the crop reliably.'
  )
}

function computeSignals(ctx: ShotContext): ShotSignals {
  const a = ctx.anchors
  const has = (name: keyof Anchors): boolean => {
    const anchor = a[name]
    return !!anchor && anchor.confidence >= ANCHOR_FLOOR && inFrame(anchor, ctx)
  }

  const faceHeight = ctx.face ? ctx.face.box.bottom - ctx.face.box.top : 0
  const personHeight = ctx.person ? ctx.person.box.bottom - ctx.person.box.top : 0

  const box = ctx.subjectBox
  const edgeTolerance = Math.max(2, Math.round(Math.min(ctx.imageWidth, ctx.imageHeight) * 0.01))

  return {
    hasPerson: ctx.person !== null,
    hasFace: ctx.face !== null,
    // The head counts as visible when the crown is at or below the top edge —
    // an extrapolated crown above the frame means the head is cropped.
    headVisible: has('head_top') || has('eye_line'),
    shouldersVisible: has('shoulder_center') || has('shoulder_left') || has('shoulder_right'),
    hipsVisible: has('hip_center'),
    kneesVisible: has('knee_center'),
    // `feet` alone is not evidence legs are in frame: when no shoe/ankle pixel
    // is found, it falls back to wherever the person mask or garment parse
    // happens to end — a hem, a clasped hand, a shadow at the bottom edge of a
    // torso crop produces exactly the same anchor a real full-length photo
    // does. A real knee or ankle KEYPOINT is what tells the two apart, because
    // the pose model can only find one where a leg is actually visible.
    // Verified against a real catalog: four photos with a `feet` anchor placed
    // exactly at the frame's bottom edge turned out to be neckline/torso detail
    // shots with a 0.00–0.02 knee-keypoint score, against four genuine
    // full-length photos scoring 0.29–0.73.
    anklesVisible: has('ankle_center') || (has('feet') && has('knee_center')),
    faceHeightRatio: ctx.imageHeight > 0 ? faceHeight / ctx.imageHeight : 0,
    personHeightRatio: ctx.imageHeight > 0 ? personHeight / ctx.imageHeight : 0,
    personCoverage: ctx.personCoverage,
    subjectAspect:
      box && box.right - box.left > 0 ? (box.bottom - box.top) / (box.right - box.left) : 0,
    touchesTop: box ? box.top <= edgeTolerance : false,
    touchesBottom: box ? box.bottom >= ctx.imageHeight - edgeTolerance : false,
    touchesLeft: box ? box.left <= edgeTolerance : false,
    touchesRight: box ? box.right >= ctx.imageWidth - edgeTolerance : false,
  }
}

function inFrame(point: { x: number; y: number }, ctx: ShotContext): boolean {
  return (
    point.x >= 0 &&
    point.y >= 0 &&
    point.x <= ctx.imageWidth &&
    point.y <= ctx.imageHeight
  )
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`
}

/**
 * Shot types where head-relative framing is meaningful.
 *
 * A template that pins `head_top` is only sensible when there is a head in
 * frame. The rules engine and the framing solver both consult this rather than
 * hard-coding a list.
 */
export const HEAD_FRAMEABLE_SHOTS: ShotType[] = [
  'full_body',
  'three_quarter',
  'half_body',
  'portrait',
  'close_up',
]

export function supportsHeadFraming(type: ShotType): boolean {
  return HEAD_FRAMEABLE_SHOTS.includes(type)
}
