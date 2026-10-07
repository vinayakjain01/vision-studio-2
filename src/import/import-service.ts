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

import fsp from 'fs/promises'
import { readImageMetadata } from '@/vision'
import { putOriginalFromFile } from '@/storage/media-store'
import { imports, images, products, visionAnalyses } from '@/db/repositories'
import { transaction } from '@/db/client'
import { enqueue } from '@/jobs/queue'
import { ensurePoolRunning } from '@/jobs/pool'
import { assertCanEnqueue } from '@/jobs/quota'
import { currentTenant } from '@/tenancy/context'
import { ENGINE_VERSION } from '@/vision/model-registry'
import {
  classifyFile,
  groupIntoProducts,
  naturalCompare,
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
  /**
   * Already-complete file written to the tenant's tmp/ dir by the streaming
   * multipart parser (see the files-upload route) — never held in memory as
   * a whole Buffer. Every exit path that does NOT end in `putOriginalFromFile`
   * actually moving it (skipped, duplicate, failed) must delete it itself;
   * see `cleanupTempFile` below.
   */
  tempPath: string
  /** Computed while streaming to tempPath — never recomputed from a second read. */
  sourceHash: string
  byteSize: number
}

async function cleanupTempFile(tempPath: string): Promise<void> {
  await fsp.rm(tempPath, { force: true }).catch(() => {})
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
      size: file.byteSize,
    })

    if (!classification.accepted) {
      skipped++
      results.push({ relativePath, outcome: { status: 'skipped', reason: classification.reason! } })
      await cleanupTempFile(file.tempPath)
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
      // ingestOne can throw before ever reaching putOriginalFromFile (e.g.
      // readImageMetadata rejecting a decompression-bomb image) — that path
      // never moves/deletes the temp file itself, so it's cleaned up here.
      await cleanupTempFile(file.tempPath)
    }
  }

  imports.bump(importId, { imported, skipped, failed, duplicate: duplicates }, 'importing')

  if (toQueue.length > 0) {
    const tenantId = currentTenant().tenantId
    // Files are already stored and their DB rows already created by this
    // point — a quota that blocks QUEUEING analysis must not undo or fail
    // that. Images simply stay at their current vision_status (queueable
    // again later, manually or via the next import) rather than the whole
    // upload response failing for a problem that has nothing to do with
    // whether the files themselves were valid.
    try {
      assertCanEnqueue(tenantId, toQueue.length)
    } catch (err) {
      console.warn(`[import] vision analysis not queued for ${importId}: ${(err as Error).message}`)
      return results
    }
    enqueue(
      tenantId,
      toQueue.map(item => ({
        kind: 'vision' as const,
        // Import analysis is the canonical 'bulk' case.
        priorityClass: 'bulk' as const,
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
  // Reads from the temp file directly — sharp streams the header off disk,
  // never needing the whole file resident as a Buffer. Rejects a
  // decompression-bomb image (see readImageMetadata's MAX_INPUT_PIXELS) by
  // throwing, which the caller's try/catch turns into a 'failed' outcome and
  // cleans up the temp file for.
  const metadata = await readImageMetadata(file.tempPath, file.byteSize)

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

  const sourceHash = file.sourceHash

  // Same bytes already attached to this product — a re-run of the same upload.
  const existing = images.findByProductAndHash(product.id, sourceHash)
  if (existing) {
    // Never moved into content-addressed storage — nothing else will clean
    // this up, since the caller's try/catch only covers a throw, not this
    // early return.
    await cleanupTempFile(file.tempPath)
    return { status: 'duplicate', imageId: existing.id, productId: product.id }
  }

  const stored = await putOriginalFromFile(file.tempPath, sourceHash, metadata.mimeType)

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
    byteSize: file.byteSize,
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

/**
 * Recompute shot order and the primary image for every product in an import.
 *
 * Upload batches are bounded by bytes, so a folder's files can arrive in
 * different requests — and `ingestFiles` only sees the siblings in ITS batch,
 * so each batch numbers its files from 0 and marks its own first file primary.
 * Ordering across the whole folder is only knowable once everything is in, so
 * it is settled here, from the stored file names. This also makes the result
 * independent of the order batches happen to land in.
 */
function renumberImport(importId: string): void {
  const byProduct = new Map<string, ReturnType<typeof images.listByImport>>()
  for (const image of images.listByImport(importId, 100000)) {
    const list = byProduct.get(image.productId)
    if (list) list.push(image)
    else byProduct.set(image.productId, [image])
  }

  transaction(() => {
    for (const list of byProduct.values()) {
      list
        .sort((a, b) => naturalCompare(a.fileName, b.fileName))
        .forEach((image, index) => {
          const isPrimary = index === 0
          if (image.position !== index || image.isPrimary !== isPrimary) {
            images.setPosition(image.id, index, isPrimary)
          }
        })
    }
  })
}

export function finalizeImport(importId: string): ImportRecord | null {
  renumberImport(importId)
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

  const tenantId = currentTenant().tenantId
  assertCanEnqueue(tenantId, pending.length)

  for (const image of pending) images.setVisionStatus(image.id, 'pending')

  const { inserted } = enqueue(
    tenantId,
    pending.map(image => ({
      kind: 'vision' as const,
      priorityClass: 'bulk' as const,
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

  const tenantId = currentTenant().tenantId
  assertCanEnqueue(tenantId, pending.length)

  const { inserted } = enqueue(
    tenantId,
    pending.map(image => ({
      kind: 'vision' as const,
      priorityClass: 'bulk' as const,
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
