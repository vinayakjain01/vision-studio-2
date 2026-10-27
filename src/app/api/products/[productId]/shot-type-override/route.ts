/**
 * Set or clear a product's shot-type override.
 *
 * A folder of photos that are really one composite asset per sheet (e.g. a
 * colorway grid — the same garment in several colors, one sheet per color)
 * gets a different shot-type guess per sheet, since each sheet's own crop
 * reads differently to the detector even though a human would call them all
 * the same kind of shot. Setting this makes every photo in the product
 * report the chosen label instead of its own detected one, wherever shot
 * type is read (framing, AI-Extend eligibility, the Products badge, the
 * template preview) — see `getUsableAnalysis` in
 * `src/services/vision-service.ts`, the single place that applies it.
 *
 * `shotType: null` clears it, back to auto-detected — the default.
 */

import { NextRequest } from 'next/server'
import { products } from '@/db/repositories'
import { SHOT_TYPES } from '@/vision/types'
import { handler, ok, badRequest, notFound } from '@/lib/api-handler'

export const dynamic = 'force-dynamic'

export const POST = handler(
  async (request: NextRequest, context: { params: Promise<{ productId: string }> }) => {
    const { productId } = await context.params
    if (!products.get(productId)) return notFound('product not found')

    const body = await request.json().catch(() => null)
    const shotType = body?.shotType ?? null
    if (shotType !== null && !SHOT_TYPES.includes(shotType)) {
      return badRequest(`shotType must be one of ${SHOT_TYPES.join(', ')}, or null`)
    }

    products.setShotTypeOverride(productId, shotType)
    return ok({ productId, shotTypeOverride: shotType })
  }
)
