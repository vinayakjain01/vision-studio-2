/**
 * One product, with every image's full vision payload.
 *
 * The product detail page and its Vision Debug panel are the only consumers,
 * and they need the complete analysis — landmarks, masks, crop boxes,
 * confidences — so this returns the whole document rather than a summary.
 */

import { NextRequest } from 'next/server'
import { products, images, creatives, templates } from '@/db/repositories'
import { getUsableAnalysis, getVisionAssetUrls } from '@/services/vision-service'
import { mediaUrl } from '@/storage/media-store'
import { handler, ok, notFound } from '@/lib/api'
import type { VisionMetadata } from '@/vision/types'

export const dynamic = 'force-dynamic'

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
  assets: ReturnType<typeof getVisionAssetUrls>
  vision: VisionMetadata | null
  visionStale: boolean
}

export const GET = handler(
  async (_request: NextRequest, context: { params: Promise<{ productId: string }> }) => {
    const { productId } = await context.params

    const product = products.get(productId)
    if (!product) return notFound('product not found')

    const details: ProductImageDetail[] = images.listByProduct(productId).map(image => {
      const { metadata, stale } = getUsableAnalysis(image.sourceHash)
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

    return ok({ product, images: details, creatives: productCreatives })
  }
)
