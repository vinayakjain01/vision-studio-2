/**
 * One template: read, update, delete.
 *
 * `PATCH` passes an explicit field allow-list to the repository rather than
 * spreading the request body — that is how a template editor endpoint becomes a
 * way to rewrite `id` or `created_at`.
 */

import { NextRequest } from 'next/server'
import { templates } from '@/db/repositories'
import { TEMPLATE_SCHEMA_VERSION, type TemplateDocument } from '@/templates/types'
import { handler, ok, badRequest, notFound } from '@/lib/api'

export const dynamic = 'force-dynamic'

export const GET = handler(
  async (_request: NextRequest, context: { params: Promise<{ templateId: string }> }) => {
    const { templateId } = await context.params
    const template = templates.get(templateId)
    if (!template) return notFound('template not found')
    return ok({ template })
  }
)

export const PATCH = handler(
  async (request: NextRequest, context: { params: Promise<{ templateId: string }> }) => {
    const { templateId } = await context.params
    if (!templates.get(templateId)) return notFound('template not found')

    const body = await request.json().catch(() => null)
    if (!body) return badRequest('invalid JSON body')

    if (body.document !== undefined) {
      const invalid = validateDocument(body.document)
      if (invalid) return badRequest(invalid)
    }

    const template = templates.update(templateId, {
      name: typeof body.name === 'string' ? body.name : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      category: typeof body.category === 'string' ? body.category : undefined,
      isActive: typeof body.isActive === 'boolean' ? body.isActive : undefined,
      document: body.document as TemplateDocument | undefined,
    })

    return ok({ template })
  }
)

export const DELETE = handler(
  async (_request: NextRequest, context: { params: Promise<{ templateId: string }> }) => {
    const { templateId } = await context.params
    if (!templates.get(templateId)) return notFound('template not found')
    // Cascades to rules referencing this template, and to its creatives.
    templates.remove(templateId)
    return ok({ deleted: true })
  }
)

/**
 * Structural validation.
 *
 * A malformed document does not fail here — it fails inside a render worker,
 * once per image, after the batch has started. Rejecting it at the edge turns
 * that into one clear error at save time.
 */
function validateDocument(document: unknown): string | null {
  if (!document || typeof document !== 'object') return 'document must be an object'

  const doc = document as Partial<TemplateDocument>

  if (doc.schemaVersion !== TEMPLATE_SCHEMA_VERSION) {
    return `unsupported document schemaVersion (expected ${TEMPLATE_SCHEMA_VERSION})`
  }
  if (!doc.canvas || typeof doc.canvas.width !== 'number' || typeof doc.canvas.height !== 'number') {
    return 'document.canvas must have numeric width and height'
  }
  if (doc.canvas.width < 64 || doc.canvas.height < 64) {
    return 'canvas must be at least 64px on each side'
  }
  if (doc.canvas.width > 8192 || doc.canvas.height > 8192) {
    return 'canvas must be at most 8192px on each side'
  }
  if (!doc.framing || !Array.isArray(doc.framing.strategies)) {
    return 'document.framing.strategies must be an array'
  }
  if (doc.framing.strategies.length === 0) {
    return 'framing must define at least one strategy'
  }
  // The last strategy is the backstop for images where nothing was detected.
  // If it requires anchors, such an image has no way to resolve and the solver
  // would fall through to a strategy it cannot satisfy.
  const last = doc.framing.strategies[doc.framing.strategies.length - 1]
  if (last.requires && last.requires.length > 0) {
    return 'the final framing strategy must require no anchors so every image can resolve'
  }
  if (!Array.isArray(doc.layers)) return 'document.layers must be an array'
  if (doc.layers.length > 100) return 'a template may contain at most 100 layers'

  return null
}
