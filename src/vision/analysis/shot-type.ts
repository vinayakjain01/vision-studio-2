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
  Keypoints,
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
 *
 * A single keypoint clearing 0.7 is not the only way to earn this, though:
 * see `HEAD_KEYPOINT_PAIRS` below for the other one. A back-facing full-body
 * photo (1920×1080 studio shot, hips 0.84 / knees 0.82 / ankles 0.75 all
 * strongly resolved) scored nose 0.679 — inside the documented "with a face"
 * range (min 0.602) and nowhere near the no-face p90 of 0.538, but just under
 * this round-number floor — and was misclassified `product_only` on a shot
 * that plainly has a head in frame, just turned away from the camera.
 */
const HEAD_KEYPOINT_FLOOR = 0.7

/**
 * Eye or ear pairs whose BOTH members clearing the engine's general keypoint
 * threshold (0.3, i.e. `Keypoint.visible`) is treated as evidence of a head,
 * even when neither member alone reaches `HEAD_KEYPOINT_FLOOR`.
 *
 * A hallucinated head keypoint on garment texture fires in isolation — the
 * documented false positive was nose 0.538 with no symmetric partner reported
 * — whereas a genuine head, seen at an angle or from behind, produces two
 * anatomically consistent points at once. Requiring the pair is what lets a
 * lower bar (0.3 instead of 0.7) stay safe: two independent detections
 * agreeing on where a head is is stronger evidence than one detection scoring
 * higher. `estimateHead` in anchors.ts already relies on exactly this
 * pairing to build head geometry; this mirrors it for classification instead
 * of inventing a second, different bar.
 */
const HEAD_KEYPOINT_PAIRS: readonly (readonly [keyof Keypoints, keyof Keypoints])[] = [
  ['left_eye', 'right_eye'],
  ['left_ear', 'right_ear'],
]

/**
 * Ankle keypoint score that counts as WEAK-BUT-REAL evidence when deciding
 * whether to trust a mask-derived `feet` anchor (see `anklesVisible` below) —
 * never used as a standalone "ankle visible" fact, which is `ankle_center`,
 * built from the engine-wide `visible()` threshold of 0.3.
 *
 * A visible KNEE is not evidence the frame reaches the ANKLE — they are
 * different joints, and treating one as a proxy for the other produced a real
 * bug (reported 2026-10-30): photos cropped around knee/shin height, with a
 * long garment reaching the bottom of the frame, were classified `full_body`
 * because `feet` (a pure crop-boundary/mask artifact there, not a real foot)
 * plus a resolved knee were enough. Five real catalog photos confirmed this —
 * ankle keypoint scores of 0.01–0.17 (`visible: false`) — and a sweep of
 * every production `full_body` photo lacking a real `ankle_center` anchor (61
 * of 499) found the same split: best ankle-keypoint score of min 0.007 /
 * median 0.058 / max 0.631, with 55 of 61 under 0.2 and only 6 above it. 0.2
 * sits just above that cluster of confirmed-wrong cases while still leaving
 * room for the weak-but-real evidence the feet+knee fallback was originally
 * built to trust.
 */
const ANKLE_WEAK_FLOOR = 0.2

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
    // A genuine lower-body-only crop (a hem-and-shoes shot that starts
    // somewhere around the thigh) has ankles visible and nothing above the
    // hip. A back-facing full-length photo — hair covering any head
    // keypoint, no face toward the camera — has ankles visible TOO, but
    // also shoulders, hips and knees: the whole figure is in frame, the
    // camera just isn't seeing a head. Confirmed against real catalog data,
    // not assumed: two photos with shoulders/hips/knees/ankles ALL visible
    // and personHeightRatio ~0.95 were classified `product_only` under the
    // single ankles-without-head check, while two genuine product-only
    // shots in the same batch had every one of those signals false. The
    // combined signal (not just ankles) is what tells the two apart.
    // `!signals.touchesTop` added 2026-10-23: a different tenant's catalog
    // surfaced a photo with this exact signature (shoulders/hips/knees/
    // ankles visible, no head evidence) that the reporting user confirmed
    // should be `product_only`, not `full_body` — a tightly cropped product
    // shot (personHeightRatio ~1.00, touching both the top AND bottom of the
    // frame), not a back-facing portrait. Checked before fixing: every one
    // of the original six real photos that justified this branch has
    // `touchesTop: false` — the whole figure, hair included, sits with
    // margin inside the frame, which is what a genuine back-facing portrait
    // looks like. A subject touching the top edge has had its head/hair
    // region cut off by the crop itself — the same reasoning already
    // applied to the keypoint-evidence case in `headVisible` above, extended
    // here to the no-head-evidence-at-all case for consistency.
    if (signals.shouldersVisible && signals.hipsVisible && signals.kneesVisible && !signals.touchesTop) {
      return decide(
        'full_body',
        0.7,
        'Shoulders through ankles are all visible but no face or head keypoint was detected — likely a back-facing shot. Still a full figure in frame, just without head evidence, so head-relative framing will still correctly skip to a fallback.'
      )
    }
    // `product_only`, not `three_quarter`: the old answer said in its own
    // reasoning that head-relative framing would not apply, while returning
    // a type that `HEAD_FRAMEABLE_SHOTS` lists as head-frameable, so the
    // framing it warned about was applied anyway.
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
    (HEAD_KEYPOINTS.some(name => {
      const kp = ctx.person!.keypoints[name]
      return kp?.visible === true && kp.score >= HEAD_KEYPOINT_FLOOR
    }) ||
      HEAD_KEYPOINT_PAIRS.some(
        ([a, b]) => ctx.person!.keypoints[a]?.visible === true && ctx.person!.keypoints[b]?.visible === true
      ))

  // Weak-but-real ankle evidence, below the full `visible()` gate that
  // `ankle_center` already requires — see `ANKLE_WEAK_FLOOR`.
  const ankleKeypointWeaklySeen =
    ctx.person != null &&
    ((ctx.person.keypoints.left_ankle?.score ?? 0) >= ANKLE_WEAK_FLOOR ||
      (ctx.person.keypoints.right_ankle?.score ?? 0) >= ANKLE_WEAK_FLOOR)

  const faceHeight = ctx.face ? ctx.face.box.bottom - ctx.face.box.top : 0
  const personHeight = ctx.person ? ctx.person.box.bottom - ctx.person.box.top : 0

  const box = ctx.subjectBox
  const edgeTolerance = Math.max(2, Math.round(Math.min(ctx.imageWidth, ctx.imageHeight) * 0.01))
  const touchesTop = box ? box.top <= edgeTolerance : false

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
    //
    // The keypoint path is further gated by `!touchesTop`: a keypoint-only
    // "head" on a subject that touches the top of the frame is a head
    // genuinely cropped off by the shot, not a model facing away. Confirmed
    // against a real catalog photo (DSC08870.jpg): no face detected, but a
    // head keypoint cleared the floor, `personHeightRatio` ~1.00 and the
    // subject box touching BOTH the top and bottom edges — the head is cut
    // off at the frame's top, not turned from the camera. The user wanted
    // this treated the same as a neckline-down crop (`product_only`), not
    // `half_body`. Checked against every other keypoint-only-head photo in
    // the same catalog (17 total): this was the only one touching the top
    // edge — every genuine back-facing full-body/half-body shot has the
    // whole head comfortably inside the frame, so this gate doesn't touch
    // them.
    headVisible: ctx.face !== null || (headKeypointSeen && !touchesTop),
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
    anklesVisible: has('ankle_center') || (has('feet') && has('knee_center') && ankleKeypointWeaklySeen),
    faceHeightRatio: ctx.imageHeight > 0 ? faceHeight / ctx.imageHeight : 0,
    personHeightRatio: ctx.imageHeight > 0 ? personHeight / ctx.imageHeight : 0,
    personCoverage: ctx.personCoverage,
    subjectAspect:
      box && box.right - box.left > 0 ? (box.bottom - box.top) / (box.right - box.left) : 0,
    touchesTop,
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

/**
 * Shot types this list once excluded from AI Extend entirely — a garment
 * laid flat/on a ghost mannequin, or an isolated product shot. Phase 2/3
 * (docs/ISSUES.md issue 7 — "hanger tilted or line above it in no-model
 * shots"): AI Extend was previously never gated by shot type at all, so one
 * of these assigned to an on-model template with `overflow: 'allow'` got
 * generative-fill padding exactly like a person shot, paying for a
 * Cloudinary call and risking `compositor.ts`'s own documented photo/
 * generated-pad compositing seam on a photo with no person to even justify
 * extending a studio backdrop around.
 *
 * `product_only` was removed (2026-10-21) once a real render batch showed
 * the opposite: AI Extend produced a clean background and a correctly-drawn
 * hanger on the photos it was allowed to run on, while the ones forced onto
 * the cheap edge-stretch instead showed a worse, duplicated/ghosted pixel
 * artifact than the seam this gate was meant to prevent.
 *
 * `flat_lay` was removed (2026-10-23) on the same reasoning, by explicit
 * user request, after a related investigation (issue 15) found a REAL
 * person-shot photo had been wrongly landing in `flat_lay` — the original
 * issue 7 evidence behind excluding `flat_lay` at all was never
 * fixture-confirmed either, same as `product_only`'s turned out not to
 * hold up.
 *
 * Now empty, kept as a named export rather than deleted: it is the one
 * place `eligibleForAiExtend`'s shot-type gate lives, and the two call
 * sites in `src/jobs/worker.ts` (`handleRenderJob`/
 * `handleBackgroundFillJob`) read it rather than assuming every shot type
 * is eligible — if real evidence ever justifies excluding one again, this
 * is where it goes back.
 */
export const AI_EXTEND_INELIGIBLE_SHOTS: ShotType[] = []

export function eligibleForAiExtend(type: ShotType): boolean {
  return !AI_EXTEND_INELIGIBLE_SHOTS.includes(type)
}
