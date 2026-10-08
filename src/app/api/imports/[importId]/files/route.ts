/**
 * Upload a batch of files into an open import.
 *
 * Multipart, STREAMED (busboy) rather than buffered via `request.formData()`
 * — the previous version fully materialized every file's bytes in memory
 * before any size check could help, so the per-file and per-request caps
 * only ever rejected AFTER paying the memory cost they exist to bound (see
 * docs/MULTI_TENANCY.md's P0 investigation). Each file part is piped
 * straight to a temp file under the tenant's own tmp/ dir while being
 * hashed incrementally — the bytes are read off the wire exactly once, not
 * once to buffer and again to hash — and both the per-file and per-request
 * caps are enforced DURING that stream, destroying it early rather than
 * finishing the read first.
 *
 * Each file part carries its path within the picked directory in a parallel
 * `paths` field, because `File.webkitRelativePath` is not preserved through
 * `FormData` — only the base name survives, and the folder structure is
 * exactly what product grouping and the rules engine depend on. Busboy
 * emits parts in the order they appear in the request body, and the client
 * (`import-client.tsx`) appends one `files` part immediately followed by
 * its `paths` part for every file, so pairing them up by arrival INDEX
 * (not by field name) reproduces the same correspondence
 * `form.getAll('files')[i]`/`form.getAll('paths')[i]` used to give for free.
 */

import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { Readable } from 'stream'
import Busboy from 'busboy'
import { NextRequest } from 'next/server'
import { ingestFiles, type IncomingFile } from '@/import/import-service'
import { imports } from '@/db/repositories'
import { MAX_REQUEST_BYTES, MAX_FILE_BYTES, normalizePath, baseName } from '@/import/file-rules'
import { assertImagesPerBatch, assertStorageBudget, tryAcquireUploadSlot, releaseUploadSlot } from '@/jobs/quota'
import { assertDiskSpaceAvailable } from '@/jobs/disk-guard'
import { currentTenant } from '@/tenancy/context'
import { tenantTmpDir } from '@/storage/media-store'
import { handler, ok, badRequest, notFound } from '@/lib/api-handler'

export const dynamic = 'force-dynamic'
// Uploading a batch of full-resolution studio files takes longer than the
// default handler budget.
export const maxDuration = 300

/** One request's worth of request-level-abort state — a single file exceeding the PER-FILE cap only skips that file; exceeding the PER-REQUEST cap aborts everything, same distinction the old classifyFile()-based check made. */
class RequestTooLargeError extends Error {}

interface PendingFile {
  index: number
  tempPath: string
  fileName: string
  mimeType: string
  hash: crypto.Hash
  writeStream: fs.WriteStream
  byteSize: number
  tooLarge: boolean
  done: Promise<void>
}

export const POST = handler(
  async (request: NextRequest, context: { params: Promise<{ importId: string }> }) => {
    const { importId } = await context.params

    const record = imports.get(importId)
    if (!record) return notFound('import not found')
    if (record.status === 'completed' || record.status === 'cancelled') {
      return badRequest(`import is ${record.status} and no longer accepts files`)
    }

    // Cheapest, most server-wide check first — before even touching a slot
    // or streaming a byte. A full disk is a backstop against every tenant's
    // uploads failing at once, not something a tenant's own quota controls.
    await assertDiskSpaceAvailable()

    const tenantId = currentTenant().tenantId
    const tmpDir = tenantTmpDir()
    await fsp.mkdir(tmpDir, { recursive: true })

    if (!tryAcquireUploadSlot(tenantId)) {
      return badRequest(
        'This workspace already has the maximum number of uploads in progress — wait for one to finish.'
      )
    }

    const allTempPaths: string[] = []
    const cleanupAll = async () => {
      await Promise.all(allTempPaths.map(p => fsp.rm(p, { force: true }).catch(() => {})))
    }

    try {
      const contentType = request.headers.get('content-type')
      if (!contentType?.startsWith('multipart/form-data') || !request.body) {
        return badRequest('expected a multipart/form-data request body')
      }

      const bb = Busboy({
        headers: { 'content-type': contentType },
        limits: { fileSize: MAX_FILE_BYTES },
      })

      const pathFields: string[] = []
      const pending: PendingFile[] = []
      let fileIndex = 0
      let totalBytes = 0
      let requestTooLarge: RequestTooLargeError | null = null

      bb.on('field', (name, value) => {
        if (name === 'paths') pathFields.push(value)
      })

      bb.on('file', (name, fileStream, info) => {
        if (name !== 'files' || requestTooLarge) {
          fileStream.resume() // drain and discard — not a file part we want, or already aborting
          return
        }

        const index = fileIndex++
        const tempPath = path.join(tmpDir, `upload-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`)
        allTempPaths.push(tempPath)

        const hash = crypto.createHash('sha256')
        const writeStream = fs.createWriteStream(tempPath)
        const entry: PendingFile = {
          index,
          tempPath,
          fileName: info.filename || `file-${index}`,
          mimeType: info.mimeType || '',
          hash,
          writeStream,
          byteSize: 0,
          tooLarge: false,
          done: Promise.resolve(),
        }
        pending.push(entry)

        fileStream.on('data', (chunk: Buffer) => {
          entry.byteSize += chunk.length
          totalBytes += chunk.length
          hash.update(chunk)

          if (!requestTooLarge && totalBytes > MAX_REQUEST_BYTES) {
            requestTooLarge = new RequestTooLargeError(
              `batch exceeds ${Math.round(MAX_REQUEST_BYTES / 1024 / 1024)} MB; send fewer files per request`
            )
            // Stop reading more from the client immediately — the whole
            // point of checking DURING the stream rather than after it.
            bb.destroy()
          }
        })

        fileStream.on('limit', () => {
          // busboy's own per-file cap — this ONE file is rejected (mirrors
          // the old classifyFile() 'too_large' skip), not the whole request.
          entry.tooLarge = true
        })

        entry.done = new Promise<void>(resolveEntry => {
          fileStream.pipe(writeStream)
          const finish = () => resolveEntry()
          writeStream.on('finish', finish)
          writeStream.on('error', finish)
          fileStream.on('error', finish)
        })
      })

      await new Promise<void>((resolve, reject) => {
        bb.on('finish', resolve)
        bb.on('error', reject)
        bb.on('close', resolve) // fires on bb.destroy() too — e.g. the request-too-large abort above
        Readable.fromWeb(request.body as any).pipe(bb)
      })

      await Promise.all(pending.map(p => p.done))

      if (requestTooLarge) {
        await cleanupAll()
        return badRequest((requestTooLarge as RequestTooLargeError).message)
      }

      const incoming: IncomingFile[] = []
      let skippedTooLarge = 0

      for (const entry of pending) {
        if (entry.tooLarge) {
          skippedTooLarge++
          await fsp.rm(entry.tempPath, { force: true }).catch(() => {})
          continue
        }
        const relativePath = normalizePath(pathFields[entry.index] || entry.fileName)
        incoming.push({
          relativePath,
          fileName: baseName(relativePath) || entry.fileName,
          mimeType: entry.mimeType,
          tempPath: entry.tempPath,
          sourceHash: entry.hash.digest('hex'),
          byteSize: entry.byteSize,
        })
      }

      if (incoming.length === 0 && skippedTooLarge === 0) return badRequest('no files in request')

      // Checked against where this import's cumulative total would LAND, not
      // just this one request's file count — "per batch" means the whole
      // import session, and a client sending files in several smaller
      // requests must not be able to exceed it that way.
      assertImagesPerBatch(tenantId, record.importedFiles + incoming.length)
      // Original bytes only — duplicates within this batch (same hash) are
      // free, but that's determined deeper in `ingestFiles`; checking
      // against the full streamed size here is deliberately the
      // conservative (never under-counts) estimate.
      assertStorageBudget(tenantId, totalBytes)

      const results = await ingestFiles(importId, incoming)

      const summary = {
        imported: results.filter(r => r.outcome.status === 'imported').length,
        duplicates: results.filter(r => r.outcome.status === 'duplicate').length,
        skipped: results.filter(r => r.outcome.status === 'skipped').length + skippedTooLarge,
        failed: results.filter(r => r.outcome.status === 'failed').length,
      }

      return ok({ results, summary, import: imports.get(importId) })
    } catch (err) {
      await cleanupAll()
      throw err
    } finally {
      releaseUploadSlot(tenantId)
    }
  }
)
