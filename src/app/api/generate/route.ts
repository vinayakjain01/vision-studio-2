/**
 * Generation: plan a batch, or start one.
 *
 * `POST` with `dryRun: true` returns the plan without queuing anything. The UI
 * always plans first — the failure worth catching is a rule set that covers a
 * fraction of the catalog, and that is far cheaper to see before the renders
 * than after.
 */

import { NextRequest } from 'next/server'
import { planBatch, startBatch, type BatchScope } from '@/services/generation-service'
import { handler, ok, badRequest } from '@/lib/api'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

function readScope(body: any): BatchScope {
  return {
    importId: typeof body?.importId === 'string' ? body.importId : undefined,
    category: typeof body?.category === 'string' ? body.category : undefined,
    search: typeof body?.search === 'string' && body.search.trim() ? body.search.trim() : undefined,
    productIds: Array.isArray(body?.productIds)
      ? body.productIds.filter((id: unknown) => typeof id === 'string')
      : undefined,
    allImages: body?.allImages === true,
    templateId: typeof body?.templateId === 'string' ? body.templateId : undefined,
    requireVision: body?.requireVision !== false,
    overwrite: body?.overwrite === true,
  }
}

export const POST = handler(async (request: NextRequest) => {
  const body = await request.json().catch(() => null)
  if (!body) return badRequest('invalid JSON body')

  const scope = readScope(body)

  if (body.dryRun === true) {
    return ok({ plan: planBatch(scope) })
  }

  const name =
    typeof body.name === 'string' && body.name.trim()
      ? body.name.trim()
      : `Batch ${new Date().toLocaleString()}`

  const result = startBatch(name, scope)

  if (result.queued === 0) {
    return ok(
      {
        ...result,
        message:
          'Nothing was queued. Check the plan warnings — products may be unmatched, awaiting analysis, or already rendered.',
      },
      { status: 200 }
    )
  }

  return ok(result, { status: 201 })
})
