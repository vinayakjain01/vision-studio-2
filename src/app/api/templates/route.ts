/**
 * Templates: list and create.
 */

import { NextRequest } from 'next/server'
import { templates } from '@/db/repositories'
import { createDefaultTemplate, type AspectRatioId } from '@/templates/types'
import { clonePreset } from '@/framing/types'
import { mediaUrl } from '@/storage/media-store'
import { handler, ok, badRequest } from '@/lib/api'

export const dynamic = 'force-dynamic'

export const GET = handler(async (request: NextRequest) => {
  const activeOnly = request.nextUrl.searchParams.get('active') === 'true'
  const list = templates.list({ activeOnly })

  return ok({
    templates: list.map(template => ({
      ...template,
      thumbnailUrl: template.thumbnailKey ? mediaUrl('assets', template.thumbnailKey) : null,
    })),
  })
})

export const POST = handler(async (request: NextRequest) => {
  const body = await request.json().catch(() => null)
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name) return badRequest('name is required')

  const document = createDefaultTemplate((body?.aspectRatio as AspectRatioId) ?? '4:5')

  // Start from a named framing preset when one was chosen, so a new template is
  // immediately useful rather than an empty canvas.
  if (typeof body?.framingPreset === 'string') {
    document.framing = clonePreset(body.framingPreset)
  }

  const template = templates.create({
    name,
    description: typeof body?.description === 'string' ? body.description : null,
    category: typeof body?.category === 'string' ? body.category : null,
    document,
  })

  return ok({ template }, { status: 201 })
})
