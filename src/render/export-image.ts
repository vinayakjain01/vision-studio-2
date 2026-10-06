/**
 * Export-time image conversion.
 *
 * Format, file-size budget and resolution changes applied to an
 * ALREADY-RENDERED creative — never to the render pipeline. The canonical
 * stored creative (produced by `renderCreative` in `compositor.ts`, always a
 * JPEG today) is never touched; this converts a COPY of its bytes at
 * download time, so the expensive pipeline (vision analysis → template
 * placement → optional AI Extend) and the derived-asset cache it writes to
 * are completely unaffected by what an operator chooses to export as.
 *
 * There is no direct 1–100 quality dial exposed to callers on purpose: an
 * operator asking "fit under 300KB" does not want to separately guess a
 * quality number that happens to get them there, so `targetSizeKb` below
 * takes a size budget and searches for the quality that satisfies it
 * (`encodeWithinSizeBudget`) rather than taking quality as an input.
 *
 * A no-op when none of the settings would change anything — the default
 * download path returns the stored bytes completely untouched, rather than
 * paying for (and risking a quality loss from) a needless decode/re-encode
 * round trip. That no-op IS the default: every control here is optional, and
 * leaving all of them unset reproduces exactly what downloads looked like
 * before this module existed.
 */

import sharp from 'sharp'
import { config } from '@/config'

export type ExportFormat = 'jpeg' | 'png' | 'webp'

export interface ExportOptions {
  /** Omitted = keep whatever format the creative is already stored as. */
  format?: ExportFormat
  /**
   * A target file-size budget in KB. Optional — omitted means "use the
   * render-time default quality", exactly what every export produced before
   * this existed. Ignored for png, which is lossless and has no quality knob
   * to search over. `min` is advisory: compression can always be pushed
   * smaller, but there's no honest way to pad a file back UP to a floor
   * without either wasting bytes or inflating dimensions, so a very simple
   * image that compresses well under `min` is left at its best quality
   * rather than artificially bloated to fill the range.
   */
  targetSizeKb?: { min: number; max: number }
  /** Percent of the creative's native size, e.g. 50/75/100. Omitted or 100 = native. */
  scalePercent?: number
}

export interface ExportResult {
  bytes: Buffer
  mimeType: string
  extension: string
}

const MIME_BY_FORMAT: Record<ExportFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

function formatFromMimeType(mimeType: string): ExportFormat {
  if (mimeType === 'image/png') return 'png'
  if (mimeType === 'image/webp') return 'webp'
  return 'jpeg'
}

/** Swap a filename's extension, keeping everything before the last dot. */
export function withExtension(fileName: string, extension: string): string {
  const base = fileName.replace(/\.[^./]+$/, '')
  return `${base || 'untitled'}.${extension}`
}

/**
 * Encode at the highest quality (1–100) whose output still fits under
 * `maxBytes` — binary search, so a ~4000×6000 JPEG converges in about 7
 * encode attempts rather than scanning all 100 quality levels one at a time.
 *
 * "Highest quality that fits" rather than "closest to the middle of the
 * range": given a size budget, more quality is strictly better, so there's
 * no reason to leave headroom under `maxBytes` once something fits under it.
 * `minBytes` only matters for the caller's expectations (see the doc comment
 * on `targetSizeKb`) — it is never used to reject or pad a result here.
 */
async function encodeWithinSizeBudget(
  pipeline: ReturnType<typeof sharp>,
  format: 'jpeg' | 'webp',
  maxBytes: number
): Promise<Buffer> {
  const encodeAt = (quality: number) =>
    format === 'webp'
      ? pipeline.clone().webp({ quality }).toBuffer()
      : pipeline.clone().jpeg({ quality }).toBuffer()

  let low = 1
  let high = 100
  // The floor: whatever quality=1 produces is the smallest this image can get
  // without also shrinking its dimensions. If even that overshoots the
  // budget, it's returned anyway — undersized output the caller didn't ask
  // for would be a worse surprise than oversized output they can see.
  let best = await encodeAt(1)

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const attempt = await encodeAt(mid)
    if (attempt.length <= maxBytes) {
      best = attempt
      low = mid + 1 // fits — try for higher quality
    } else {
      high = mid - 1 // too big — back off
    }
  }

  return best
}

export async function convertForExport(
  bytes: Buffer,
  sourceMimeType: string,
  nativeWidth: number,
  options: ExportOptions
): Promise<ExportResult> {
  const scale = options.scalePercent
  const needsResize = scale != null && scale > 0 && scale !== 100
  const targetFormat = options.format ?? formatFromMimeType(sourceMimeType)
  const needsFormatChange = targetFormat !== formatFromMimeType(sourceMimeType)
  const targetSizeKb = targetFormat !== 'png' ? options.targetSizeKb : undefined
  const needsSizeBudget = targetSizeKb != null

  if (!needsResize && !needsFormatChange && !needsSizeBudget) {
    return {
      bytes,
      mimeType: sourceMimeType,
      extension: EXTENSION_BY_MIME[sourceMimeType] ?? 'jpg',
    }
  }

  let pipeline = sharp(bytes)

  if (needsResize) {
    pipeline = pipeline.resize({ width: Math.max(1, Math.round(nativeWidth * (scale! / 100))) })
  }

  let out: Buffer
  if (targetFormat === 'png') {
    // Lossless — there's no quality or size-budget knob to apply here.
    out = await pipeline.png().toBuffer()
  } else if (needsSizeBudget) {
    out = await encodeWithinSizeBudget(pipeline, targetFormat, targetSizeKb!.max * 1024)
  } else if (targetFormat === 'webp') {
    out = await pipeline.webp({ quality: config.render.jpegQuality }).toBuffer()
  } else {
    out = await pipeline.jpeg({ quality: config.render.jpegQuality }).toBuffer()
  }

  const mimeType = MIME_BY_FORMAT[targetFormat]
  return { bytes: out, mimeType, extension: EXTENSION_BY_MIME[mimeType] }
}

/** Parse and clamp the export query params a request may supply. */
export function parseExportOptions(params: URLSearchParams): ExportOptions {
  const formatParam = params.get('format')
  const format: ExportFormat | undefined =
    formatParam === 'jpeg' || formatParam === 'png' || formatParam === 'webp'
      ? formatParam
      : undefined

  const scaleRaw = Number(params.get('scale'))
  const scalePercent =
    Number.isFinite(scaleRaw) && scaleRaw > 0 && scaleRaw <= 100 ? Math.round(scaleRaw) : undefined

  const minRaw = Number(params.get('sizeMinKb'))
  const maxRaw = Number(params.get('sizeMaxKb'))
  const targetSizeKb =
    Number.isFinite(minRaw) && Number.isFinite(maxRaw) && minRaw > 0 && maxRaw >= minRaw
      ? { min: minRaw, max: maxRaw }
      : undefined

  return { format, scalePercent, targetSizeKb }
}
