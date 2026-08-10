/**
 * Folder import.
 *
 * Takes uploaded files, extracts metadata, stores originals content-addressed,
 * groups them into products, and queues vision analysis.
 *
 * ── Deduplication ────────────────────────────────────────────────────────────
 * Originals are keyed by sha256 of their bytes, so re-importing a folder is
 * cheap and idempotent: identical bytes are written once, and any analysis
 * already computed for that hash is reused immediately — the re-import finishes
 * with zero inference. This is why the import never re-encodes or downscales on
 * the way in; doing so would change the hash and defeat both.
 *
 * Server-only.
 */

import { readImageMetadata } from '@/vision'
import { putOriginal, hashBytes } from '@/storage/media-store'
import { imports, images, products, visionAnalyses } from '@/db/repositories'
import { enqueue } from '@/jobs/queue'
import { ensurePoolRunning } from '@/jobs/pool'
import { ENGINE_VERSION } from '@/vision/model-registry'
import {
  classifyFile,
  groupIntoProducts,
  normalizePath,
  toDisplayName,
  slugify,
  type SkipReason,
} from './file-rules'
import type { ImportRecord } from '@/db/types'

export interface IncomingFile {
  /** Path within the picked directory tree, e.g. "AW25/dresses/red/01.jpg". */
  relativePath: string
  fileName: string
  mimeType: string
  bytes: Buffer
}

export type IngestOutcome =
  | { status: 'imported'; imageId: string; productId: string; deduplicated: boolean; reusedAnalysis: boolean }
  | { status: 'duplicate'; imageId: string; productId: string }
  | { status: 'skipped'; reason: SkipReason }
  | { status: 'failed'; error: string }

export interface IngestResult {
  relativePath: string
  outcome: IngestOutcome
}

export function createImport(name: string, rootPath?: string, totalFiles = 0): ImportRecord {
  return imports.create({ name, rootPath: rootPath ?? null, totalFiles })
}

/**
 * Ingest a batch of files into an import.
 *
 * Files are processed sequentially rather than in parallel. Each one decodes an
 * image and writes to disk; running a whole batch of 4000×6000 studio files
 * concurrently would hold every decoded buffer in memory at once. Throughput
 * here is dominated by disk, not CPU, so the sequence costs little.
 */
export async function ingestFiles(
  importId: string,
  files: IncomingFile[]
): Promise<IngestResult[]> {
  const record = imports.get(importId)
  if (!record) throw new Error(`import ${importId} not found`)

  // Grouping needs the whole batch: a product's identity comes from its folder,
  // and position within the product from the sorted sibling list.
  const grouped = groupIntoProducts(
    files.map(f => ({ relativePath: f.relativePath, name: f.fileName }))
  )
  const groupByPath = new Map(grouped.map(g => [g.relativePath, g]))

  const results: IngestResult[] = []
  const toQueue: { imageId: string; sourceHash: string; storageKey: string }[] = []

  let imported = 0
  let skipped = 0
  let failed = 0
  let duplicates = 0

  for (const file of files) {
    const relativePath = normalizePath(file.relativePath)

    const classification = classifyFile({
      relativePath,
      name: file.fileName,
      mimeType: file.mimeType,
      size: file.bytes.byteLength,
    })

    if (!classification.accepted) {
      skipped++
      results.push({ relativePath, outcome: { status: 'skipped', reason: classification.reason! } })
      continue
    }

    try {
      const outcome = await ingestOne(importId, file, relativePath, groupByPath)
      results.push({ relativePath, outcome })

      if (outcome.status === 'imported') {
        imported++
        if (!outcome.reusedAnalysis) {
          const image = images.get(outcome.imageId)
          if (image) {
            toQueue.push({
              imageId: image.id,
              sourceHash: image.sourceHash,
              storageKey: image.storageKey,
            })
          }
        }
      } else if (outcome.status === 'duplicate') {
        duplicates++
      }
    } catch (err) {
      failed++
      results.push({
        relativePath,
        outcome: { status: 'failed', error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  imports.bump(importId, { imported, skipped, failed, duplicate: duplicates }, 'importing')

  if (toQueue.length > 0) {
    enqueue(
      toQueue.map(item => ({
        kind: 'vision' as const,
        payload: {
          imageId: item.imageId,
          sourceHash: item.sourceHash,
          storageKey: item.storageKey,
        },
        // Analysis before rendering: a render job that runs first would produce
        // a centred fit instead of landmark framing.
        priority: 10,
        // One analysis per unique content, however many products reference it.
        dedupeKey: `vision:${item.sourceHash}`,
      }))
    )
    ensurePoolRunning()
  }

  return results
}

async function ingestOne(
  importId: string,
  file: IncomingFile,
  relativePath: string,
  groupByPath: Map<string, ReturnType<typeof groupIntoProducts>[number]>
): Promise<IngestOutcome> {
  const metadata = await readImageMetadata(file.bytes)

  if (metadata.width === 0 || metadata.height === 0) {
    return { status: 'failed', error: 'image could not be decoded' }
  }

  const group = groupByPath.get(relativePath)
  const productName = group?.productName ?? toDisplayName(file.fileName)
  const productSlug = group?.productSlug ?? slugify(productName)
  const folderPath = group?.folderPath ?? ''
  const category = group?.category ?? null
  const position = group?.position ?? 0

  const product = products.upsert({
    importId,
    name: productName,
    slug: productSlug,
    folderPath,
    category,
  })

  const sourceHash = hashBytes(file.bytes)

  // Same bytes already attached to this product — a re-run of the same upload.
  const existing = images.findByProductAndHash(product.id, sourceHash)
  if (existing) {
    return { status: 'duplicate', imageId: existing.id, productId: product.id }
  }

  const stored = await putOriginal(file.bytes, metadata.mimeType)

  // These bytes may already be analysed, from another product or an earlier
  // import. If so the image is ready on arrival and never enters the queue.
  const analysis = visionAnalyses.find(sourceHash, ENGINE_VERSION)
  const reusedAnalysis = analysis?.status === 'ready'

  const image = images.create({
    productId: product.id,
    importId,
    sourceHash,
    storageKey: stored.key,
    fileName: file.fileName,
    relativePath,
    mimeType: metadata.mimeType,
    byteSize: file.bytes.byteLength,
    width: metadata.width,
    height: metadata.height,
    exifOrientation: metadata.exifOrientation,
    hasAlpha: metadata.hasAlpha,
    colorSpace: metadata.colorSpace,
    capturedAt: metadata.capturedAt,
    cameraMake: metadata.cameraMake,
    cameraModel: metadata.cameraModel,
    position,
    isPrimary: position === 0,
  })

  if (reusedAnalysis) {
    images.setVisionStatus(image.id, 'ready')
  }

  products.refreshCounters(product.id)

  return {
    status: 'imported',
    imageId: image.id,
    productId: product.id,
    deduplicated: stored.deduplicated,
    reusedAnalysis,
  }
}

export function finalizeImport(importId: string): ImportRecord | null {
  imports.bump(importId, {}, 'completed')
  return imports.get(importId)
}

/**
 * Re-queue analysis for every image in an import.
 *
 * The usual reason is that models were installed after the import ran, so
 * everything is sitting at `unavailable`. `force` also covers a deliberate
 * re-analysis after an engine-version bump.
 */
export function reanalyzeImport(importId: string, force = false): number {
  const list = images.listByImport(importId, 100000)
  const pending = force
    ? list
    : list.filter(i => i.visionStatus !== 'ready')

  if (pending.length === 0) return 0

  for (const image of pending) images.setVisionStatus(image.id, 'pending')

  const { inserted } = enqueue(
    pending.map(image => ({
      kind: 'vision' as const,
      payload: {
        imageId: image.id,
        sourceHash: image.sourceHash,
        storageKey: image.storageKey,
        force,
      },
      priority: 10,
      dedupeKey: `vision:${image.sourceHash}${force ? ':force' : ''}`,
    }))
  )

  if (inserted > 0) ensurePoolRunning()
  return inserted
}

/** Re-queue every image not currently `ready`, across all imports. */
export function reanalyzeAllPending(): number {
  const pending = [
    ...images.listByStatus('pending', 100000),
    ...images.listByStatus('unavailable', 100000),
    ...images.listByStatus('failed', 100000),
  ]
  if (pending.length === 0) return 0

  const { inserted } = enqueue(
    pending.map(image => ({
      kind: 'vision' as const,
      payload: {
        imageId: image.id,
        sourceHash: image.sourceHash,
        storageKey: image.storageKey,
      },
      priority: 10,
      dedupeKey: `vision:${image.sourceHash}`,
    }))
  )

  if (inserted > 0) ensurePoolRunning()
  return inserted
}
