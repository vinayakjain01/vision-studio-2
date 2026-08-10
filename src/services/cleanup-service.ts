/**
 * Deletion.
 *
 * Removing a row is the easy half. The hard half is the files: originals,
 * masks, cutouts, previews and creatives all live on disk, and a delete that
 * leaves them behind frees no space — which makes "delete" look broken on a
 * catalog measured in gigabytes.
 *
 * ── Content addressing makes this non-trivial ────────────────────────────────
 * Originals and everything derived from them are keyed by the sha256 of the
 * bytes, so ONE file can be referenced by several products. Deleting a product
 * therefore cannot simply delete its files — it has to check whether any image
 * still points at those bytes. Skipping that check would let deleting one
 * product silently break another that happened to contain the same photograph.
 *
 * The order matters: capture the (hash, key) pairs BEFORE the cascade, delete
 * the rows, then ask which hashes are now unreferenced. Asking first would
 * always answer "still referenced" — by the rows about to be removed.
 *
 * Creatives are different: each belongs to exactly one image+template, so its
 * file can be deleted outright.
 *
 * Server-only.
 */

import {
  batches,
  creatives,
  derivedAssets,
  images,
  imports,
  products,
  visionAnalyses,
} from '@/db/repositories'
import {
  deleteDirectory,
  deleteMedia,
  deleteDerivedTree,
  listMediaKeys,
  pruneEmptyDirectories,
  statMedia,
} from '@/storage/media-store'

export interface DeleteResult {
  /** Rows removed, by kind. */
  removed: { products?: number; images?: number; creatives?: number; batches?: number }
  /** Files removed from disk. */
  filesDeleted: number
  /** Disk space reclaimed, in bytes. */
  freedBytes: number
  /**
   * Originals kept because another product still references the same bytes.
   * Surfaced so "delete" never appears to have silently under-delivered.
   */
  sharedFilesKept: number
}

const EMPTY: DeleteResult = {
  removed: {},
  filesDeleted: 0,
  freedBytes: 0,
  sharedFilesKept: 0,
}

/** Sum the size of a file before removing it, so freed space can be reported. */
async function removeFile(root: 'originals' | 'derived' | 'creatives', key: string) {
  const stat = await statMedia(root, key)
  if (!stat) return 0
  await deleteMedia(root, key)
  return stat.size
}

/**
 * Delete every file belonging to source hashes that no image references any
 * more, plus the analysis and derived-asset rows keyed by them.
 *
 * Vision analyses are deleted too. They are only kilobytes and keeping them
 * would make re-importing the same photo instant, but "deleted" should mean
 * deleted — a user reclaiming space should not have to wonder what was left
 * behind.
 */
async function purgeUnreferenced(
  candidates: { sourceHash: string; storageKey: string }[]
): Promise<{ filesDeleted: number; freedBytes: number; sharedFilesKept: number }> {
  let filesDeleted = 0
  let freedBytes = 0
  let sharedFilesKept = 0

  // De-duplicate: one hash can appear on many images.
  const byHash = new Map<string, string>()
  for (const c of candidates) byHash.set(c.sourceHash, c.storageKey)

  for (const [sourceHash, storageKey] of byHash) {
    if (images.countByHash(sourceHash) > 0) {
      // Another product still uses these bytes — leave everything in place.
      sharedFilesKept++
      continue
    }

    // Derived assets first: their rows record the keys we need.
    for (const asset of derivedAssets.listForHash(sourceHash)) {
      const size = await removeFile('derived', asset.storageKey).catch(() => 0)
      if (size > 0) {
        filesDeleted++
        freedBytes += size
      }
    }
    // Sweep the whole per-hash directory in case a file was written without a row.
    await deleteDerivedTree(sourceHash).catch(() => {})
    derivedAssets.removeForHash(sourceHash)
    visionAnalyses.removeForHash(sourceHash)

    const size = await removeFile('originals', storageKey).catch(() => 0)
    if (size > 0) {
      filesDeleted++
      freedBytes += size
    }
  }

  return { filesDeleted, freedBytes, sharedFilesKept }
}

async function purgeCreativeFiles(keys: string[]): Promise<{ filesDeleted: number; freedBytes: number }> {
  let filesDeleted = 0
  let freedBytes = 0
  for (const key of keys) {
    const size = await removeFile('creatives', key).catch(() => 0)
    if (size > 0) {
      filesDeleted++
      freedBytes += size
    }
  }
  return { filesDeleted, freedBytes }
}

// ─── Public operations ───────────────────────────────────────────────────────

/**
 * Delete an import and everything that came from it: products, images,
 * creatives, and any media no longer referenced elsewhere.
 */
export async function deleteImport(importId: string): Promise<DeleteResult | null> {
  if (!imports.get(importId)) return null

  // Capture file references before the cascade removes the rows that name them.
  const hashes = images.hashesForImport(importId)
  const creativeKeys = creatives.keysForImport(importId)
  const productCount = products.count({ importId })

  imports.remove(importId) // cascades products → images → creatives

  const media = await purgeUnreferenced(hashes)
  const creativeFiles = await purgeCreativeFiles(creativeKeys)

  return {
    removed: {
      products: productCount,
      images: hashes.length,
      creatives: creativeKeys.length,
    },
    filesDeleted: media.filesDeleted + creativeFiles.filesDeleted,
    freedBytes: media.freedBytes + creativeFiles.freedBytes,
    sharedFilesKept: media.sharedFilesKept,
  }
}

export async function deleteProduct(productId: string): Promise<DeleteResult | null> {
  const product = products.get(productId)
  if (!product) return null

  const hashes = images.hashesForProduct(productId)
  const creativeKeys = creatives.keysForProduct(productId)

  products.remove(productId) // cascades images → creatives

  const media = await purgeUnreferenced(hashes)
  const creativeFiles = await purgeCreativeFiles(creativeKeys)

  return {
    removed: { products: 1, images: hashes.length, creatives: creativeKeys.length },
    filesDeleted: media.filesDeleted + creativeFiles.filesDeleted,
    freedBytes: media.freedBytes + creativeFiles.freedBytes,
    sharedFilesKept: media.sharedFilesKept,
  }
}

/**
 * Delete a generation batch and the creatives it produced.
 *
 * Originals are untouched — a batch is output, not input. Deleting a batch is
 * how you discard a bad run and try different settings, which would be
 * pointless if it also removed the photographs.
 */
export async function deleteBatch(batchId: string): Promise<DeleteResult | null> {
  if (!batches.get(batchId)) return null

  const creativeKeys = creatives.keysForBatch(batchId)

  // Delete the creative rows FIRST. `creatives.batch_id` is ON DELETE SET NULL,
  // so removing the batch first would orphan them — they would survive with a
  // null batch and become unreachable rows pointing at deleted files.
  const removedCreatives = creatives.removeForBatch(batchId)
  batches.remove(batchId) // cascades jobs

  const files = await purgeCreativeFiles(creativeKeys)
  // Creatives are stored under creatives/<batchId>/, so the directory is left
  // empty once its files are gone.
  await deleteDirectory('creatives', batchId).catch(() => {})

  return {
    removed: { batches: 1, creatives: removedCreatives },
    filesDeleted: files.filesDeleted,
    freedBytes: files.freedBytes,
    sharedFilesKept: 0,
  }
}

export async function deleteCreative(creativeId: string): Promise<DeleteResult | null> {
  const creative = creatives.get(creativeId)
  if (!creative) return null

  creatives.remove(creativeId)
  const files = await purgeCreativeFiles([creative.storageKey])

  return {
    removed: { creatives: 1 },
    filesDeleted: files.filesDeleted,
    freedBytes: files.freedBytes,
    sharedFilesKept: 0,
  }
}

/** Delete every creative, keeping products and photos. For starting output over. */
export async function deleteAllCreatives(): Promise<DeleteResult> {
  const all = creatives.list(100000, 0)
  if (all.length === 0) return EMPTY

  const keys = all.map(c => c.storageKey)
  for (const creative of all) creatives.remove(creative.id)

  const files = await purgeCreativeFiles(keys)

  return {
    removed: { creatives: all.length },
    filesDeleted: files.filesDeleted,
    freedBytes: files.freedBytes,
    sharedFilesKept: 0,
  }
}

// ─── Orphan sweep ────────────────────────────────────────────────────────────

export interface SweepResult {
  orphanedCreatives: number
  orphanedOriginals: number
  orphanedDerived: number
  emptyDirectories: number
  freedBytes: number
}

/**
 * Delete media files that no database row references.
 *
 * Files and rows can drift apart: an import interrupted mid-batch, a render that
 * wrote its output before the row was committed, or a schema reset that dropped
 * every table while leaving the bytes on disk. None of those are reachable
 * through the UI, so without a sweep they occupy space forever.
 *
 * Direction matters — this deletes files with no row, never rows with no file.
 * A missing file is a fixable problem (re-analyse, re-render); a deleted row is
 * lost information.
 */
export async function sweepOrphanedMedia(): Promise<SweepResult> {
  const result: SweepResult = {
    orphanedCreatives: 0,
    orphanedOriginals: 0,
    orphanedDerived: 0,
    emptyDirectories: 0,
    freedBytes: 0,
  }

  // Build the reference sets once; per-file queries would be thousands of reads.
  const creativeKeys = new Set(creatives.list(1_000_000, 0).map(c => c.storageKey))
  const imageRows = images.listByStatusAll()
  const originalKeys = new Set(imageRows.map(i => i.storageKey))
  const liveHashes = new Set(imageRows.map(i => i.sourceHash))

  for (const key of await listMediaKeys('creatives')) {
    if (creativeKeys.has(key)) continue
    result.freedBytes += await removeFile('creatives', key).catch(() => 0)
    result.orphanedCreatives++
  }

  for (const key of await listMediaKeys('originals')) {
    if (originalKeys.has(key)) continue
    result.freedBytes += await removeFile('originals', key).catch(() => 0)
    result.orphanedOriginals++
  }

  // Derived paths start <ab>/<cd>/<hash>/… so the hash is the third segment.
  for (const key of await listMediaKeys('derived')) {
    const hash = key.split('/')[2]
    if (hash && liveHashes.has(hash)) continue
    result.freedBytes += await removeFile('derived', key).catch(() => 0)
    result.orphanedDerived++
  }

  for (const root of ['creatives', 'originals', 'derived'] as const) {
    result.emptyDirectories += await pruneEmptyDirectories(root)
  }

  return result
}
