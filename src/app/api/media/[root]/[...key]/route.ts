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
import { ensureThumbnail } from '@/storage/thumbnail'
import { handler, badRequest, notFound } from '@/lib/api-handler'

// Was the one route in the app missing this. The HTTP Cache-Control headers
// below already say `private` (no shared/CDN caching), but that's a
// downstream-cache instruction, not a guarantee Next.js itself won't
// statically optimize or cache this route's OWN output at the framework
// level — `force-dynamic` is what rules that out, same as every other
// route here, and this is the one route actually serving tenant-scoped
// bytes rather than JSON.
export const dynamic = 'force-dynamic'

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

    // `?thumb=1` on an original: serve a small cached JPEG instead of the
    // full upload. See `ensureThumbnail`'s own doc comment — it returns
    // `null` (never throws) whenever thumbnailing isn't possible, and the
    // the full original is served in that case exactly as before this
    // param existed.
    let effectiveRoot: MediaRoot = root as MediaRoot
    let effectiveKey = storageKey
    if (request.nextUrl.searchParams.get('thumb') === '1') {
      const thumbKey = await ensureThumbnail(root as MediaRoot, storageKey)
      if (thumbKey) {
        effectiveRoot = 'derived'
        effectiveKey = thumbKey
      }
    }

    let stat: Awaited<ReturnType<typeof statMedia>>
    try {
      stat = await statMedia(effectiveRoot, effectiveKey)
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

    const extension = effectiveKey.split('.').pop()?.toLowerCase() ?? ''
    const bytes = await readMedia(effectiveRoot, effectiveKey)

    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
        'content-length': String(bytes.byteLength),
        etag,
        // Originals and derived assets (a thumbnail included) are
        // content-addressed; creatives are rewritten on re-render, so they
        // revalidate. A thumbnail's effective root is `derived` even when
        // the request's own root was `originals`, which already reads
        // `immutable` below — correct, since a thumbnail can never change
        // once generated, exactly like the original it was built from.
        'cache-control':
          effectiveRoot === 'creatives'
            ? 'private, max-age=0, must-revalidate'
            : 'private, max-age=31536000, immutable',
      },
    })
  }
)
