/**
 * ════════════════════════════════════════════════════════════════════════════
 * Vision Engine — public contract
 * ════════════════════════════════════════════════════════════════════════════
 *
 * This module and everything under `src/vision/` is a SELF-CONTAINED SERVICE.
 * It has no dependency on the database, the HTTP layer, Next.js, or Vision
 * Studio's storage conventions. It takes image bytes in and returns a
 * `VisionMetadata` document out; persistence is the caller's problem, injected
 * through the `VisionCache` and `MaskSink` ports.
 *
 * That boundary is deliberate and load-bearing: the same directory is intended
 * to be lifted into Craftify unchanged. If you find yourself importing `@/db`,
 * `@/config`, or anything from `@/app` inside `src/vision/`, the port is
 * missing — add it to `VisionEngineOptions` instead.
 *
 * ── Coordinate conventions ───────────────────────────────────────────────────
 * EVERY coordinate in this document is in **source-image pixel space**, origin
 * top-left, x right, y down, using the image's *display* dimensions (EXIF
 * orientation already applied). Inference runs on a downscaled letterboxed
 * copy; the providers project results back before returning. Nothing outside
 * `src/vision/providers/` ever sees model-input coordinates.
 *
 * ── Determinism ──────────────────────────────────────────────────────────────
 * Given the same bytes, the same model files, and the same thresholds, this
 * engine produces byte-identical output. No sampling, no temperature, no
 * network calls, no wall-clock or random inputs to any decision. `engineVersion`
 * captures the model set and the analysis code version together, so a stored
 * analysis can always be attributed to an exact configuration.
 */

// ─── Geometry primitives ─────────────────────────────────────────────────────

export interface Point {
  x: number
  y: number
}

/** Axis-aligned rectangle in source-image pixels. `right`/`bottom` exclusive. */
export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

export interface Size {
  width: number
  height: number
}

export function boxWidth(b: Box): number {
  return Math.max(0, b.right - b.left)
}

export function boxHeight(b: Box): number {
  return Math.max(0, b.bottom - b.top)
}

export function boxCenter(b: Box): Point {
  return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 }
}

export function boxArea(b: Box): number {
  return boxWidth(b) * boxHeight(b)
}

// ─── Keypoints ───────────────────────────────────────────────────────────────

/**
 * COCO-17 skeleton, the output topology of every mainstream pose model
 * (YOLOv8-pose, RTMPose, HRNet). Index order is fixed by the COCO spec and is
 * relied upon by the decoder in `providers/onnx/pose.ts`.
 */
export const KEYPOINT_NAMES = [
  'nose',
  'left_eye',
  'right_eye',
  'left_ear',
  'right_ear',
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
  'left_ankle',
  'right_ankle',
] as const

export type KeypointName = (typeof KEYPOINT_NAMES)[number]

export interface Keypoint extends Point {
  /** Model confidence, 0–1. Below `keypointScoreThreshold` treat as absent. */
  score: number
  /**
   * False when the keypoint's score is under threshold OR it was projected
   * outside the image. Consumers should branch on this, not on `score`, so the
   * threshold lives in one place.
   */
  visible: boolean
}

export type Keypoints = Record<KeypointName, Keypoint>

/** Pairs used to draw the skeleton in the debug overlay. */
export const SKELETON_EDGES: [KeypointName, KeypointName][] = [
  ['left_ankle', 'left_knee'],
  ['left_knee', 'left_hip'],
  ['right_ankle', 'right_knee'],
  ['right_knee', 'right_hip'],
  ['left_hip', 'right_hip'],
  ['left_shoulder', 'left_hip'],
  ['right_shoulder', 'right_hip'],
  ['left_shoulder', 'right_shoulder'],
  ['left_shoulder', 'left_elbow'],
  ['right_shoulder', 'right_elbow'],
  ['left_elbow', 'left_wrist'],
  ['right_elbow', 'right_wrist'],
  ['left_eye', 'right_eye'],
  ['nose', 'left_eye'],
  ['nose', 'right_eye'],
  ['left_eye', 'left_ear'],
  ['right_eye', 'right_ear'],
]

// ─── Detections ──────────────────────────────────────────────────────────────

export interface PersonDetection {
  box: Box
  score: number
  keypoints: Keypoints
  /** Mean score of the keypoints that passed threshold. 0 when none did. */
  keypointConfidence: number
  /** Count of keypoints with `visible: true`. */
  visibleKeypointCount: number
  /**
   * Fraction of the image area covered by this person's box. Used to pick the
   * primary subject and to distinguish a model from a bystander.
   */
  areaRatio: number
}

/**
 * Five-point face landmarks, the SCRFD/RetinaFace convention.
 *
 * Left and right are IMAGE-space, not the subject's own: `leftEye` is whichever
 * eye appears nearer the left edge of the frame. This matches the raw model
 * output order and keeps every downstream angle calculation sign-correct.
 */
export interface FaceLandmarks {
  leftEye: Point
  rightEye: Point
  nose: Point
  leftMouth: Point
  rightMouth: Point
}

export interface FaceDetection {
  box: Box
  score: number
  landmarks: FaceLandmarks | null
  /**
   * Signed roll angle in degrees, derived from the eye line. Positive = the
   * subject's head is tilted to the image's right. `null` without landmarks.
   */
  roll: number | null
}

// ─── Masks ───────────────────────────────────────────────────────────────────

/**
 * A binary mask stored out-of-band.
 *
 * Masks are megabytes as JSON, so `VisionMetadata` carries only a reference and
 * cheap summary statistics. The bytes go through the `MaskSink` port; the
 * caller decides where (Vision Studio writes a PNG under `derived/`).
 */
export interface MaskRef {
  /** Opaque handle returned by the MaskSink — a storage key, URL, or id. */
  ref: string
  /** Dimensions of the stored mask, which may be smaller than the source. */
  width: number
  height: number
  /** Tight bounding box of set pixels, in SOURCE-image coordinates. */
  bbox: Box
  /** Set pixels / total pixels, 0–1. */
  coverage: number
  /** Mean model probability over the set region — a soft-confidence proxy. */
  meanProbability: number
}

export interface SegmentationResult {
  /** Whole-person silhouette (skin + hair + clothing). */
  person: MaskRef | null
  /**
   * Clothing-only region. Derived by intersecting the person mask with the
   * torso/leg region implied by the pose, minus the head. See
   * `analysis/garment.ts` — this is geometric derivation from two model
   * outputs, not a separate learned segmentation.
   */
  garment: MaskRef | null
}

// ─── Garment analysis ────────────────────────────────────────────────────────

export type GarmentType =
  | 'full_outfit'   // torso + legs covered — dress, gown, jumpsuit, co-ord
  | 'upper_body'    // top, shirt, jacket, kurta
  | 'lower_body'    // trousers, skirt, shorts
  | 'outerwear'     // covers torso with visible layering at the shoulders
  | 'accessory'     // small item, little or no body coverage
  | 'unknown'

export type SleeveLength = 'sleeveless' | 'short' | 'three_quarter' | 'long' | 'unknown'

export type Neckline = 'high' | 'crew' | 'v_or_scoop' | 'off_shoulder' | 'unknown'

export interface GarmentAnalysis {
  type: GarmentType
  /** Tight box around the garment mask, source pixels. */
  box: Box | null
  /** Topmost garment pixel row — the shoulder/neckline edge. */
  topY: number | null
  /** Bottommost garment pixel row — the hem. */
  hemY: number | null
  sleeveLength: SleeveLength
  neckline: Neckline
  /** Garment pixels / person pixels, 0–1. */
  bodyCoverage: number
  /** Does the garment reach the bottom edge of the frame (hem cropped)? */
  hemCropped: boolean
  confidence: number
}

// ─── Anchors ─────────────────────────────────────────────────────────────────

/**
 * Semantic points a template can frame against.
 *
 * This is the Vision Engine's most important output and the entire reason the
 * template builder can offer "keep the head 12% from the top" instead of
 * "scale to 80%". Anchors are derived (see `analysis/anchors.ts`) from
 * keypoints, the face box, and the masks — several sources per anchor, with a
 * documented precedence — so a template written against `head_top` keeps
 * working on an image where the pose model missed the ears but the face
 * detector fired.
 *
 * An anchor is `null` when nothing in the image supports it. The framing solver
 * treats null anchors as an explicit fallback trigger, never as (0, 0).
 */
export const ANCHOR_NAMES = [
  'head_top',        // crown of the head, extrapolated above the face/eye line
  'eye_line',        // midpoint between the eyes
  'chin',            // bottom of the face box
  'neck',            // midpoint of the shoulder line, raised toward the chin
  'shoulder_left',
  'shoulder_right',
  'shoulder_center',
  'chest',           // shoulder_center → hip_center, 30% down
  'waist',           // shoulder_center → hip_center, 80% down
  'hip_center',
  'knee_center',
  'ankle_center',
  'feet',            // lowest visible point of the person mask
  'garment_top',
  'garment_hem',
  'subject_center',  // centroid of the person mask
  'subject_top',
  'subject_bottom',
] as const

export type AnchorName = (typeof ANCHOR_NAMES)[number]

export interface Anchor extends Point {
  /**
   * 0–1. Combines the confidence of the inputs with a penalty for how much
   * extrapolation was involved. `head_top` from a crisp face box scores high;
   * `head_top` inferred from shoulders alone scores low.
   */
  confidence: number
  /** Which derivation rule produced this point — surfaced in the debug panel. */
  source: AnchorSource
}

export type AnchorSource =
  | 'face_box'
  | 'face_landmarks'
  | 'keypoints'
  | 'person_mask'
  | 'garment_mask'
  | 'person_box'
  | 'interpolated'
  | 'extrapolated'

export type Anchors = Partial<Record<AnchorName, Anchor>>

// ─── Shot type ───────────────────────────────────────────────────────────────

/**
 * Framing classification, decided from anchors rather than from raw pixel
 * statistics.
 *
 * The distinction matters. A heuristic that reads "tall bounding box + high
 * coverage" cannot tell a full-body shot from a close-up of a long coat. Asking
 * "are the ankles visible, are the hips visible, is the face more than a third
 * of the frame height" answers the question the label is actually about.
 */
export type ShotType =
  | 'full_body'    // head through ankles/feet visible
  | 'three_quarter'// head through knees
  | 'half_body'    // head through hips/waist
  | 'portrait'     // head and shoulders
  | 'close_up'     // face fills much of the frame, or a tight garment detail
  | 'detail'       // no person — fabric, hardware, texture
  | 'flat_lay'     // no person — garment laid flat, fills the frame
  | 'product_only' // no person — isolated object on a plain backdrop
  | 'unknown'

export const SHOT_TYPES: ShotType[] = [
  'full_body',
  'three_quarter',
  'half_body',
  'portrait',
  'close_up',
  'detail',
  'flat_lay',
  'product_only',
  'unknown',
]

export interface ShotClassification {
  type: ShotType
  confidence: number
  /** Human-readable justification, shown verbatim in the Vision Debug panel. */
  reasoning: string
  /** The boolean tests the decision tree evaluated, for debugging. */
  signals: ShotSignals
}

export interface ShotSignals {
  hasPerson: boolean
  hasFace: boolean
  headVisible: boolean
  shouldersVisible: boolean
  hipsVisible: boolean
  kneesVisible: boolean
  anklesVisible: boolean
  /** Face box height / image height. */
  faceHeightRatio: number
  /** Person box height / image height. */
  personHeightRatio: number
  /** Person mask coverage of the frame, 0–1. */
  personCoverage: number
  /** Subject box aspect (height / width). */
  subjectAspect: number
  /** Does the subject touch each frame edge? */
  touchesTop: boolean
  touchesBottom: boolean
  touchesLeft: boolean
  touchesRight: boolean
}

// ─── Quality ─────────────────────────────────────────────────────────────────

export interface QualityReport {
  /** 0–1, the weighted roll-up shown as a single number in the UI. */
  overall: number
  detection: number     // did we find the subject at all, and how surely
  landmarks: number     // how many anchors are usable, weighted by confidence
  segmentation: number  // mask sharpness/coverage plausibility
  /** Machine-readable problems a human should know about before bulk running. */
  warnings: QualityWarning[]
}

export type QualityWarningCode =
  | 'no_person_detected'
  | 'multiple_people'
  | 'no_face_detected'
  | 'head_cropped'
  | 'feet_cropped'
  | 'low_keypoint_confidence'
  | 'mask_unavailable'
  | 'mask_implausible'
  | 'subject_off_center'
  | 'low_resolution'
  | 'extreme_aspect_ratio'

export interface QualityWarning {
  code: QualityWarningCode
  severity: 'info' | 'warning' | 'error'
  message: string
}

// ─── The document ────────────────────────────────────────────────────────────

/**
 * Bump when the shape changes in a way stored rows cannot be read as. The
 * engine refuses to consume a cached analysis whose `schemaVersion` differs.
 */
export const VISION_SCHEMA_VERSION = 1

export interface VisionMetadata {
  schemaVersion: number
  /** sha256 of the source bytes. The cache key. */
  sourceHash: string
  /** Display dimensions, EXIF orientation applied. All coordinates use these. */
  image: Size

  persons: PersonDetection[]
  /** Index into `persons` of the subject the anchors describe. */
  primaryPersonIndex: number | null
  faces: FaceDetection[]
  /** Index into `faces` of the face matched to the primary person. */
  primaryFaceIndex: number | null

  segmentation: SegmentationResult
  garment: GarmentAnalysis
  anchors: Anchors
  shot: ShotClassification
  quality: QualityReport

  /** Identifies the exact code + model configuration that produced this. */
  engineVersion: string
  provider: string
  modelVersions: Record<string, string>
  timings: Record<string, number>
  durationMs: number
  createdAt: string
}

// ─── Provider contract ───────────────────────────────────────────────────────

/**
 * Decoded RGB(A) pixels plus the geometry needed to map back to the source.
 * Providers receive this rather than bytes so a single decode is shared across
 * every model in the pipeline.
 */
export interface DecodedImage {
  /** Interleaved, `channels` bytes per pixel, row-major. */
  data: Uint8Array
  width: number
  height: number
  channels: 3 | 4
  /** Display dimensions of the original — what all output coordinates use. */
  sourceWidth: number
  sourceHeight: number
  /** Multiply an (x, y) in this buffer by these to reach source space. */
  scaleX: number
  scaleY: number
}

export interface VisionThresholds {
  personScore: number
  personNmsIou: number
  faceScore: number
  faceNmsIou: number
  keypointScore: number
  maskBinary: number
}

/**
 * Raw model outputs, before any semantic analysis.
 *
 * Splitting "run the models" from "interpret the results" is what makes the
 * engine swappable. A provider only has to produce boxes, keypoints, faces and
 * masks; anchors, garment analysis, shot type and quality are computed once, in
 * `src/vision/analysis/`, identically for every provider.
 */
export interface RawVisionResult {
  persons: PersonDetection[]
  faces: FaceDetection[]
  /** Soft human matte at model resolution, 0–255. Encoded by the engine. */
  personMask: ProbabilityMask | null
  /**
   * Per-pixel ATR class map. The source of every garment measurement — see
   * `analysis/garment.ts` for why a matte cannot substitute for it.
   * Typed as `unknown` here to keep this contract free of the ONNX provider's
   * internals; the analysis layer narrows it.
   */
  parsing: ParsingLike | null
  timings: Record<string, number>
  modelVersions: Record<string, string>
}

/**
 * Structural shape of a parse map, declared without importing the provider so
 * `types.ts` stays dependency-free. `providers/onnx/parsing.ts`'s `ParsingMap`
 * satisfies it.
 */
export interface ParsingLike {
  data: Uint8Array
  confidence: Float32Array
  width: number
  height: number
  scaleX: number
  scaleY: number
}

/** A single-channel probability map, 0–255, at its own resolution. */
export interface ProbabilityMask {
  data: Uint8Array
  width: number
  height: number
}

export interface VisionProvider {
  /** Stable identifier recorded on every analysis. */
  readonly id: string
  /** Which capabilities this provider actually implements. */
  readonly capabilities: VisionCapabilities
  /** Load models. Idempotent; safe to call concurrently. */
  initialize(): Promise<void>
  /** True once every required model file is present and loaded. */
  isReady(): boolean
  /** Why `isReady()` is false — surfaced verbatim to the operator. */
  readinessError(): string | null
  analyze(image: DecodedImage, thresholds: VisionThresholds): Promise<RawVisionResult>
  dispose(): Promise<void>
}

export interface VisionCapabilities {
  personDetection: boolean
  poseEstimation: boolean
  faceDetection: boolean
  faceLandmarks: boolean
  personSegmentation: boolean
  /** Per-pixel clothing classes. Without it, garment analysis reports `unknown`. */
  garmentSegmentation: boolean
}

// ─── Ports (injected by the host application) ────────────────────────────────

/**
 * Where mask bitmaps go. Vision Studio implements this over the filesystem
 * media store; Craftify would implement it over Cloudinary. The engine only
 * needs a handle back.
 */
export interface MaskSink {
  put(sourceHash: string, kind: 'person_mask' | 'garment_mask', png: Buffer, size: Size): Promise<string>
}

/**
 * Analysis reuse. The engine checks this before doing any work and writes
 * through after. Supplying a no-op cache is valid — it just means every call
 * recomputes.
 */
export interface VisionCache {
  get(sourceHash: string, engineVersion: string): Promise<VisionMetadata | null>
  set(metadata: VisionMetadata): Promise<void>
}

export interface VisionEngineOptions {
  provider: VisionProvider
  thresholds?: Partial<VisionThresholds>
  /** Longest edge fed to the models. Bounds inference cost. */
  analysisMaxDim?: number
  maskSink?: MaskSink
  cache?: VisionCache
  logger?: VisionLogger
}

export interface VisionLogger {
  debug(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

export class VisionUnavailableError extends Error {
  readonly code = 'VISION_UNAVAILABLE'
  constructor(message: string) {
    super(message)
    this.name = 'VisionUnavailableError'
  }
}
