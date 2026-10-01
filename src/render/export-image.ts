/**
 * Export-time image conversion.
 *
 * Format, quality and resolution changes applied to an ALREADY-RENDERED
 * creative — never to the render pipeline. The canonical stored creative
 * (produced by `renderCreative` in `compositor.ts`, always a JPEG today) is
 * never touched; this converts a COPY of its bytes at download time, so the
 * expensive pipeline (vision analysis → template placement → optional AI
 * Extend) and the derived-asset cache it writes to are completely unaffected
 * by what format or size an operator chooses to export as.
 *
 * A no-op when none of the three settings would change anything — the
 * default download path returns the stored bytes completely untouched,
 * rather than paying for (and risking a quality loss from) a needless
 * decode/re-encode round trip.
 */

import sharp from 'sharp'
import { config } from '@/config'

export type ExportFormat = 'jpeg' | 'png' | 'webp'

export interface ExportOptions {
  /** Omitted = keep whatever format the creative is already stored as. */
  format?: ExportFormat
  /** 1–100. Ignored for png, which is lossless. Omitted = the render-time default. */
  quality?: number
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
  const needsQuality =
    options.quality != null && (targetFormat === 'jpeg' || targetFormat === 'webp')

  if (!needsResize && !needsFormatChange && !needsQuality) {
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

  if (targetFormat === 'png') {
    // Lossless — `quality` is never passed. A PNG that was asked for a
    // quality value had that value meant for a lossy format and ignores it
    // here on purpose, rather than misapplying it as a compression-effort
    // setting that means something different.
    pipeline = pipeline.png()
  } else if (targetFormat === 'webp') {
    pipeline = pipeline.webp({ quality: options.quality ?? config.render.jpegQuality })
  } else {
    pipeline = pipeline.jpeg({ quality: options.quality ?? config.render.jpegQuality })
  }

  const out = await pipeline.toBuffer()
  const mimeType = MIME_BY_FORMAT[targetFormat]
  return { bytes: out, mimeType, extension: EXTENSION_BY_MIME[mimeType] }
}

/** Parse and clamp the three export query params a request may supply. */
export function parseExportOptions(params: URLSearchParams): ExportOptions {
  const formatParam = params.get('format')
  const format: ExportFormat | undefined =
    formatParam === 'jpeg' || formatParam === 'png' || formatParam === 'webp'
      ? formatParam
      : undefined

  const qualityRaw = Number(params.get('quality'))
  const quality =
    Number.isFinite(qualityRaw) && qualityRaw >= 1 && qualityRaw <= 100
      ? Math.round(qualityRaw)
      : undefined

  const scaleRaw = Number(params.get('scale'))
  const scalePercent =
    Number.isFinite(scaleRaw) && scaleRaw > 0 && scaleRaw <= 100 ? Math.round(scaleRaw) : undefined

  return { format, quality, scalePercent }
}
