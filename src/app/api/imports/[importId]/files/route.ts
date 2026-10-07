/**
 * Upload a batch of files into an open import.
 *
 * Multipart. Each file part carries its path within the picked directory in a
 * parallel `paths` field, because `File.webkitRelativePath` is not preserved
 * through `FormData` — only the base name survives, and the folder structure is
 * exactly what product grouping and the rules engine depend on.
 */

import { NextRequest } from 'next/server'
import { ingestFiles, type IncomingFile } from '@/import/import-service'
import { imports } from '@/db/repositories'
import { MAX_REQUEST_BYTES, baseName, normalizePath } from '@/import/file-rules'
import { assertImagesPerBatch, assertStorageBudget, tryAcquireUploadSlot, releaseUploadSlot } from '@/jobs/quota'
import { currentTenant } from '@/tenancy/context'
import { handler, ok, badRequest, notFound } from '@/lib/api-handler'

export const dynamic = 'force-dynamic'
// Uploading a batch of full-resolution studio files takes longer than the
// default handler budget.
export const maxDuration = 300

export const POST = handler(
  async (request: NextRequest, context: { params: Promise<{ importId: string }> }) => {
    const { importId } = await context.params

    const record = imports.get(importId)
    if (!record) return notFound('import not found')
    if (record.status === 'completed' || record.status === 'cancelled') {
      return badRequest(`import is ${record.status} and no longer accepts files`)
    }

    const form = await request.formData()
    const entries = form.getAll('files')
    const paths = form.getAll('paths').map(String)

    if (entries.length === 0) return badRequest('no files in request')
    if (paths.length !== entries.length) {
      return badRequest('paths and files must have the same length')
    }

    const tenantId = currentTenant().tenantId
    // Checked against where this import's cumulative total would LAND, not
    // just this one request's file count — "per batch" means the whole
    // import session, and a client sending files in several smaller requests
    // must not be able to exceed it that way.
    assertImagesPerBatch(tenantId, record.importedFiles + entries.length)

    // Concurrent-upload cap is enforced for the duration of this whole
    // request (reading every file's bytes, then ingesting them) — the thing
    // actually worth bounding is simultaneous in-flight upload WORK, not
    // just the instant the request arrives.
    if (!tryAcquireUploadSlot(tenantId)) {
      return badRequest(
        'This workspace already has the maximum number of uploads in progress — wait for one to finish.'
      )
    }

    try {
      const incoming: IncomingFile[] = []
      let totalBytes = 0

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]
        if (!(entry instanceof File)) continue

        const bytes = Buffer.from(await entry.arrayBuffer())
        totalBytes += bytes.byteLength

        if (totalBytes > MAX_REQUEST_BYTES) {
          return badRequest(
            `batch exceeds ${Math.round(MAX_REQUEST_BYTES / 1024 / 1024)} MB; send fewer files per request`
          )
        }

        // The `paths` field is authoritative for both the path AND the file name.
        // A multipart part's own filename is optional and not always set — a
        // client appending a Blob rather than a File sends the literal "blob",
        // which would make every image fail extension classification. Deriving
        // the name from the path we were explicitly given avoids depending on
        // that, and falls back to the part name when no path was sent.
        const relativePath = normalizePath(paths[i] || entry.name || `file-${i}`)
        const fileName = baseName(relativePath) || entry.name || `file-${i}`

        incoming.push({
          relativePath,
          fileName,
          mimeType: entry.type || '',
          bytes,
        })
      }

      // Original bytes only — duplicates within this batch (same hash) are
      // free, but that's determined deeper in `ingestFiles`; checking against
      // the full read size here is deliberately the conservative (never
      // under-counts) estimate.
      assertStorageBudget(tenantId, totalBytes)

      const results = await ingestFiles(importId, incoming)

      const summary = {
        imported: results.filter(r => r.outcome.status === 'imported').length,
        duplicates: results.filter(r => r.outcome.status === 'duplicate').length,
        skipped: results.filter(r => r.outcome.status === 'skipped').length,
        failed: results.filter(r => r.outcome.status === 'failed').length,
      }

      return ok({ results, summary, import: imports.get(importId) })
    } finally {
      releaseUploadSlot(tenantId)
    }
  }
)
