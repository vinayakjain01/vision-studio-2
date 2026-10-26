/**
 * On-demand thumbnails for the media route.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Every photo grid in the app (the Products list, a product's photo strip)
 * was pointing `<img>` tags directly at the ORIGINAL file — the same
 * full-resolution upload the vision engine analyses, which this catalog's
 * real photos put at several thousand pixels on a side and several
 * megabytes each — to render a card a few hundred CSS pixels wide, or an
 * 80x64 strip thumbnail. Every page load downloaded the full original for
 * every visible photo, which is what made the Products page feel stuck
 * while thumbnails trickled in.
 *
 * Originals are already content-addressed (`originalKey` — the hash IS the
 * path), so a thumbnail belongs in the same per-hash `derived/` directory a
 * photo's masks already live in — this reuses that addressing rather than
 * inventing a second scheme, and means a thumbnail is naturally invalidated
 * exactly the way masks are: never, because the original it was built from
 * can never change.
 *
 * Deliberately ONE fixed width, not a generic resize API: there is exactly
 * one real use (a browsing thumbnail), and a single size keeps the derived
 * store from fragmenting into one cache entry per distinct width a caller
 * might ask for. 640px covers a Products grid card (a few hundred CSS px,
 * comfortably readable even at 2x DPI) and the much smaller photo-strip
 * thumbnail with room to spare, while still being a small fraction of a
 * multi-thousand-pixel original.
 *
 * Server-only.
 */

import sharp from 'sharp'
import { readMedia, mediaExists, putDerived, derivedKey, type MediaRoot } from './media-store'

const THUMBNAIL_WIDTH = 640
const THUMBNAIL_QUALITY = 78
const THUMBNAIL_KIND = 'thumb'

/** `originalKey`'s own format: `<hash[:2]>/<hash[2:4]>/<hash>.<ext>` — the basename minus extension IS the hash. */
const HASH_PATTERN = /^[0-9a-f]{32,128}$/

function hashFromOriginalKey(key: string): string | null {
  const basename = key.split('/').pop() ?? ''
  const hash = basename.includes('.') ? basename.slice(0, basename.lastIndexOf('.')) : basename
  return HASH_PATTERN.test(hash) ? hash : null
}

/**
 * Ensures a thumbnail exists for this original and returns its OWN storage
 * key on the `derived` root — the caller reads/stats that key exactly like
 * any other derived asset, so it inherits the media route's existing
 * ETag/cache-control handling for free rather than this module duplicating
 * it.
 *
 * Returns `null` when thumbnailing isn't possible or isn't worth it —
 * `root` is anything other than `originals` (creatives/derived/assets are
 * either already small or not meant to be thumbnailed), the key doesn't
 * match the expected content-hash format (defensive; should never happen
 * for a real original), or sharp fails to decode the file (corrupt upload,
 * an exotic format it doesn't support). The caller falls back to serving
 * the original directly in every case — a slow thumbnail is this module's
 * problem; a broken image is not something callers should have to handle.
 */
export async function ensureThumbnail(root: MediaRoot, key: string): Promise<string | null> {
  if (root !== 'originals') return null

  const hash = hashFromOriginalKey(key)
  if (!hash) return null

  const thumbKey = derivedKey(hash, THUMBNAIL_KIND, 'jpg')
  if (await mediaExists('derived', thumbKey)) return thumbKey

  try {
    const original = await readMedia(root, key)
    const resized = await sharp(original)
      .rotate() // respect EXIF orientation — the source may not have been normalised yet.
      .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: THUMBNAIL_QUALITY })
      .toBuffer()
    await putDerived(hash, THUMBNAIL_KIND, 'jpg', resized)
    return thumbKey
  } catch {
    return null
  }
}
