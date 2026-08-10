/**
 * Storage usage, and a sweep for files nothing references.
 *
 * `GET` reports what is on disk per media root. `POST` deletes files with no
 * database row — residue from an interrupted import, a crashed render, or a
 * schema reset that dropped rows while leaving the bytes behind.
 */

import { config } from '@/config'
import { listMediaKeys, statMedia, type MediaRoot } from '@/storage/media-store'
import { sweepOrphanedMedia } from '@/services/cleanup-service'
import { handler, ok } from '@/lib/api'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const ROOTS: MediaRoot[] = ['originals', 'derived', 'creatives', 'assets']

export const GET = handler(async () => {
  const usage: Record<string, { files: number; bytes: number }> = {}
  let totalBytes = 0
  let totalFiles = 0

  for (const root of ROOTS) {
    const keys = await listMediaKeys(root)
    let bytes = 0
    for (const key of keys) {
      const stat = await statMedia(root, key)
      bytes += stat?.size ?? 0
    }
    usage[root] = { files: keys.length, bytes }
    totalBytes += bytes
    totalFiles += keys.length
  }

  return ok({ usage, totalBytes, totalFiles, dataDir: config.paths.dataDir })
})

export const POST = handler(async () => {
  return ok(await sweepOrphanedMedia())
})
