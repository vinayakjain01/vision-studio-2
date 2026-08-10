/**
 * Delete one product: its images, its creatives, and any media no longer
 * referenced by another product.
 *
 * A sub-route rather than a `DELETE` on `/api/products/[productId]` only because
 * that path's handler is the read endpoint the product page polls; keeping the
 * destructive operation on its own path makes it impossible to trigger by
 * accident from a mistyped method.
 */

import { NextRequest } from 'next/server'
import { deleteProduct } from '@/services/cleanup-service'
import { handler, ok, notFound } from '@/lib/api'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export const POST = handler(
  async (_request: NextRequest, context: { params: Promise<{ productId: string }> }) => {
    const { productId } = await context.params
    const result = await deleteProduct(productId)
    if (!result) return notFound('product not found')
    return ok(result)
  }
)
