/**
 * One product, with its images' full vision payload — one page of them.
 *
 * The product detail page and its Vision Debug panel are the only consumers,
 * and they need the complete analysis — landmarks, masks, crop boxes,
 * confidences — for images currently on screen, so each returned image still
 * carries the whole document rather than a summary. What changed: this used
 * to return EVERY image in the product this way at once, which meant a
 * 200-image product shipped 200 full vision payloads (and 200 thumbnails
 * mounted at once client-side) just to render a thumbnail strip where only
 * one image is ever the selected/detailed one at a time. `page`/`pageSize`
 * bound that to one page's worth; `imagesTotal` lets the client compute
 * total pages without a second request.
 */

import { NextRequest } from 'next/server'
import { products, images, creatives, templates } from '@/db/repositories'
import { getUsableAnalysis, getVisionAssetUrls } from '@/services/vision-service'
import { mediaUrl } from '@/storage/media-store'
import { handler, okWithEtag, notFound } from '@/lib/api-handler'
import type { VisionMetadata } from '@/vision/types'

export const dynamic = 'force-dynamic'

const DEFAULT_PAGE_SIZE = 40

export interface ProductImageDetail {
  id: string
  fileName: string
  relativePath: string
  width: number
  height: number
  byteSize: number
  mimeType: string
  hasAlpha: boolean
  colorSpace: string | null
  exifOrientation: number | null
  capturedAt: string | null
  cameraMake: string | null
  cameraModel: string | null
  position: number
  isPrimary: boolean
  visionStatus: string
  sourceHash: string
  originalUrl: string
  /**
   * A small cached JPEG (see `ensureThumbnail`), NOT `originalUrl` with a
   * query string — the Vision Debug panel reads `originalUrl` directly for
   * pixel-level landmark/mask overlay inspection, where the full-resolution
   * original genuinely matters, so that field is left untouched. This one
   * is for the 80x64 photo-strip thumbnail, which never needed more than a
   * few hundred pixels to begin with.
   */
  thumbnailUrl: string
  assets: ReturnType<typeof getVisionAssetUrls>
  vision: VisionMetadata | null
  visionStale: boolean
}

export const GET = handler(
  async (request: NextRequest, context: { params: Promise<{ productId: string }> }) => {
    const { productId } = await context.params

    const product = products.get(productId)
    if (!product) return notFound('product not found')

    const params = request.nextUrl.searchParams
    const page = Math.max(1, Number(params.get('page')) || 1)
    const pageSize = Math.min(200, Math.max(1, Number(params.get('pageSize')) || DEFAULT_PAGE_SIZE))

    const allImages = images.listByProduct(productId)
    const imagesTotal = allImages.length
    const start = (page - 1) * pageSize
    const pageImages = allImages.slice(start, start + pageSize)

    const details: ProductImageDetail[] = pageImages.map(image => {
      const { metadata, stale } = getUsableAnalysis(image.sourceHash, product.shotTypeOverride)
      return {
        id: image.id,
        fileName: image.fileName,
        relativePath: image.relativePath,
        width: image.width,
        height: image.height,
        byteSize: image.byteSize,
        mimeType: image.mimeType,
        hasAlpha: image.hasAlpha,
        colorSpace: image.colorSpace,
        exifOrientation: image.exifOrientation,
        capturedAt: image.capturedAt,
        cameraMake: image.cameraMake,
        cameraModel: image.cameraModel,
        position: image.position,
        isPrimary: image.isPrimary,
        visionStatus: image.visionStatus,
        sourceHash: image.sourceHash,
        originalUrl: mediaUrl('originals', image.storageKey),
        thumbnailUrl: `${mediaUrl('originals', image.storageKey)}?thumb=1`,
        assets: getVisionAssetUrls(image.sourceHash),
        vision: metadata,
        visionStale: stale,
      }
    })

    const templateNames = new Map(templates.list().map(t => [t.id, t.name]))

    const productCreatives = creatives.listByProduct(productId).map(creative => ({
      id: creative.id,
      imageId: creative.imageId,
      templateId: creative.templateId,
      templateName: templateNames.get(creative.templateId) ?? creative.templateId,
      url: mediaUrl('creatives', creative.storageKey),
      width: creative.width,
      height: creative.height,
      byteSize: creative.byteSize,
      framing: creative.framing,
      renderMs: creative.renderMs,
      createdAt: creative.createdAt,
    }))

    return okWithEtag(request, {
      product,
      images: details,
      imagesTotal,
      page,
      pageSize,
      creatives: productCreatives,
    })
  }
)
