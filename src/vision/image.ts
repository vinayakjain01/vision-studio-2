/**
 * Image codec adapter for the Vision Engine.
 *
 * The only dependency `src/vision/` takes on the outside world beyond ONNX
 * Runtime, and deliberately a narrow one: decode bytes to raw pixels, encode a
 * mask to PNG, read metadata. Everything image-format-specific lives here so
 * the rest of the engine works in plain typed arrays.
 *
 * EXIF orientation is applied at decode. Every coordinate the engine emits is
 * therefore in DISPLAY space — the same space a browser `<img>` renders and the
 * compositor draws. Skipping that step is a classic source of framing bugs:
 * detections land correctly on the raw buffer and 90° wrong on screen.
 */

import sharp from 'sharp'
import type { DecodedImage, ProbabilityMask, Size } from './types'

export interface ImageMetadata {
  width: number
  height: number
  format: string
  mimeType: string
  hasAlpha: boolean
  colorSpace: string | null
  exifOrientation: number | null
  byteSize: number
  capturedAt: string | null
  cameraMake: string | null
  cameraModel: string | null
}

const MIME_BY_FORMAT: Record<string, string> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  tiff: 'image/tiff',
  heif: 'image/heif',
  gif: 'image/gif',
}

/**
 * Read dimensions and camera metadata without decoding pixels.
 *
 * `width`/`height` are post-rotation display dimensions: sharp reports the
 * stored dimensions, so for orientation values 5–8 (the 90°/270° cases) they
 * are swapped here to match what the decoded buffer will actually be.
 */
export async function readImageMetadata(bytes: Buffer): Promise<ImageMetadata> {
  const image = sharp(bytes, { failOn: 'none' })
  const meta = await image.metadata()

  const orientation = meta.orientation ?? null
  const rotated = orientation != null && orientation >= 5 && orientation <= 8

  const storedWidth = meta.width ?? 0
  const storedHeight = meta.height ?? 0

  const exif = parseExif(meta.exif)

  return {
    width: rotated ? storedHeight : storedWidth,
    height: rotated ? storedWidth : storedHeight,
    format: meta.format ?? 'unknown',
    mimeType: MIME_BY_FORMAT[meta.format ?? ''] ?? 'application/octet-stream',
    hasAlpha: meta.hasAlpha ?? false,
    colorSpace: meta.space ?? null,
    exifOrientation: orientation,
    byteSize: bytes.byteLength,
    capturedAt: exif.capturedAt,
    cameraMake: exif.make,
    cameraModel: exif.model,
  }
}

/**
 * Minimal EXIF reader for the three fields the product page displays.
 *
 * Hand-rolled rather than pulling in an EXIF library: this walks IFD0 for
 * Make (0x010f), Model (0x0110) and DateTime (0x0132), which is a few dozen
 * lines and avoids a dependency whose entire remaining surface would be unused.
 * Anything malformed yields nulls — metadata is informational, never
 * load-bearing.
 */
function parseExif(buffer: Buffer | undefined): {
  capturedAt: string | null
  make: string | null
  model: string | null
} {
  const empty = { capturedAt: null, make: null, model: null }
  if (!buffer || buffer.length < 12) return empty

  try {
    // sharp hands back the EXIF payload starting with the "Exif\0\0" header.
    let offset = 0
    if (buffer.subarray(0, 4).toString('ascii') === 'Exif') offset = 6
    if (buffer.length < offset + 8) return empty

    const byteOrder = buffer.subarray(offset, offset + 2).toString('ascii')
    const little = byteOrder === 'II'
    if (!little && byteOrder !== 'MM') return empty

    const u16 = (p: number) => (little ? buffer.readUInt16LE(p) : buffer.readUInt16BE(p))
    const u32 = (p: number) => (little ? buffer.readUInt32LE(p) : buffer.readUInt32BE(p))

    const ifd0Offset = u32(offset + 4)
    const ifd0 = offset + ifd0Offset
    if (ifd0 + 2 > buffer.length) return empty

    const entryCount = u16(ifd0)
    const result: Record<number, string> = {}

    for (let i = 0; i < entryCount; i++) {
      const entry = ifd0 + 2 + i * 12
      if (entry + 12 > buffer.length) break

      const tag = u16(entry)
      if (tag !== 0x010f && tag !== 0x0110 && tag !== 0x0132) continue

      const type = u16(entry + 2)
      if (type !== 2) continue // ASCII string

      const count = u32(entry + 4)
      if (count === 0 || count > 512) continue

      // Values of 4 bytes or fewer are inlined in the entry itself.
      const valueStart = count <= 4 ? entry + 8 : offset + u32(entry + 8)
      if (valueStart + count > buffer.length) continue

      result[tag] = buffer
        .subarray(valueStart, valueStart + count)
        .toString('ascii')
        .replace(/\0+$/, '')
        .trim()
    }

    return {
      make: result[0x010f] || null,
      model: result[0x0110] || null,
      capturedAt: normaliseExifDate(result[0x0132]),
    }
  } catch {
    return empty
  }
}

/** EXIF stores "YYYY:MM:DD HH:MM:SS"; convert to ISO-8601 or give up. */
function normaliseExifDate(value: string | undefined): string | null {
  if (!value) return null
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const [, y, mo, d, h, mi, s] = match
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/**
 * Decode to RGB pixels at analysis resolution.
 *
 * `sourceWidth`/`sourceHeight` on the result are the FULL display dimensions,
 * and `scaleX`/`scaleY` map the returned buffer back to them. Providers use
 * those to project every detection into source space, so the caller sees
 * full-resolution coordinates regardless of what resolution inference ran at.
 */
export async function decodeForAnalysis(
  bytes: Buffer,
  maxDimension: number
): Promise<DecodedImage> {
  const pipeline = sharp(bytes, { failOn: 'none' })
    // Applies EXIF orientation and strips the tag, so the buffer is display-
    // oriented from here on.
    .rotate()

  // `metadata()` reports the STORED dimensions and orientation tag regardless
  // of the `.rotate()` queued above — it does not reflect pending pipeline
  // operations, only the source file. For a photo shot in portrait and saved
  // with orientation 5–8, that means width/height come back swapped here even
  // though the decoded buffer itself will be correctly rotated. Left
  // unswapped, `sourceWidth`/`sourceHeight` below drive both the resize target
  // (distorting the image into the wrong aspect ratio) and the coordinate
  // space every detection is projected into — every anchor for a 90°-rotated
  // photo would land nowhere near the body. Swapping here, exactly as
  // `readImageMetadata` above already does, is what keeps this decode in the
  // same display space the compositor and the browser agree on.
  const meta = await pipeline.metadata()
  const orientation = meta.orientation ?? null
  const rotated = orientation != null && orientation >= 5 && orientation <= 8
  const sourceWidth = (rotated ? meta.height : meta.width) ?? 0
  const sourceHeight = (rotated ? meta.width : meta.height) ?? 0
  if (sourceWidth === 0 || sourceHeight === 0) {
    throw new Error('image has zero dimensions or could not be decoded')
  }

  const longest = Math.max(sourceWidth, sourceHeight)
  const scale = Math.min(1, maxDimension / longest)
  const analysisWidth = Math.max(1, Math.round(sourceWidth * scale))
  const analysisHeight = Math.max(1, Math.round(sourceHeight * scale))

  const { data, info } = await pipeline
    .resize(analysisWidth, analysisHeight, { fit: 'fill', kernel: 'lanczos3' })
    // Flatten onto white: a transparent PNG's undefined RGB under the alpha is
    // whatever the encoder left there, and feeding that to a detector produces
    // edge artefacts along the cutout.
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  return {
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
    channels: 3,
    sourceWidth,
    sourceHeight,
    scaleX: sourceWidth / info.width,
    scaleY: sourceHeight / info.height,
  }
}

/** Encode a single-channel probability map as a greyscale PNG. */
export async function encodeMaskPng(mask: ProbabilityMask): Promise<Buffer> {
  return sharp(Buffer.from(mask.data), {
    raw: { width: mask.width, height: mask.height, channels: 1 },
  })
    .png({ compressionLevel: 9, effort: 7 })
    .toBuffer()
}

/**
 * Cut the subject out of the source image using a matte, producing a
 * transparent PNG at full source resolution.
 *
 * The matte is upsampled to source size first — using it at its own (smaller)
 * resolution would quantise the cutout edge to mask pixels, which is visible as
 * stair-stepping on a hem against a dark background.
 */
export async function applyMaskAsAlpha(
  sourceBytes: Buffer,
  mask: ProbabilityMask,
  target: Size
): Promise<Buffer> {
  const alpha = await sharp(Buffer.from(mask.data), {
    raw: { width: mask.width, height: mask.height, channels: 1 },
  })
    .resize(target.width, target.height, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer()

  const rgb = await sharp(sourceBytes, { failOn: 'none' })
    .rotate()
    .resize(target.width, target.height, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer()

  const pixels = target.width * target.height
  const rgba = Buffer.allocUnsafe(pixels * 4)
  for (let i = 0; i < pixels; i++) {
    rgba[i * 4] = rgb[i * 3]
    rgba[i * 4 + 1] = rgb[i * 3 + 1]
    rgba[i * 4 + 2] = rgb[i * 3 + 2]
    rgba[i * 4 + 3] = alpha[i]
  }

  return sharp(rgba, { raw: { width: target.width, height: target.height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

/** Downscaled JPEG for list views and the debug panel's base layer. */
export async function encodePreview(bytes: Buffer, maxDimension: number): Promise<Buffer> {
  return sharp(bytes, { failOn: 'none' })
    .rotate()
    .resize(maxDimension, maxDimension, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer()
}
