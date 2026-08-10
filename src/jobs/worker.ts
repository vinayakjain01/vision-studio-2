/**
 * Job handlers — the actual work behind a `vision` or `render` job.
 *
 * Runs inside a worker thread (see `pool.ts`). Each handler is a plain async
 * function over a payload; the pool owns claiming, retries and heartbeats, so
 * nothing here touches queue state.
 *
 * Server-only.
 */

import { analyzeStoredImage, getUsableAnalysis, propagateVisionStatus } from '@/services/vision-service'
import {
  renderCreative,
  buildInpaintTarget,
  computeOverflow,
  hasOverflow,
  inpaintCacheKind,
} from '@/render/compositor'
import { inpaint } from '@/services/inpaint-client'
import { creatives, images, products, templates, visionAnalyses } from '@/db/repositories'
import {
  readMedia,
  writeFileAtomic,
  creativeKey,
  derivedKey,
  mediaExists,
  putDerived,
} from '@/storage/media-store'
import * as queue from './queue'
import { ENGINE_VERSION } from '@/vision/model-registry'
import { VisionUnavailableError } from '@/vision/types'
import type { BackgroundFillJobPayload, RenderJobPayload, VisionJobPayload } from '@/db/types'

export interface HandlerResult {
  [key: string]: unknown
}

/**
 * A render job for an `ai_extend` template found no cached background yet.
 * Distinct from a real failure — see `queue.defer()` and how
 * `src/jobs/worker-entry.ts` treats this differently from every other thrown
 * error: it reschedules the job a few seconds out instead of consuming a
 * retry attempt in a hot loop, because the fix here isn't "try again and
 * hope", it's "wait for the `background_fill` job that's already running".
 */
export class BackgroundNotReadyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackgroundNotReadyError'
  }
}

// ─── Vision ──────────────────────────────────────────────────────────────────

export async function handleVisionJob(payload: VisionJobPayload): Promise<HandlerResult> {
  const { sourceHash, storageKey, imageId, force } = payload

  images.setVisionStatus(imageId, 'processing')

  try {
    const { metadata, fromCache } = await analyzeStoredImage(sourceHash, storageKey, { force })

    // Content-addressed: one analysis resolves every image with these bytes.
    propagateVisionStatus(sourceHash, 'ready')

    return {
      fromCache,
      shotType: metadata.shot.type,
      garmentType: metadata.garment.type,
      persons: metadata.persons.length,
      faces: metadata.faces.length,
      confidence: metadata.quality.overall,
      durationMs: metadata.durationMs,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    if (err instanceof VisionUnavailableError) {
      // The models are missing — not a property of this image. Mark it
      // `unavailable` so it is distinguishable from a genuine analysis failure
      // and can be swept back into the queue once models are installed, and
      // let the queue park the job rather than burning retries on every image
      // in the catalog for the same reason.
      propagateVisionStatus(sourceHash, 'unavailable')
      visionAnalyses.putFailure({
        sourceHash,
        engineVersion: ENGINE_VERSION,
        schemaVersion: 1,
        provider: 'onnx',
        status: 'unavailable',
        error: message,
      })
      throw err
    }

    propagateVisionStatus(sourceHash, 'failed')
    visionAnalyses.putFailure({
      sourceHash,
      engineVersion: ENGINE_VERSION,
      schemaVersion: 1,
      provider: 'onnx',
      status: 'failed',
      error: message,
    })
    throw err
  }
}

// ─── Render ──────────────────────────────────────────────────────────────────

export async function handleRenderJob(
  payload: RenderJobPayload,
  context: { batchId: string | null }
): Promise<HandlerResult> {
  const { imageId, productId, templateId, sourceHash } = payload

  // A batch cancelled while this job was in flight should not produce output.
  // Checked here, immediately before the expensive part, because cancellation
  // cannot interrupt a running job — see queue.cancelBatch.
  if (context.batchId && queue.isBatchCancelled(context.batchId)) {
    return { skipped: true, reason: 'batch cancelled' }
  }

  const image = images.get(imageId)
  if (!image) throw new Error(`image ${imageId} no longer exists`)

  const template = templates.get(templateId)
  if (!template) throw new Error(`template ${templateId} no longer exists`)

  const product = products.get(productId)

  const { metadata } = getUsableAnalysis(sourceHash)
  const analysisRecord = visionAnalyses.find(sourceHash, ENGINE_VERSION)

  const source = await readMedia('originals', image.storageKey)

  // AI Extend's actual generation happens in its OWN job kind, on its OWN
  // worker slots (see src/jobs/pool.ts) — never here. This render job's part
  // is just: does a cached result already exist? If so, read it. If not,
  // make sure a `background_fill` job is queued for it and step aside —
  // deferring (see `queue.defer` and `BackgroundNotReadyError` below) rather
  // than blocking this render worker on a GPU call that belongs to a
  // different pool entirely.
  let precomputedBackground: Buffer | null = null
  if (template.document.background.mode === 'ai_extend') {
    const overflow = await computeOverflow(source, metadata, template.document)
    if (hasOverflow(overflow)) {
      const kind = inpaintCacheKind(overflow, template.document.background.backdropPrompt)
      const key = derivedKey(sourceHash, kind, 'jpg')

      if (await mediaExists('derived', key)) {
        precomputedBackground = await readMedia('derived', key)
      } else {
        ensureBackgroundFillQueued(payload)
        throw new BackgroundNotReadyError(
          `waiting for AI-extended background (template ${templateId}, photo ${sourceHash.slice(0, 12)})`
        )
      }
    }
  }

  const result = await renderCreative({
    source,
    vision: metadata,
    template: template.document,
    variables: {
      product_name: product?.name ?? image.fileName,
      category: product?.category ?? '',
      folder: product?.folderPath ?? '',
      file_name: image.fileName,
      shot_type: metadata?.shot.type ?? 'unknown',
      garment_type: metadata?.garment.type ?? 'unknown',
      index: String(image.position + 1),
    },
    precomputedBackground,
  })

  const extension = result.mimeType === 'image/png' ? 'png' : 'jpg'
  const key = creativeKey(context.batchId ?? 'adhoc', `${imageId}_${templateId}`, extension)
  const { byteSize } = await writeFileAtomic('creatives', key, result.buffer, { overwrite: true })

  creatives.put({
    productId,
    imageId,
    templateId,
    batchId: context.batchId,
    sourceHash,
    visionId: analysisRecord?.id ?? null,
    storageKey: key,
    mimeType: result.mimeType,
    width: result.width,
    height: result.height,
    byteSize,
    framing: result.framing,
    renderMs: result.durationMs,
  })

  return {
    storageKey: key,
    width: result.width,
    height: result.height,
    strategy: result.framing.strategyId,
    usedFallback: result.framing.usedFallback,
    violations: result.framing.violations.length,
    renderMs: result.durationMs,
    // A creative rendered without an analysis is a centred fit, not landmark
    // framing. Recorded so the batch report can distinguish the two.
    hadVision: metadata !== null,
  }
}

/**
 * Queue the `background_fill` job a render is waiting on, if one is not
 * already accounted for. `dedupeKey` is scoped to (photo, template) rather
 * than the full cache key (which also folds in the exact padding/prompt) —
 * the point is "don't queue a second one while any generation for this photo
 * against this template is already running", which holds even across a
 * mid-batch prompt edit, not "don't queue one with these exact bytes twice".
 *
 * Called every time a render job re-checks whether its background is ready
 * (every `BACKGROUND_FILL_POLL_MS`) — so this also has to avoid asking for a
 * FRESH attempt on every single check once the last one failed. The live
 * dedupe index (enforced at insert) only blocks while a job is pending,
 * claimed or running; once one fails, a bare `enqueue` call would insert a
 * brand new one on the very next check, turning "the inpaint service is
 * down" into a retry storm against exactly the service that just said no.
 * `findRecent` catches the failed case too and backs off instead.
 */
function ensureBackgroundFillQueued(payload: RenderJobPayload): void {
  const dedupeKey = `bgfill:${payload.sourceHash}:${payload.templateId}`
  const recent = queue.findRecent(dedupeKey, queue.BACKGROUND_FILL_RETRY_COOLDOWN_MS)
  if (recent) return

  queue.enqueue([
    {
      kind: 'background_fill',
      payload: {
        imageId: payload.imageId,
        productId: payload.productId,
        templateId: payload.templateId,
        sourceHash: payload.sourceHash,
      },
      // Ahead of ordinary renders (priority 50, see generation-service.ts):
      // every render blocked on the same background should not have to wait
      // behind a queue of OTHER images' plain renders before its own
      // dependency even starts.
      priority: 20,
      dedupeKey,
    },
  ])
}

// ─── Background fill (AI Extend) ────────────────────────────────────────────

/**
 * Generate and cache one photo's AI-Extended background. Runs on its own
 * dedicated worker slots (`src/jobs/pool.ts`), never the vision/render pool —
 * this is a network call to a GPU-hosted service, not local CPU work.
 *
 * Idempotent by construction: the derived-asset cache is checked again right
 * before the (comparatively expensive) service call, so if two render jobs
 * raced to queue this for the same photo+template, the second `background_fill`
 * job to actually run finds the first one's result already cached and does
 * nothing further.
 */
export async function handleBackgroundFillJob(
  payload: BackgroundFillJobPayload
): Promise<HandlerResult> {
  const { imageId, templateId, sourceHash } = payload

  const image = images.get(imageId)
  if (!image) throw new Error(`image ${imageId} no longer exists`)

  const template = templates.get(templateId)
  if (!template) throw new Error(`template ${templateId} no longer exists`)

  if (template.document.background.mode !== 'ai_extend') {
    // The template was switched to a plain mode after this job was queued —
    // not an error, just stale intent.
    return { skipped: true, reason: 'template no longer uses ai_extend' }
  }

  const { metadata } = getUsableAnalysis(sourceHash)
  const source = await readMedia('originals', image.storageKey)

  const target = await buildInpaintTarget(source, metadata, template.document)
  if (!target) {
    return { skipped: true, reason: 'no overflow to fill' }
  }

  const kind = inpaintCacheKind(target.overflow, template.document.background.backdropPrompt)
  const key = derivedKey(sourceHash, kind, 'jpg')

  if (await mediaExists('derived', key)) {
    return { skipped: true, reason: 'already cached' }
  }

  const prompt = template.document.background.backdropPrompt?.trim() || undefined
  const result = await inpaint({ image: target.paddedImage, mask: target.mask, prompt })

  await putDerived(sourceHash, kind, 'jpg', result.image)

  return { cached: true, key, width: target.width, height: target.height }
}
