/**
 * The Vision Engine.
 *
 * Orchestrates one analysis end to end: decode → provider inference →
 * subject selection → mask persistence → garment analysis → anchors → shot
 * classification → quality. Returns a `VisionMetadata` document and, via the
 * injected cache, makes it reusable forever.
 *
 * ── Why this ordering ────────────────────────────────────────────────────────
 * Anchors depend on the garment analysis (for `garment_top`/`garment_hem`), and
 * the shot classifier depends on the anchors (it asks which landmarks are in
 * frame). Garment analysis in turn depends on the pose. The sequence is
 * therefore fixed, and each stage takes only what the previous ones produced —
 * no stage reaches back into the model outputs.
 *
 * ── Reuse in Craftify ────────────────────────────────────────────────────────
 * Nothing in this file, or anywhere under `src/vision/`, imports the database,
 * the HTTP layer, or Vision Studio's storage. Persistence enters through
 * `MaskSink` and `VisionCache`. Dropping this directory into Craftify requires
 * implementing those two interfaces over Cloudinary and Supabase, and nothing
 * else.
 */

import {
  VISION_SCHEMA_VERSION,
  VisionUnavailableError,
  type Box,
  type MaskRef,
  type ProbabilityMask,
  type SegmentationResult,
  type VisionEngineOptions,
  type VisionLogger,
  type VisionMetadata,
  type VisionProvider,
  type VisionThresholds,
} from './types'
import { ENGINE_VERSION } from './model-registry'
import { decodeForAnalysis, encodeMaskPng } from './image'
import { selectPrimaryPerson } from './providers/onnx/pose'
import { selectPrimaryFace } from './providers/onnx/face'
import { maskStats } from './providers/onnx/segmentation'
import { deriveAnchors } from './analysis/anchors'
import { analyzeGarment } from './analysis/garment'
import { classifyShot } from './analysis/shot-type'
import { assessQuality } from './analysis/quality'
import type { ParsingMap } from './providers/onnx/parsing'

/** A mask paired with the factors that take its pixels to source space. */
interface ScaledMask {
  mask: ProbabilityMask | null
  scaleX: number
  scaleY: number
}

export const DEFAULT_THRESHOLDS: VisionThresholds = {
  personScore: 0.35,
  personNmsIou: 0.45,
  faceScore: 0.5,
  faceNmsIou: 0.4,
  keypointScore: 0.3,
  maskBinary: 0.5,
}

const NULL_LOGGER: VisionLogger = {
  debug: () => {},
  warn: () => {},
  error: () => {},
}

export interface AnalyzeOptions {
  /** sha256 of `bytes` — the cache key. Computed by the caller, which usually
   *  already has it from content-addressed storage. */
  sourceHash: string
  /** Ignore any cached analysis and recompute. */
  force?: boolean
}

export class VisionEngine {
  private readonly provider: VisionProvider
  private readonly thresholds: VisionThresholds
  private readonly analysisMaxDim: number
  private readonly maskSink: VisionEngineOptions['maskSink']
  private readonly cache: VisionEngineOptions['cache']
  private readonly log: VisionLogger

  constructor(options: VisionEngineOptions) {
    this.provider = options.provider
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds }
    this.analysisMaxDim = options.analysisMaxDim ?? 1280
    this.maskSink = options.maskSink
    this.cache = options.cache
    this.log = options.logger ?? NULL_LOGGER
  }

  get engineVersion(): string {
    return ENGINE_VERSION
  }

  async initialize(): Promise<void> {
    await this.provider.initialize()
  }

  isReady(): boolean {
    return this.provider.isReady()
  }

  readinessError(): string | null {
    return this.provider.readinessError()
  }

  capabilities() {
    return this.provider.capabilities
  }

  async analyze(bytes: Buffer, options: AnalyzeOptions): Promise<VisionMetadata> {
    const { sourceHash, force = false } = options

    if (!force && this.cache) {
      const cached = await this.cache.get(sourceHash, ENGINE_VERSION)
      if (cached && cached.schemaVersion === VISION_SCHEMA_VERSION) {
        this.log.debug('vision cache hit', { sourceHash })
        return cached
      }
    }

    await this.provider.initialize()
    if (!this.provider.isReady()) {
      throw new VisionUnavailableError(
        this.provider.readinessError() ?? 'vision provider is not ready'
      )
    }

    const started = performance.now()
    const timings: Record<string, number> = {}

    // ── Decode ────────────────────────────────────────────────────────────
    const decodeStart = performance.now()
    const image = await decodeForAnalysis(bytes, this.analysisMaxDim)
    timings.decode = Math.round(performance.now() - decodeStart)

    // ── Inference ─────────────────────────────────────────────────────────
    const raw = await this.provider.analyze(image, this.thresholds)
    Object.assign(timings, raw.timings)

    const analysisStart = performance.now()

    // ── Subject selection ─────────────────────────────────────────────────
    const primaryPersonIndex = selectPrimaryPerson(raw.persons, image.sourceWidth)
    const primaryPerson =
      primaryPersonIndex !== null ? raw.persons[primaryPersonIndex] : null

    const primaryFaceIndex = selectPrimaryFace(raw.faces, primaryPerson?.box ?? null)
    const primaryFace = primaryFaceIndex !== null ? raw.faces[primaryFaceIndex] : null

    // ── Mask geometry ─────────────────────────────────────────────────────
    // Masks come back at the model's own resolution. These factors take mask
    // pixels to SOURCE pixels, and every consumer below uses them rather than
    // assuming mask and image share a coordinate space.
    const personMask = raw.personMask
    const maskScaleX = personMask ? image.sourceWidth / personMask.width : 1
    const maskScaleY = personMask ? image.sourceHeight / personMask.height : 1

    // ── Garment ───────────────────────────────────────────────────────────
    // `parsing` is the ONNX provider's ParsingMap. The cast is confined to
    // this line: `RawVisionResult` declares the structural shape so `types.ts`
    // stays free of provider imports, and the analysis layer wants the nominal
    // type for its helpers.
    const parsing = raw.parsing as ParsingMap | null

    const garmentResult = analyzeGarment({
      imageWidth: image.sourceWidth,
      imageHeight: image.sourceHeight,
      person: primaryPerson,
      parsing,
    })

    // ── Persist masks ─────────────────────────────────────────────────────
    // The garment mask arrives at parse resolution, which differs from the
    // matte's — so it carries its own scale factors.
    const garmentMask: ProbabilityMask | null = garmentResult.mask
      ? {
          data: garmentResult.mask.data,
          width: garmentResult.mask.width,
          height: garmentResult.mask.height,
        }
      : null

    const segmentation = await this.persistMasks(
      sourceHash,
      { mask: personMask, scaleX: maskScaleX, scaleY: maskScaleY },
      garmentMask
        ? {
            mask: garmentMask,
            scaleX: image.sourceWidth / garmentMask.width,
            scaleY: image.sourceHeight / garmentMask.height,
          }
        : null,
      timings
    )

    // ── Anchors ───────────────────────────────────────────────────────────
    const anchors = deriveAnchors({
      imageWidth: image.sourceWidth,
      imageHeight: image.sourceHeight,
      person: primaryPerson,
      face: primaryFace,
      personMask,
      maskScaleX,
      maskScaleY,
      maskThreshold: this.thresholds.maskBinary,
      garment: garmentResult.analysis,
      parsing,
    })

    // ── Shot classification ───────────────────────────────────────────────
    const subjectBox = resolveSubjectBox(
      segmentation.person,
      primaryPerson?.box ?? null,
      garmentResult.analysis.box
    )

    const shot = classifyShot({
      imageWidth: image.sourceWidth,
      imageHeight: image.sourceHeight,
      person: primaryPerson,
      face: primaryFace,
      anchors,
      garment: garmentResult.analysis,
      personCoverage: segmentation.person?.coverage ?? 0,
      subjectBox,
    })

    // ── Quality ───────────────────────────────────────────────────────────
    const capabilities = this.provider.capabilities
    const quality = assessQuality({
      imageWidth: image.sourceWidth,
      imageHeight: image.sourceHeight,
      persons: raw.persons,
      primaryPerson,
      faces: raw.faces,
      primaryFace,
      anchors,
      segmentation,
      garment: garmentResult.analysis,
      shot,
      capabilities: {
        faceDetection: capabilities.faceDetection,
        personSegmentation: capabilities.personSegmentation,
      },
    })

    timings.analysis = Math.round(performance.now() - analysisStart)

    const metadata: VisionMetadata = {
      schemaVersion: VISION_SCHEMA_VERSION,
      sourceHash,
      image: { width: image.sourceWidth, height: image.sourceHeight },
      persons: raw.persons,
      primaryPersonIndex,
      faces: raw.faces,
      primaryFaceIndex,
      segmentation,
      garment: garmentResult.analysis,
      anchors,
      shot,
      quality,
      engineVersion: ENGINE_VERSION,
      provider: this.provider.id,
      modelVersions: raw.modelVersions,
      timings,
      durationMs: Math.round(performance.now() - started),
      createdAt: new Date().toISOString(),
    }

    if (this.cache) {
      await this.cache.set(metadata).catch(err => {
        // A cache write failure must not fail the analysis — the result is
        // valid, it just will not be reused.
        this.log.warn('vision cache write failed', { sourceHash, error: String(err) })
      })
    }

    return metadata
  }

  private async persistMasks(
    sourceHash: string,
    person: ScaledMask | null,
    garment: ScaledMask | null,
    timings: Record<string, number>
  ): Promise<SegmentationResult> {
    const result: SegmentationResult = { person: null, garment: null }
    if (!person?.mask && !garment?.mask) return result

    const start = performance.now()

    const toRef = async (
      mask: ProbabilityMask,
      kind: 'person_mask' | 'garment_mask',
      maskScaleX: number,
      maskScaleY: number
    ): Promise<MaskRef | null> => {
      const stats = maskStats(mask, this.thresholds.maskBinary)
      if (!stats.bbox) return null

      // Without a sink the mask geometry is still returned — anchors and shot
      // classification work from statistics, not from the stored bytes. Only
      // the debug overlay needs the actual PNG.
      let ref = ''
      if (this.maskSink) {
        try {
          const png = await encodeMaskPng(mask)
          ref = await this.maskSink.put(sourceHash, kind, png, {
            width: mask.width,
            height: mask.height,
          })
        } catch (err) {
          this.log.warn('mask persistence failed', { sourceHash, kind, error: String(err) })
        }
      }

      return {
        ref,
        width: mask.width,
        height: mask.height,
        // Project the mask-space bbox into source space so consumers never
        // need the scale factors.
        bbox: {
          left: stats.bbox.left * maskScaleX,
          top: stats.bbox.top * maskScaleY,
          right: stats.bbox.right * maskScaleX,
          bottom: stats.bbox.bottom * maskScaleY,
        },
        coverage: stats.coverage,
        meanProbability: stats.meanProbability,
      }
    }

    if (person?.mask) {
      result.person = await toRef(person.mask, 'person_mask', person.scaleX, person.scaleY)
    }
    if (garment?.mask) {
      result.garment = await toRef(garment.mask, 'garment_mask', garment.scaleX, garment.scaleY)
    }

    timings.mask_persist = Math.round(performance.now() - start)
    return result
  }

  async dispose(): Promise<void> {
    await this.provider.dispose()
  }
}

/**
 * The rectangle that best describes "the subject", preferring the tightest
 * reliable source: the matte, then the person box, then the garment box.
 */
function resolveSubjectBox(
  personMask: MaskRef | null,
  personBox: Box | null,
  garmentBox: Box | null
): Box | null {
  if (personMask) return personMask.bbox
  if (personBox) return personBox
  return garmentBox
}
