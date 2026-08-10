/**
 * Delete one generated image, or all of them.
 *
 * `DELETE /api/creatives/all` clears every creative while keeping the imported
 * photographs — the "start the output over" case. It is routed through the same
 * dynamic segment because `all` cannot collide with a real id (ids are prefixed
 * `crt_`).
 */

import { NextRequest } from 'next/server'
import { deleteCreative, deleteAllCreatives } from '@/services/cleanup-service'
import { handler, ok, notFound } from '@/lib/api'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export const DELETE = handler(
  async (_request: NextRequest, context: { params: Promise<{ creativeId: string }> }) => {
    const { creativeId } = await context.params

    if (creativeId === 'all') {
      return ok(await deleteAllCreatives())
    }

    const result = await deleteCreative(creativeId)
    if (!result) return notFound('image not found')
    return ok(result)
  }
)
