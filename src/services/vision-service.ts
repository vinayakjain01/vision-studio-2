/**
 * Host adapter for the Vision Engine.
 *
 * `src/vision/` knows nothing about SQLite or the filesystem. This file supplies
 * the two ports it needs — a `VisionCache` over the `vision_analyses` table and
 * a `MaskSink` over the media store — and hands back a configured singleton.
 *
 * It is the ONLY place the portable core meets Vision Studio's infrastructure.
 * Porting the engine into Craftify means writing a sibling of this file against
 * Supabase and Cloudinary; nothing under `src/vision/` changes.
 *
 * Server-only (used from route handlers and worker threads alike).
 */

import {
  VisionEngine,
  OnnxVisionProvider,
  ENGINE_VERSION,
  encodePreview,
  applyMaskAsAlpha,
  type MaskSink,
  type VisionCache,
  type VisionMetadata,
  type Size,
} from '@/vision'
import { config } from '@/config'
import { derivedAssets, visionAnalyses, images } from '@/db/repositories'
import { putDerived, readMedia, mediaUrl } from '@/storage/media-store'
import type { DerivedAssetKind } from '@/db/types'

// ─── Ports ───────────────────────────────────────────────────────────────────

/**
 * Masks land in `derived/<hash>/…png` and get a row in `derived_assets`. The
 * handle returned to the engine is the storage key, which the debug panel turns
 * into a URL.
 */
const maskSink: MaskSink = {
  async put(sourceHash, kind, png, size: Size) {
    const { key, byteSize } = await putDerived(sourceHash, kind, 'png', png)
    derivedAssets.put({
      sourceHash,
      kind: kind as DerivedAssetKind,
      storageKey: key,
      mimeType: 'image/png',
      width: size.width,
      height: size.height,
      byteSize,
    })
    return key
  },
}

/**
 * Analyses are keyed by (sourceHash, engineVersion). A model or logic change
 * bumps the version, so old rows are neither read nor overwritten — creatives
 * rendered against the previous version stay explainable.
 */
const cache: VisionCache = {
  async get(sourceHash, engineVersion) {
    const record = visionAnalyses.find(sourceHash, engineVersion)
    if (!record || record.status !== 'ready') return null
    // A row whose payload failed to parse is worse than a miss — recomputing is
    // cheap next to serving a half-empty document to the framing solver.
    if (!record.payload || !record.payload.schemaVersion) return null
    return record.payload
  },

  async set(metadata) {
    visionAnalyses.put(metadata)
  },
}

// ─── Singleton ───────────────────────────────────────────────────────────────

declare global {
  var __visionEngine: VisionEngine | undefined
  var __visionProvider: OnnxVisionProvider | undefined
}

function build(): { engine: VisionEngine; provider: OnnxVisionProvider } {
  const provider = new OnnxVisionProvider({
    modelDir: config.paths.modelDir,
    threads: config.vision.ortThreads,
  })

  const engine = new VisionEngine({
    provider,
    analysisMaxDim: config.vision.analysisMaxDim,
    thresholds: {
      personScore: config.vision.personScoreThreshold,
      personNmsIou: config.vision.personNmsIou,
      faceScore: config.vision.faceScoreThreshold,
      faceNmsIou: config.vision.faceNmsIou,
      keypointScore: config.vision.keypointScoreThreshold,
      maskBinary: config.vision.maskBinaryThreshold,
    },
    maskSink,
    cache,
    logger: {
      debug: () => {},
      warn: (message, meta) => console.warn(`[vision] ${message}`, meta ?? ''),
      error: (message, meta) => console.error(`[vision] ${message}`, meta ?? ''),
    },
  })

  return { engine, provider }
}

export function getVisionEngine(): VisionEngine {
  if (!global.__visionEngine) {
    const { engine, provider } = build()
    global.__visionEngine = engine
    global.__visionProvider = provider
  }
  return global.__visionEngine
}

export function getVisionProvider(): OnnxVisionProvider {
  getVisionEngine()
  return global.__visionProvider!
}

// ─── Status ──────────────────────────────────────────────────────────────────

export interface VisionEngineStatus {
  ready: boolean
  engineVersion: string
  error: string | null
  degradations: string[]
  capabilities: ReturnType<VisionEngine['capabilities']>
  modelDir: string
}

/**
 * Whether analysis can run, and what is missing if it cannot.
 *
 * Surfaced in the UI before a bulk import so an operator learns the parsing
 * model is absent up front, rather than from four thousand creatives with
 * `unknown` garment data.
 */
export async function getVisionStatus(): Promise<VisionEngineStatus> {
  const engine = getVisionEngine()
  const provider = getVisionProvider()
  await engine.initialize()

  return {
    ready: engine.isReady(),
    engineVersion: ENGINE_VERSION,
    error: engine.readinessError(),
    degradations: provider.degradations(),
    capabilities: engine.capabilities(),
    modelDir: config.paths.modelDir,
  }
}

// ─── Analysis ────────────────────────────────────────────────────────────────

export interface AnalyzeImageResult {
  metadata: VisionMetadata
  fromCache: boolean
}

/**
 * Analyse one stored image and record the derived assets.
 *
 * Also writes a preview JPEG and, when a matte exists, a transparent cutout.
 * Neither is needed for framing — both exist for the UI, and neither failing is
 * allowed to fail the analysis.
 */
export async function analyzeStoredImage(
  sourceHash: string,
  storageKey: string,
  options: { force?: boolean } = {}
): Promise<AnalyzeImageResult> {
  const engine = getVisionEngine()
  await engine.initialize()

  const existing = options.force ? null : visionAnalyses.find(sourceHash, ENGINE_VERSION)
  if (existing?.status === 'ready' && existing.payload?.schemaVersion) {
    return { metadata: existing.payload, fromCache: true }
  }

  const bytes = await readMedia('originals', storageKey)
  const metadata = await engine.analyze(bytes, { sourceHash, force: options.force })

  await writeCompanionAssets(sourceHash, storageKey, bytes, metadata).catch(err => {
    console.warn(`[vision] companion assets failed for ${sourceHash}:`, err?.message ?? err)
  })

  return { metadata, fromCache: false }
}

async function writeCompanionAssets(
  sourceHash: string,
  storageKey: string,
  bytes: Buffer,
  metadata: VisionMetadata
): Promise<void> {
  if (!derivedAssets.find(sourceHash, 'preview')) {
    const preview = await encodePreview(bytes, 1024)
    const { key, byteSize } = await putDerived(sourceHash, 'preview', 'jpg', preview)
    derivedAssets.put({
      sourceHash,
      kind: 'preview',
      storageKey: key,
      mimeType: 'image/jpeg',
      width: Math.min(1024, metadata.image.width),
      height: Math.min(1024, metadata.image.height),
      byteSize,
    })
  }

  const personMask = metadata.segmentation.person
  if (personMask?.ref && !derivedAssets.find(sourceHash, 'cutout')) {
    const maskPng = await readMedia('derived', personMask.ref)
    // Cap the cutout's longest edge: a full-resolution RGBA PNG of a 6000px
    // studio file is ~140 MB, and nothing in the UI displays it at that size.
    const scale = Math.min(1, 2048 / Math.max(metadata.image.width, metadata.image.height))
    const target = {
      width: Math.round(metadata.image.width * scale),
      height: Math.round(metadata.image.height * scale),
    }
    const cutout = await applyMaskAsAlphaFromPng(bytes, maskPng, target)
    const { key, byteSize } = await putDerived(sourceHash, 'cutout', 'png', cutout)
    derivedAssets.put({
      sourceHash,
      kind: 'cutout',
      storageKey: key,
      mimeType: 'image/png',
      width: target.width,
      height: target.height,
      byteSize,
    })
  }
}

/**
 * The engine's `applyMaskAsAlpha` wants a raw probability map; what is on disk
 * is the PNG it wrote. Decode back to raw and hand it over.
 */
async function applyMaskAsAlphaFromPng(
  sourceBytes: Buffer,
  maskPng: Buffer,
  target: Size
): Promise<Buffer> {
  const sharp = (await import('sharp')).default
  const { data, info } = await sharp(maskPng).raw().toBuffer({ resolveWithObject: true })
  return applyMaskAsAlpha(
    sourceBytes,
    {
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      width: info.width,
      height: info.height,
    },
    target
  )
}

// ─── Read helpers for the UI ─────────────────────────────────────────────────

export interface VisionAssets {
  preview: string | null
  personMask: string | null
  garmentMask: string | null
  cutout: string | null
}

export function getVisionAssetUrls(sourceHash: string): VisionAssets {
  const assets = derivedAssets.listForHash(sourceHash)
  const find = (kind: DerivedAssetKind) => {
    const asset = assets.find(a => a.kind === kind)
    return asset ? mediaUrl('derived', asset.storageKey) : null
  }
  return {
    preview: find('preview'),
    personMask: find('person_mask'),
    garmentMask: find('garment_mask'),
    cutout: find('cutout'),
  }
}

/**
 * The analysis a consumer should use for an image: the current engine version
 * if present, otherwise the most recent one.
 *
 * Falling back rather than returning null keeps the app usable straight after a
 * version bump — every product page and preview still works, showing slightly
 * stale landmarks, while re-analysis works through the queue.
 */
export function getUsableAnalysis(sourceHash: string): {
  metadata: VisionMetadata | null
  stale: boolean
} {
  const current = visionAnalyses.find(sourceHash, ENGINE_VERSION)
  if (current?.status === 'ready' && current.payload?.schemaVersion) {
    return { metadata: current.payload, stale: false }
  }

  const latest = visionAnalyses.latest(sourceHash)
  if (latest?.status === 'ready' && latest.payload?.schemaVersion) {
    return { metadata: latest.payload, stale: true }
  }

  return { metadata: null, stale: false }
}

/** Queue-facing helper: mark every image with this hash after an analysis run. */
export function propagateVisionStatus(
  sourceHash: string,
  status: 'ready' | 'failed' | 'unavailable'
): void {
  images.setVisionStatusByHash(sourceHash, status)
}

export { ENGINE_VERSION }
