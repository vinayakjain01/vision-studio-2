/**
 * One batch: live progress, cancel, retry.
 *
 * `GET` is polled while a batch runs, so it stays cheap: counters come from one
 * grouped query, and the ETA is derived from measured throughput rather than a
 * fixed per-image guess.
 */

import { NextRequest } from 'next/server'
import { getBatchProgress, cancelBatch, retryBatchFailures } from '@/services/generation-service'
import { creatives } from '@/db/repositories'
import { mediaUrl } from '@/storage/media-store'
import { handler, ok, badRequest, notFound } from '@/lib/api'

export const dynamic = 'force-dynamic'

export const GET = handler(
  async (request: NextRequest, context: { params: Promise<{ batchId: string }> }) => {
    const { batchId } = await context.params

    const progress = getBatchProgress(batchId)
    if (!progress) return notFound('batch not found')

    const includeCreatives = request.nextUrl.searchParams.get('creatives') === 'true'

    return ok({
      ...progress,
      creatives: includeCreatives
        ? creatives.listByBatch(batchId, 200).map(creative => ({
            id: creative.id,
            imageId: creative.imageId,
            productId: creative.productId,
            templateId: creative.templateId,
            url: mediaUrl('creatives', creative.storageKey),
            width: creative.width,
            height: creative.height,
            strategyId: creative.framing?.strategyId ?? null,
            usedFallback: creative.framing?.usedFallback ?? false,
            violations: creative.framing?.violations.length ?? 0,
            renderMs: creative.renderMs,
          }))
        : undefined,
    })
  }
)

export const PATCH = handler(
  async (request: NextRequest, context: { params: Promise<{ batchId: string }> }) => {
    const { batchId } = await context.params
    const body = await request.json().catch(() => ({}))

    switch (body?.action) {
      case 'cancel':
        return ok(cancelBatch(batchId))
      case 'retry':
        return ok(retryBatchFailures(batchId))
      default:
        return badRequest(`unknown action: ${body?.action}`)
    }
  }
)
