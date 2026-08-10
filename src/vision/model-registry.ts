/**
 * Model manifest.
 *
 * Every entry was downloaded and inspected before being written here: the
 * digests are sha256 of the actual bytes (NOT the Hugging Face ETag, which for
 * Xet-backed repositories is a different hash entirely), and every tensor shape
 * below was read back from a real inference run, not from documentation.
 *
 * `npm run models:fetch` downloads and verifies against this table.
 * `src/vision/providers/onnx/` decodes strictly according to the `io` blocks.
 *
 * Changing any model here must bump `ENGINE_VERSION` — stored analyses are
 * keyed by it, so a model swap produces new rows rather than silently
 * reinterpreting old ones.
 */

export type ModelId = 'pose' | 'face' | 'segmentation' | 'parsing'

export interface ModelSpec {
  id: ModelId
  /** Filename under the model directory. */
  file: string
  /** Human-readable model name + version, recorded on every analysis. */
  version: string
  url: string
  sha256: string
  byteSize: number
  license: string
  licenseUrl: string
  /** False for models the engine can run without (degraded, not broken). */
  required: boolean
  description: string
}

export const MODELS: Record<ModelId, ModelSpec> = {
  // ── Person detection + pose ────────────────────────────────────────────────
  // Single model doing double duty: person boxes AND the COCO-17 skeleton. One
  // forward pass for both is why the engine can afford full-resolution-mapped
  // landmarks on every image in a bulk import.
  //
  // Input   images        float32 [1, 3, 640, 640], RGB, 0–1, letterboxed
  // Output  output0       float32 [1, 56, 8400]
  //         56 channels = 4 box (cx, cy, w, h, in input px)
  //                     + 1 person confidence
  //                     + 51 keypoints (17 × [x, y, score])
  //         8400 anchors = 80² + 40² + 20²  (strides 8, 16, 32)
  pose: {
    id: 'pose',
    file: 'yolov8n-pose.onnx',
    version: 'yolov8n-pose@ultralytics-8.x',
    url: 'https://huggingface.co/Xenova/yolov8n-pose/resolve/main/onnx/model.onnx',
    sha256: '04f6d2416266f2aba6c5ba8b26de33ed9eba3279f972ac02e33f9f1366547586',
    byteSize: 13_484_153,
    license: 'AGPL-3.0',
    licenseUrl: 'https://github.com/ultralytics/ultralytics/blob/main/LICENSE',
    required: true,
    description: 'Person detection and 17-point COCO pose estimation.',
  },

  // ── Face detection + 5-point landmarks ─────────────────────────────────────
  // SCRFD-10G from the InsightFace buffalo_l pack. Chosen over a plain face
  // detector because the five landmarks give a reliable eye line, which is what
  // makes `head_top` an extrapolation of a few percent rather than a guess.
  //
  // Input   input.1       float32 [1, 3, H, W], BGR, (px - 127.5) / 128.0
  // Outputs 9 tensors, in session.outputNames order:
  //         [0..2] scores  [N, 1]   strides 8, 16, 32
  //         [3..5] bboxes  [N, 4]   left/top/right/bottom distances, × stride
  //         [6..8] kps     [N, 10]  5 × (dx, dy) distances, × stride
  //         N = (H/stride) × (W/stride) × 2 anchors
  //         At 640×640: 12800, 3200, 800.
  face: {
    id: 'face',
    file: 'scrfd-10g.onnx',
    version: 'scrfd-10g-bnkps@insightface-buffalo_l',
    url: 'https://huggingface.co/immich-app/buffalo_l/resolve/main/detection/model.onnx',
    sha256: '5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91',
    byteSize: 16_923_827,
    license: 'MIT (InsightFace model zoo — non-commercial research terms apply upstream)',
    licenseUrl: 'https://github.com/deepinsight/insightface/tree/master/model_zoo',
    required: false,
    description: 'Face boxes with 5-point landmarks (eyes, nose, mouth corners).',
  },

  // ── Human matting ──────────────────────────────────────────────────────────
  // MODNet produces a soft alpha matte rather than a hard mask, which matters
  // for hair and sheer fabric — a binary silhouette clips both, and a clipped
  // silhouette moves the `feet`/`head_top` anchors by several pixels.
  //
  // Input   input         float32 [1, 3, H, W], RGB, (px/255 - 0.5) / 0.5
  //                       H and W must be multiples of 32.
  // Output  output        float32 [1, 1, H, W], alpha in 0–1
  segmentation: {
    id: 'segmentation',
    file: 'modnet.onnx',
    version: 'modnet-photographic@onnx',
    url: 'https://huggingface.co/Xenova/modnet/resolve/main/onnx/model.onnx',
    sha256: '07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9',
    byteSize: 25_888_640,
    license: 'Apache-2.0',
    licenseUrl: 'https://github.com/ZHKKKe/MODNet/blob/master/LICENSE',
    required: false,
    description: 'Human alpha matting for the person silhouette and cutouts.',
  },

  // ── Human parsing (garment semantics) ──────────────────────────────────────
  // SegFormer-B2 fine-tuned on ATR. This is what makes garment analysis a
  // measurement rather than an inference: it labels dress / upper-clothes /
  // skirt / pants / arms / legs / hair per pixel, so "where is the hem" and
  // "how long are the sleeves" are read off the map instead of guessed from a
  // silhouette. A human matte alone cannot answer either — it cannot tell a
  // bare forearm from a sleeve, or a hemline from the top of a boot.
  //
  // Input   pixel_values  float32 [1, 3, 512, 512], RGB, /255 then ImageNet
  //                       mean (0.485, 0.456, 0.406) std (0.229, 0.224, 0.225)
  // Output  logits        float32 [1, 18, 128, 128]
  //                       SegFormer decodes at 1/4 input resolution; argmax
  //                       over the 18 channels gives the ATR class per cell.
  parsing: {
    id: 'parsing',
    file: 'segformer-b2-clothes.onnx',
    version: 'segformer-b2-clothes@atr-18',
    url: 'https://huggingface.co/mattmdjaga/segformer_b2_clothes/resolve/main/onnx/model.onnx',
    sha256: 'a93a8dac171b5c1fcc53632a8bfc180bfd9759ea69a3e207451bb07f76add54f',
    byteSize: 110_039_290,
    license: 'MIT',
    licenseUrl: 'https://huggingface.co/mattmdjaga/segformer_b2_clothes',
    required: false,
    description: 'Per-pixel garment parsing — 18 ATR classes (dress, top, skirt, pants, arms, legs, hair).',
  },
}

export const MODEL_LIST: ModelSpec[] = Object.values(MODELS)

/**
 * Identifies the analysis pipeline as a whole: the model set plus the version
 * of the interpretation code in `src/vision/analysis/`.
 *
 * Cached analyses are keyed by this string. Bump it whenever a model changes,
 * a threshold default changes, or anchor/shot-type/garment logic changes in a
 * way that would produce different numbers for the same pixels. Not bumping it
 * means stale results get reused; bumping it unnecessarily just costs one
 * re-analysis pass.
 */
export const ENGINE_VERSION =
  'vision-1.0.2+pose-yolov8n+face-scrfd10g+seg-modnet+parse-segformerb2'

// ── Model-specific input geometry ────────────────────────────────────────────

/** Square letterboxed input edge for the pose model. Fixed by the export. */
export const POSE_INPUT_SIZE = 640

/** Square letterboxed input edge for SCRFD. The export accepts any multiple of 32. */
export const FACE_INPUT_SIZE = 640

/**
 * Longest edge for MODNet. The matte is upsampled back to source resolution, so
 * this trades matte crispness for time. 512 keeps a full import responsive;
 * hair detail beyond it is finer than any framing decision depends on.
 */
export const SEG_INPUT_MAX = 512

/** MODNet requires both input dimensions to be a multiple of this. */
export const SEG_INPUT_MULTIPLE = 32

/** SCRFD decode constants, read off the real output shapes (see comment above). */
export const SCRFD_STRIDES = [8, 16, 32] as const
export const SCRFD_ANCHORS_PER_LOCATION = 2

/** COCO-17 keypoint count encoded in the pose head. */
export const POSE_KEYPOINT_COUNT = 17

/** `4 box + 1 score + 17 × 3` — the 56 in [1, 56, 8400]. */
export const POSE_CHANNELS = 4 + 1 + POSE_KEYPOINT_COUNT * 3

/** SegFormer input edge. The export is fixed at 512². */
export const PARSING_INPUT_SIZE = 512

/** ImageNet normalisation, as SegformerImageProcessor applies it. */
export const PARSING_MEAN: [number, number, number] = [0.485 * 255, 0.456 * 255, 0.406 * 255]
export const PARSING_STD: [number, number, number] = [0.229 * 255, 0.224 * 255, 0.225 * 255]

/**
 * ATR label set, in channel order. Index is the class id emitted by the argmax
 * over the parsing logits.
 */
export const ATR_LABELS = [
  'background',
  'hat',
  'hair',
  'sunglasses',
  'upper_clothes',
  'skirt',
  'pants',
  'dress',
  'belt',
  'left_shoe',
  'right_shoe',
  'face',
  'left_leg',
  'right_leg',
  'left_arm',
  'right_arm',
  'bag',
  'scarf',
] as const

export type AtrLabel = (typeof ATR_LABELS)[number]

/** Numeric ids for the classes the analysis layer reasons about by name. */
export const ATR = {
  background: 0,
  hat: 1,
  hair: 2,
  sunglasses: 3,
  upper_clothes: 4,
  skirt: 5,
  pants: 6,
  dress: 7,
  belt: 8,
  left_shoe: 9,
  right_shoe: 10,
  face: 11,
  left_leg: 12,
  right_leg: 13,
  left_arm: 14,
  right_arm: 15,
  bag: 16,
  scarf: 17,
} as const

/** Classes that are clothing worn on the body (excludes bag, shoes, hat). */
export const GARMENT_CLASSES: number[] = [
  ATR.upper_clothes,
  ATR.skirt,
  ATR.pants,
  ATR.dress,
  ATR.belt,
  ATR.scarf,
]

/** Classes covering the torso and above. */
export const UPPER_GARMENT_CLASSES: number[] = [ATR.upper_clothes, ATR.dress, ATR.scarf]

/** Classes covering the legs. */
export const LOWER_GARMENT_CLASSES: number[] = [ATR.skirt, ATR.pants]

/** Exposed skin — the complement of clothing over the limbs. */
export const SKIN_CLASSES: number[] = [
  ATR.face,
  ATR.left_arm,
  ATR.right_arm,
  ATR.left_leg,
  ATR.right_leg,
]

/** Everything belonging to the person, clothing and body alike. */
export const PERSON_CLASSES: number[] = [
  ATR.hat,
  ATR.hair,
  ATR.sunglasses,
  ATR.upper_clothes,
  ATR.skirt,
  ATR.pants,
  ATR.dress,
  ATR.belt,
  ATR.left_shoe,
  ATR.right_shoe,
  ATR.face,
  ATR.left_leg,
  ATR.right_leg,
  ATR.left_arm,
  ATR.right_arm,
  ATR.scarf,
]

/** Head region — used for a precise crown that includes hair and headwear. */
export const HEAD_CLASSES: number[] = [ATR.hat, ATR.hair, ATR.face, ATR.sunglasses]
