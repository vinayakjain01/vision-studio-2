/**
 * Vision Engine — public surface.
 *
 * Import from `@/vision` only. Reaching into `@/vision/providers/...` or
 * `@/vision/analysis/...` from outside this directory couples the host
 * application to the current model set, which is the one thing this boundary
 * exists to prevent.
 *
 * Minimal use:
 *
 *   const engine = new VisionEngine({
 *     provider: new OnnxVisionProvider({ modelDir: './models' }),
 *   })
 *   const metadata = await engine.analyze(bytes, { sourceHash })
 *
 * Vision Studio's wired-up instance, with cache and mask sink attached, is in
 * `src/services/vision-service.ts`. That file is the host adapter; this
 * directory is the portable core.
 */

export * from './types'
export { VisionEngine, DEFAULT_THRESHOLDS, type AnalyzeOptions } from './engine'
export {
  MODELS,
  MODEL_LIST,
  ENGINE_VERSION,
  type ModelId,
  type ModelSpec,
} from './model-registry'
export { OnnxVisionProvider, type OnnxProviderOptions } from './providers/onnx'
export {
  decodeForAnalysis,
  readImageMetadata,
  encodeMaskPng,
  encodePreview,
  applyMaskAsAlpha,
  type ImageMetadata,
} from './image'
export { deriveAnchors, anchorBounds, type AnchorContext } from './analysis/anchors'
export { classifyShot, supportsHeadFraming, HEAD_FRAMEABLE_SHOTS } from './analysis/shot-type'
export { analyzeGarment, type GarmentContext } from './analysis/garment'
export { assessQuality, type QualityContext } from './analysis/quality'
