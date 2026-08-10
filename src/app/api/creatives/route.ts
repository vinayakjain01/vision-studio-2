/**
 * Creative gallery listing.
 */

import { NextRequest } from 'next/server'
import { creatives, products, templates } from '@/db/repositories'
import { mediaUrl } from '@/storage/media-store'
import { handler, ok } from '@/lib/api'

export const dynamic = 'force-dynamic'

export const GET = handler(async (request: NextRequest) => {
  const params = request.nextUrl.searchParams
  const limit = Math.min(200, Number(params.get('limit')) || 60)
  const offset = Math.max(0, Number(params.get('offset')) || 0)

  const list = creatives.list(limit, offset)
  const templateNames = new Map(templates.list().map(t => [t.id, t.name]))

  return ok({
    creatives: list.map(creative => {
      const product = products.get(creative.productId)
      return {
        id: creative.id,
        productId: creative.productId,
        productName: product?.name ?? '—',
        imageId: creative.imageId,
        templateId: creative.templateId,
        templateName: templateNames.get(creative.templateId) ?? creative.templateId,
        url: mediaUrl('creatives', creative.storageKey),
        width: creative.width,
        height: creative.height,
        byteSize: creative.byteSize,
        // Surfaced in the gallery so an operator can spot, at a glance, which
        // creatives fell back or hit a constraint — the ones worth reviewing.
        strategyId: creative.framing?.strategyId ?? null,
        strategyLabel: creative.framing?.strategyLabel ?? null,
        usedFallback: creative.framing?.usedFallback ?? false,
        violations: creative.framing?.violations.length ?? 0,
        renderMs: creative.renderMs,
        createdAt: creative.createdAt,
      }
    }),
    total: creatives.count(),
    hasMore: offset + list.length < creatives.count(),
  })
})
