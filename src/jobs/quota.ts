/**
 * Quota enforcement — checked at enqueue/upload time, never inside a worker.
 * By the time a job is running, the slot is already spent; rejecting early
 * means the caller (an API route) can surface a clear, structured error
 * immediately instead of a job silently failing minutes later.
 *
 * Every check reads `quotas` (control.db, admin-editable, schema since P1)
 * and throws `QuotaExceededError` — a stable `code` plus the limit and
 * current usage, so the UI (P4) can render "12/20 concurrent uploads" rather
 * than parsing a message string.
 *
 * Server-only.
 */

import { quotas, usageCounters } from '@/db/control-repositories'
import * as queue from './queue'

export type QuotaCode = 'max_queued_jobs' | 'max_images_per_batch' | 'max_concurrent_uploads' | 'max_storage_bytes'

export class QuotaExceededError extends Error {
  constructor(
    message: string,
    readonly code: QuotaCode,
    readonly limit: number,
    readonly current: number
  ) {
    super(message)
    this.name = 'QuotaExceededError'
  }
}

/** Queued (not yet finished) jobs for this tenant, across every kind. */
function currentlyQueued(tenantId: string): number {
  const s = queue.stats(undefined, tenantId)
  return s.pending + s.claimed + s.running
}

/** Call before `queue.enqueue()` with however many jobs are about to be inserted. */
export function assertCanEnqueue(tenantId: string, additionalJobs: number): void {
  if (additionalJobs <= 0) return
  const quota = quotas.getOrThrow(tenantId)
  const current = currentlyQueued(tenantId)
  if (current + additionalJobs > quota.maxQueuedJobs) {
    throw new QuotaExceededError(
      `Queueing ${additionalJobs} more job(s) would exceed this workspace's queued-job limit ` +
        `(${current} already queued, limit ${quota.maxQueuedJobs}). Wait for some of the current ` +
        `queue to finish, or retry with a smaller batch.`,
      'max_queued_jobs',
      quota.maxQueuedJobs,
      current
    )
  }
}

/** Call before ingesting an import batch, with the total image count the batch would reach. */
export function assertImagesPerBatch(tenantId: string, totalImageCount: number): void {
  const quota = quotas.getOrThrow(tenantId)
  if (totalImageCount > quota.maxImagesPerBatch) {
    throw new QuotaExceededError(
      `This import has ${totalImageCount} images, over this workspace's limit of ` +
        `${quota.maxImagesPerBatch} per batch. Split it into smaller imports.`,
      'max_images_per_batch',
      quota.maxImagesPerBatch,
      totalImageCount
    )
  }
}

/**
 * Call before accepting an upload's bytes, with how many more bytes it would
 * add. Checked against the incrementally-tracked gauge (see media-
 * store.ts's `writeFileAtomic`/`reconcileStorageUsage`) — it can drift
 * slightly low between reconciliations for reasons documented there, which
 * means this can occasionally accept an upload that pushes slightly over
 * the limit rather than slightly under; never the other way around in a way
 * that blocks a legitimate upload.
 */
export function assertStorageBudget(tenantId: string, additionalBytes: number): void {
  const quota = quotas.getOrThrow(tenantId)
  const usage = usageCounters.get(tenantId)
  if (usage.storageBytes + additionalBytes > quota.maxStorageBytes) {
    throw new QuotaExceededError(
      `This upload would exceed this workspace's storage limit ` +
        `(${usage.storageBytes} used + ${additionalBytes} new > ${quota.maxStorageBytes} bytes). ` +
        `Delete unused imports or creatives, or ask an admin to raise the storage limit.`,
      'max_storage_bytes',
      quota.maxStorageBytes,
      usage.storageBytes
    )
  }
}

/**
 * Concurrent upload REQUESTS in flight, per tenant — not a job-queue
 * concept at all (an upload is a synchronous HTTP request handling
 * multipart form data), so this is plain in-process state rather than a
 * control.db table. Correct because every upload is handled by this same
 * Next.js server process — unlike the AI Extend dispatcher's concurrency
 * cap, nothing here runs in a separate worker process that this state
 * would fail to see.
 */
const uploadsInFlight = new Map<string, number>()

/** Returns true (and reserves a slot) if under the per-tenant concurrent-upload cap; false otherwise. Always pair with `releaseUploadSlot` in a `finally`. */
export function tryAcquireUploadSlot(tenantId: string): boolean {
  const quota = quotas.getOrThrow(tenantId)
  const current = uploadsInFlight.get(tenantId) ?? 0
  if (current >= quota.maxConcurrentUploads) return false
  uploadsInFlight.set(tenantId, current + 1)
  return true
}

export function releaseUploadSlot(tenantId: string): void {
  const current = uploadsInFlight.get(tenantId) ?? 0
  uploadsInFlight.set(tenantId, Math.max(0, current - 1))
}

/** Throws QuotaExceededError('max_concurrent_uploads') if at capacity — the throwing counterpart to `tryAcquireUploadSlot` for call sites that want one line. */
export function assertUploadSlotAvailable(tenantId: string): void {
  const quota = quotas.getOrThrow(tenantId)
  const current = uploadsInFlight.get(tenantId) ?? 0
  if (current >= quota.maxConcurrentUploads) {
    throw new QuotaExceededError(
      `This workspace already has ${current} upload(s) in progress (limit ${quota.maxConcurrentUploads}) — ` +
        'wait for one to finish before starting another.',
      'max_concurrent_uploads',
      quota.maxConcurrentUploads,
      current
    )
  }
}
