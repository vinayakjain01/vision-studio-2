/**
 * Media delivery.
 *
 * Serves originals, derived assets (masks, cutouts, previews) and creatives
 * from the local media store.
 *
 * Path traversal is prevented in `media-store.resolvePath`, which validates the
 * key and confirms the resolved path stays inside its root — enforced there
 * rather than here so every caller inherits it, not just this route.
 */

import { NextRequest, NextResponse } from 'next/server'
import { statMedia, readMedia, type MediaRoot } from '@/storage/media-store'
import { handler, badRequest, notFound } from '@/lib/api'

const ROOTS: MediaRoot[] = ['originals', 'derived', 'creatives', 'assets']

const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
}

export const GET = handler(
  async (
    request: NextRequest,
    context: { params: Promise<{ root: string; key: string[] }> }
  ) => {
    const { root, key } = await context.params

    if (!ROOTS.includes(root as MediaRoot)) {
      return badRequest(`unknown media root: ${root}`)
    }

    const storageKey = key.map(decodeURIComponent).join('/')

    let stat: Awaited<ReturnType<typeof statMedia>>
    try {
      stat = await statMedia(root as MediaRoot, storageKey)
    } catch {
      // resolvePath rejected the key as unsafe.
      return badRequest('invalid media key')
    }
    if (!stat) return notFound('media not found')

    // Content is immutable per key, so the mtime+size ETag only ever changes
    // when a derived asset is regenerated.
    const etag = `"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`
    if (request.headers.get('if-none-match') === etag) {
      return new NextResponse(null, { status: 304, headers: { etag } })
    }

    const extension = storageKey.split('.').pop()?.toLowerCase() ?? ''
    const bytes = await readMedia(root as MediaRoot, storageKey)

    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
        'content-length': String(bytes.byteLength),
        etag,
        // Originals and derived assets are content-addressed; creatives are
        // rewritten on re-render, so they revalidate.
        'cache-control':
          root === 'creatives'
            ? 'private, max-age=0, must-revalidate'
            : 'private, max-age=31536000, immutable',
      },
    })
  }
)
