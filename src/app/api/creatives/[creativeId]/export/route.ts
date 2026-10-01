/**
 * Download one creative with an optional format/quality/resolution
 * conversion applied — the single-photo counterpart to the bulk ZIP route's
 * own conversion (`/api/creatives/download`).
 *
 * Reads the already-rendered, already-cached creative and converts a COPY of
 * its bytes via `convertForExport`; never re-renders, never touches vision
 * analysis or AI Extend. With no query params at all this returns the exact
 * stored bytes untouched, which is what every existing direct link to
 * `creative.url` already did — so adding this route changes nothing for
 * anyone who doesn't pass the new params.
 */

import { NextRequest, NextResponse } from 'next/server'
import { creatives, images } from '@/db/repositories'
import { readMedia } from '@/storage/media-store'
import { convertForExport, parseExportOptions, withExtension } from '@/render/export-image'
import { handler, notFound } from '@/lib/api'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const GET = handler(
  async (request: NextRequest, context: { params: Promise<{ creativeId: string }> }) => {
    const { creativeId } = await context.params
    const creative = creatives.get(creativeId)
    if (!creative) return notFound('creative not found')

    const options = parseExportOptions(request.nextUrl.searchParams)
    const stored = await readMedia('creatives', creative.storageKey)
    const result = await convertForExport(stored, creative.mimeType, creative.width, options)

    // Mirrors the source photo's own filename, same rule the bulk catalog
    // download uses — never the internal storage key, which is an opaque
    // id/template pairing nobody downloading one photo wants to see.
    const sourceName = images.get(creative.imageId)?.fileName ?? `${creativeId}.${result.extension}`
    const filename = withExtension(sourceName, result.extension)

    return new NextResponse(new Uint8Array(result.bytes), {
      headers: {
        'content-type': result.mimeType,
        'content-length': String(result.bytes.byteLength),
        'content-disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
        'cache-control': 'private, max-age=0, must-revalidate',
      },
    })
  }
)
