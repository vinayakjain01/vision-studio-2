/**
 * Creative gallery listing.
 */

import { NextRequest } from 'next/server'
import { creatives, products, templates } from '@/db/repositories'
import { mediaUrl } from '@/storage/media-store'
import { handler, ok } from '@/lib/api-handler'

export const dynamic = 'force-dynamic'

export const GET = handler(async (request: NextRequest) => {
  const params = request.nextUrl.searchParams
  const limit = Math.min(200, Number(params.get('limit')) || 60)
  const offset = Math.max(0, Number(params.get('offset')) || 0)
  const importId = params.get('importId')

  // Scoped to one master folder: every creative in it regardless of which
  // batch or template produced it, no offset pagination — the Downloads
  // page's "pick a folder" view wants the whole folder's contents to group
  // by sub-folder client-side, not a page of it. `importId` set means this
  // request IS that view; the plain `limit`/`offset` path below is
  // unaffected and keeps its existing behaviour for every other caller.
  const list = importId ? creatives.listByImport(importId) : creatives.list(limit, offset)
  const total = importId ? creatives.countByImport(importId) : creatives.count()

  const templateNames = new Map(templates.list().map(t => [t.id, t.name]))

  return ok({
    creatives: list.map(creative => {
      const product = products.get(creative.productId)
      return {
        id: creative.id,
        productId: creative.productId,
        productName: product?.name ?? '—',
        // The sub-folder a product was imported under — "", not null, for a
        // product imported at an import's own root — so the client can
        // group by it directly without a null check on every item.
        folderPath: product?.folderPath ?? '',
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
    total,
    hasMore: importId ? false : offset + list.length < total,
  })
})
