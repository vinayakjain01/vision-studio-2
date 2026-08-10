/**
 * On-demand render.
 *
 * Two modes:
 *  - `persist: true`  — render an image against a saved template and store the
 *                       creative. Used by the "render this one" action.
 *  - default          — render against a template document supplied inline and
 *                       stream the PNG back without storing it. This is how the
 *                       builder shows a true pixel-accurate proof of an UNSAVED
 *                       template.
 *
 * The second mode matters: the browser preview is a faithful CSS reconstruction
 * of the same framing, but only the server compositor draws the real text
 * metrics, blur and supersampling. Being able to check that before saving is
 * the difference between trusting the preview and re-rendering a batch.
 */

import { NextRequest, NextResponse } from 'next/server'
import { images } from '@/db/repositories'
import { renderCreative } from '@/render/compositor'
import { renderOnce } from '@/services/generation-service'
import { getUsableAnalysis } from '@/services/vision-service'
import { readMedia, mediaUrl } from '@/storage/media-store'
import { products } from '@/db/repositories'
import { handler, ok, badRequest, notFound } from '@/lib/api'
import type { TemplateDocument } from '@/templates/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export const POST = handler(async (request: NextRequest) => {
  const body = await request.json().catch(() => null)
  if (!body) return badRequest('invalid JSON body')

  const imageId = typeof body.imageId === 'string' ? body.imageId : ''
  if (!imageId) return badRequest('imageId is required')

  const image = images.get(imageId)
  if (!image) return notFound('image not found')

  // ── Persist against a saved template ──────────────────────────────────────
  if (body.persist === true) {
    if (typeof body.templateId !== 'string') {
      return badRequest('templateId is required when persist is true')
    }
    const result = await renderOnce(imageId, body.templateId)
    const creativeUrl = mediaUrl('creatives', result.storageKey)
    return ok({ creativeId: result.creativeId, url: creativeUrl })
  }

  // ── Ephemeral proof render from an inline document ────────────────────────
  const document = body.document as TemplateDocument | undefined
  if (!document || typeof document !== 'object') {
    return badRequest('document is required when persist is not set')
  }

  const { metadata } = getUsableAnalysis(image.sourceHash)
  const product = products.get(image.productId)
  const source = await readMedia('originals', image.storageKey)

  const result = await renderCreative({
    source,
    vision: metadata,
    template: document,
    variables: {
      product_name: product?.name ?? image.fileName,
      category: product?.category ?? '',
      folder: product?.folderPath ?? '',
      file_name: image.fileName,
      shot_type: metadata?.shot.type ?? 'unknown',
      garment_type: metadata?.garment.type ?? 'unknown',
      index: String(image.position + 1),
    },
    // Cap the proof render: the operator is waiting, and a 2048px supersampled
    // render of a 6000px source takes seconds it does not need to.
    maxDimension: Number(body.maxDimension) || 1200,
    format: 'png',
  })

  return new NextResponse(new Uint8Array(result.buffer), {
    headers: {
      'content-type': 'image/png',
      'cache-control': 'no-store',
      // Framing diagnostics ride along in headers so the builder can show which
      // strategy fired without a second request.
      'x-framing-strategy': result.framing.strategyId,
      'x-framing-fallback': String(result.framing.usedFallback),
      'x-framing-violations': String(result.framing.violations.length),
      'x-render-ms': String(result.durationMs),
    },
  })
})
