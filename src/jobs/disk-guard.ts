/**
 * Low-disk guard (P6) — checked before accepting an upload's bytes, same
 * "reject before doing the expensive/irreversible thing" principle as
 * `src/jobs/quota.ts`'s per-tenant checks, but this one is a SERVER-WIDE
 * resource: no tenant's own quota controls how much free space the data
 * volume has, so this is deliberately a separate module and a separate
 * error type (503 — the server is out of a resource, not the caller over a
 * limit — see `src/lib/api-handler.ts`'s `mapKnownError`).
 *
 * Server-only.
 */

import fs from 'fs/promises'
import { config } from '@/config'

export class InsufficientDiskSpaceError extends Error {
  constructor(
    message: string,
    readonly freeBytes: number,
    readonly minFreeBytes: number
  ) {
    super(message)
    this.name = 'InsufficientDiskSpaceError'
  }
}

/**
 * Throws if the data volume has less than `config.jobs.diskMinFreeBytes`
 * free. `fs.statfs` isn't available on every platform/filesystem — if it
 * throws, this FAILS OPEN (lets the upload proceed) rather than blocking
 * every upload because the check itself couldn't run; a genuinely full disk
 * will still fail the write itself immediately afterward, just without this
 * guard's clearer up-front message.
 */
export async function assertDiskSpaceAvailable(): Promise<void> {
  let freeBytes: number
  try {
    const stat = await fs.statfs(config.paths.dataDir)
    freeBytes = stat.bavail * stat.bsize
  } catch {
    return
  }

  if (freeBytes < config.jobs.diskMinFreeBytes) {
    const freeGb = (freeBytes / 1024 / 1024 / 1024).toFixed(2)
    const minGb = (config.jobs.diskMinFreeBytes / 1024 / 1024 / 1024).toFixed(2)
    throw new InsufficientDiskSpaceError(
      `The server is low on disk space (${freeGb} GB free, minimum ${minGb} GB required) and cannot accept new uploads right now.`,
      freeBytes,
      config.jobs.diskMinFreeBytes
    )
  }
}
