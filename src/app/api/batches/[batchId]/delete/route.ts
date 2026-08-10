/**
 * Delete a generation batch and the images it produced.
 *
 * The source photographs are untouched — a batch is output. Deleting one is how
 * you discard a run you are not happy with and try different settings, which
 * would be pointless if it also removed the imported photos.
 */

import { NextRequest } from 'next/server'
import { deleteBatch } from '@/services/cleanup-service'
import { handler, ok, notFound } from '@/lib/api'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export const POST = handler(
  async (_request: NextRequest, context: { params: Promise<{ batchId: string }> }) => {
    const { batchId } = await context.params
    const result = await deleteBatch(batchId)
    if (!result) return notFound('batch not found')
    return ok(result)
  }
)
