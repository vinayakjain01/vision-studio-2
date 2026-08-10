/**
 * Product listing with the per-product summary the grid renders.
 */

import { NextRequest } from 'next/server'
import { products, images } from '@/db/repositories'
import { getUsableAnalysis } from '@/services/vision-service'
import { mediaUrl } from '@/storage/media-store'
import { handler, ok } from '@/lib/api'

export const dynamic = 'force-dynamic'

export interface ProductSummary {
  id: string
  name: string
  folderPath: string
  category: string | null
  imageCount: number
  visionStatus: string
  shotType: string | null
  garmentType: string | null
  confidence: number | null
  thumbnailUrl: string | null
  createdAt: string
}

export const GET = handler(async (request: NextRequest) => {
  const params = request.nextUrl.searchParams

  const limit = Math.min(500, Number(params.get('limit')) || 60)
  const offset = Math.max(0, Number(params.get('offset')) || 0)

  const filter = {
    importId: params.get('importId') ?? undefined,
    category: params.get('category') ?? undefined,
    search: params.get('search') ?? undefined,
    limit,
    offset,
  }

  const list = products.list(filter)
  const total = products.count(filter)

  const summaries: ProductSummary[] = list.map(product => {
    const productImages = images.listByProduct(product.id)
    const primary =
      productImages.find(i => i.id === product.primaryImageId) ?? productImages[0] ?? null

    const analysis = primary ? getUsableAnalysis(primary.sourceHash).metadata : null

    return {
      id: product.id,
      name: product.name,
      folderPath: product.folderPath,
      category: product.category,
      imageCount: product.imageCount,
      visionStatus: primary?.visionStatus ?? 'pending',
      shotType: analysis?.shot.type ?? null,
      garmentType: analysis?.garment.type ?? null,
      confidence: analysis?.quality.overall ?? null,
      thumbnailUrl: primary ? mediaUrl('originals', primary.storageKey) : null,
      createdAt: product.createdAt,
    }
  })

  return ok({
    products: summaries,
    total,
    categories: products.categories(),
    hasMore: offset + list.length < total,
  })
})
