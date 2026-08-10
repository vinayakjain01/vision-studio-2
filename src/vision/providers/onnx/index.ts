/**
 * The ONNX vision provider.
 *
 * Runs the three models and returns raw detections. It performs no semantic
 * interpretation — no anchors, no shot type, no garment reasoning. That split
 * is what keeps the engine swappable: a future provider (a different model set,
 * a GPU backend, a hosted service) only has to produce this same
 * `RawVisionResult`, and every downstream behaviour is inherited unchanged.
 *
 * Degradation is explicit. Only `pose` is required. Without `face`, head
 * anchors fall back to keypoint extrapolation at lower confidence; without
 * `segmentation`, mask-derived anchors are absent and the garment analyser
 * reports `unknown`. Each of those is a documented reduced capability that
 * shows up in `capabilities` and in the quality warnings — never a silent
 * substitution of a guess for a measurement.
 */

import type {
  DecodedImage,
  RawVisionResult,
  VisionCapabilities,
  VisionProvider,
  VisionThresholds,
} from '@/vision/types'
import { OnnxSessionManager } from './session'
import { runPose } from './pose'
import { runFace } from './face'
import { runSegmentation } from './segmentation'
import { runParsing } from './parsing'

export interface OnnxProviderOptions {
  modelDir: string
  threads?: number
}

export class OnnxVisionProvider implements VisionProvider {
  readonly id = 'onnx'

  private readonly sessions: OnnxSessionManager
  private initialized = false
  private initializing: Promise<void> | null = null

  private hasPose = false
  private hasFace = false
  private hasSegmentation = false
  private hasParsing = false

  constructor(options: OnnxProviderOptions) {
    this.sessions = new OnnxSessionManager({
      modelDir: options.modelDir,
      threads: options.threads,
    })
  }

  get capabilities(): VisionCapabilities {
    return {
      personDetection: this.hasPose,
      poseEstimation: this.hasPose,
      faceDetection: this.hasFace,
      faceLandmarks: this.hasFace,
      personSegmentation: this.hasSegmentation,
      garmentSegmentation: this.hasParsing,
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initializing) return this.initializing

    this.initializing = (async () => {
      const [pose, face, seg, parse] = await Promise.all([
        this.sessions.get('pose'),
        this.sessions.get('face'),
        this.sessions.get('segmentation'),
        this.sessions.get('parsing'),
      ])
      this.hasPose = pose !== null
      this.hasFace = face !== null
      this.hasSegmentation = seg !== null
      this.hasParsing = parse !== null
      this.initialized = true
    })().finally(() => {
      this.initializing = null
    })

    return this.initializing
  }

  isReady(): boolean {
    return this.initialized && this.hasPose
  }

  readinessError(): string | null {
    if (!this.initialized) return 'provider not initialised'
    if (!this.hasPose) {
      return (
        this.sessions.error('pose') ??
        'pose model unavailable — run `npm run models:fetch`'
      )
    }
    return null
  }

  /** Non-fatal gaps, surfaced to the operator before a bulk run. */
  degradations(): string[] {
    const out: string[] = []
    if (!this.hasFace) {
      out.push(
        this.sessions.error('face') ??
          'face model unavailable — head anchors fall back to pose keypoints'
      )
    }
    if (!this.hasSegmentation) {
      out.push(
        this.sessions.error('segmentation') ??
          'segmentation model unavailable — person mask and cutout are skipped'
      )
    }
    if (!this.hasParsing) {
      out.push(
        this.sessions.error('parsing') ??
          'parsing model unavailable — garment type, hem, sleeves and neckline report "unknown"'
      )
    }
    return out
  }

  async analyze(image: DecodedImage, thresholds: VisionThresholds): Promise<RawVisionResult> {
    await this.initialize()

    const poseSession = await this.sessions.get('pose')
    if (!poseSession) {
      throw new Error(this.readinessError() ?? 'pose model unavailable')
    }

    const timings: Record<string, number> = {}

    const time = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
      const start = performance.now()
      try {
        return await fn()
      } finally {
        timings[label] = Math.round(performance.now() - start)
      }
    }

    // The three models are independent, but they are run SEQUENTIALLY on
    // purpose. Each already saturates the CPU through ORT's own intra-op
    // threading; interleaving them just multiplies peak memory (three sets of
    // activations for a 640² and a 512² graph at once) and makes throughput
    // worse under the worker pool, where several images are already in flight.
    const persons = await time('pose', () =>
      runPose(poseSession, image, {
        scoreThreshold: thresholds.personScore,
        nmsIou: thresholds.personNmsIou,
        keypointThreshold: thresholds.keypointScore,
      })
    )

    let faces: RawVisionResult['faces'] = []
    const faceSession = await this.sessions.get('face')
    if (faceSession) {
      faces = await time('face', () =>
        runFace(faceSession, image, {
          scoreThreshold: thresholds.faceScore,
          nmsIou: thresholds.faceNmsIou,
        })
      )
    }

    let personMask: RawVisionResult['personMask'] = null
    const segSession = await this.sessions.get('segmentation')
    if (segSession) {
      personMask = await time('segmentation', () => runSegmentation(segSession, image))
    }

    let parsing: RawVisionResult['parsing'] = null
    const parseSession = await this.sessions.get('parsing')
    if (parseSession) {
      parsing = await time('parsing', () => runParsing(parseSession, image))
    }

    return {
      persons,
      faces,
      personMask,
      parsing,
      timings,
      modelVersions: this.sessions.loadedVersions(),
    }
  }

  async dispose(): Promise<void> {
    await this.sessions.dispose()
    this.initialized = false
  }
}
