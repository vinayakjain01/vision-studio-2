/**
 * One import: status, finalise, re-analyse, delete.
 */

import { NextRequest } from 'next/server'
import { imports, images } from '@/db/repositories'
import { finalizeImport, reanalyzeImport } from '@/import/import-service'
import { deleteImport } from '@/services/cleanup-service'
import { handler, ok, notFound, badRequest } from '@/lib/api'

export const dynamic = 'force-dynamic'

export const GET = handler(
  async (_request: NextRequest, context: { params: Promise<{ importId: string }> }) => {
    const { importId } = await context.params
    const record = imports.get(importId)
    if (!record) return notFound('import not found')

    const list = images.listByImport(importId, 100000)
    const vision = { pending: 0, processing: 0, ready: 0, failed: 0, unavailable: 0 }
    for (const image of list) vision[image.visionStatus]++

    return ok({ import: record, imageCount: list.length, vision })
  }
)

export const PATCH = handler(
  async (request: NextRequest, context: { params: Promise<{ importId: string }> }) => {
    const { importId } = await context.params
    if (!imports.get(importId)) return notFound('import not found')

    const body = await request.json().catch(() => ({}))
    const action = body?.action

    switch (action) {
      case 'finalize':
        return ok({ import: finalizeImport(importId) })

      case 'reanalyze': {
        const queued = reanalyzeImport(importId, body?.force === true)
        return ok({ queued, import: imports.get(importId) })
      }

      case 'cancel':
        imports.bump(importId, {}, 'cancelled')
        return ok({ import: imports.get(importId) })

      default:
        return badRequest(`unknown action: ${action}`)
    }
  }
)

export const DELETE = handler(
  async (_request: NextRequest, context: { params: Promise<{ importId: string }> }) => {
    const { importId } = await context.params

    // Removes the rows AND the files. Originals shared with another product are
    // detected and kept — see cleanup-service for why that check is required.
    const result = await deleteImport(importId)
    if (!result) return notFound('import not found')
    return ok(result)
  }
)
