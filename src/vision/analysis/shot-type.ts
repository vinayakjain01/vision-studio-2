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

/**
 * The keypoints that constitute EVIDENCE OF A HEAD, as opposed to a guess
 * about where one would be.
 *
 * This is the distinction between a half-body shot of a model and a
 * garment-only shot, and getting it wrong is not subtle: neckline-down crops
 * were classified `half_body` and handed head-relative framing meant for
 * photos with a head in them.
 *
 * The trap is that head ANCHORS are always populated, even when nothing
 * head-like was seen. With no face detection, `eye_line` and `chin` are
 * extrapolated from the person box — a plausible guess at where a face would
 * sit above a torso — and `head_top` comes from the top of the person matte,
 * which on a neckline-down crop is the collar. All three exist, all three sit
 * inside the frame, and none of them means a head is present. Anchors are
 * built to be always-available for FRAMING; they are the wrong evidence for
 * deciding whether the thing they describe is actually there.
 *
 * A pose keypoint is the right evidence, because the model can only mark one
 * `visible` where it genuinely resolves that feature. Measured on the two
 * photos that prompted this: an on-model half-body shot scored nose 0.996 /
 * eyes 0.99 / ear 0.975, while the garment-only crop beside it scored nose
 * 0.019 / eyes 0.005 / ears 0.044 — and placed them at NEGATIVE y, i.e. the
 * model extrapolating a head above the frame. Three orders of magnitude
 * apart, not a threshold that needed tuning.
 *
 * Same reasoning as `anklesVisible` below, which already distrusts a `feet`
 * anchor without a real knee keypoint behind it.
 */
const HEAD_KEYPOINTS = ['nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear'] as const

/**
 * Score a head keypoint must clear to count as EVIDENCE OF A HEAD —
 * deliberately far above the engine-wide `keypointScoreThreshold` (0.3) that
 * `Keypoint.visible` encodes.
 *
 * The general threshold is tuned for "where is this joint" on a body already
 * known to be there. Asking instead "is there a head at all" is a different
 * question with a much worse cost of being wrong, and the pose model does
 * hallucinate a face onto textured fabric: a garment detail crop with no head
 * anywhere in frame scored nose 0.538 / ear 0.388 and passed the 0.3 gate.
 *
 * Chosen from the catalog rather than by feel. Across 556 analysed photos,
 * the best head-keypoint score splits cleanly:
 *
 *   with a detected face (n=468):  min 0.602, p5 0.921, median 0.991
 *   with no face        (n=88):   median 0.054, p75 0.154, p90 0.538
 *
 * 0.7 sits in the empty space between the false positives and the genuine
 * heads: it rejects the 0.538 hallucination above while still admitting the
 * eight no-face photos scoring higher, which are models shot from behind or
 * in profile. Photos WITH a face are unaffected either way — they qualify
 * through the face detector, independently of this number.
 */
const HEAD_KEYPOINT_FLOOR = 0.7

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
    // Legs and feet but no head — a hem-and-shoes crop. `product_only`, not
    // `three_quarter`: the old answer said in its own reasoning that
    // head-relative framing would not apply, while returning a type that
    // `HEAD_FRAMEABLE_SHOTS` lists as head-frameable, so the framing it
    // warned about was applied anyway.
    return decide(
      'product_only',
      0.75,
      'Legs and feet in frame but no face or hair detected — a lower-body garment crop, not an on-model shot.'
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

  // A body is in frame but no head was ever SEEN — the model's face and hair
  // are outside the crop, so what this photograph actually shows is the
  // garment. Classified `product_only` rather than `detail`/`unknown` because
  // that is the distinction the templates act on: head-relative framing and
  // head-space rules are meaningless here and must not be applied, and a
  // batch aimed at on-model shots should not pick this up. See
  // `supportsHeadFraming` below.
  if (signals.shouldersVisible || signals.hipsVisible || signals.personHeightRatio > 0.5) {
    return decide(
      'product_only',
      0.8,
      'A body is in frame but no face or hair was detected — the crop starts below the head, so this is a garment-only shot rather than an on-model one.'
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

  // Both conditions, and both earn their place. `visible` carries "projected
  // inside the image", which alone rejects the common failure of a head
  // extrapolated above a torso crop (measured at y = -67 on one such photo).
  // The explicit floor then rejects the opposite failure — a low-confidence
  // face hallucinated onto patterned fabric, which `visible` admits because
  // it only encodes the much lower engine-wide threshold.
  const headKeypointSeen =
    ctx.person != null &&
    HEAD_KEYPOINTS.some(name => {
      const kp = ctx.person!.keypoints[name]
      return kp?.visible === true && kp.score >= HEAD_KEYPOINT_FLOOR
    })

  const faceHeight = ctx.face ? ctx.face.box.bottom - ctx.face.box.top : 0
  const personHeight = ctx.person ? ctx.person.box.bottom - ctx.person.box.top : 0

  const box = ctx.subjectBox
  const edgeTolerance = Math.max(2, Math.round(Math.min(ctx.imageWidth, ctx.imageHeight) * 0.01))

  return {
    hasPerson: ctx.person !== null,
    hasFace: ctx.face !== null,
    // A head counts as visible only when one was actually SEEN: a face
    // detection, or a head keypoint the pose model resolved (see
    // HEAD_KEYPOINTS). Trusting the always-populated head ANCHORS here is
    // what let neckline-down garment crops pass as half-body shots.
    //
    // Both paths matter. The face detector alone would demote every
    // back-facing shot in the catalog — 77 of 544 photos here have no face
    // detection, and many are simply models photographed from behind, whose
    // ears and hair the pose model still resolves.
    headVisible: ctx.face !== null || headKeypointSeen,
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
