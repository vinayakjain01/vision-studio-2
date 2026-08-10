/**
 * One rule: update or delete.
 *
 * Craftify's rules API offers create and delete only, so editing a rule means
 * delete-and-recreate — which loses its creation timestamp and therefore its
 * position in the tie-break order. Supporting PATCH keeps a rule's identity
 * stable across edits.
 */

import { NextRequest } from 'next/server'
import { rules, templates } from '@/db/repositories'
import { handler, ok, badRequest, notFound } from '@/lib/api'

export const dynamic = 'force-dynamic'

export const PATCH = handler(
  async (request: NextRequest, context: { params: Promise<{ ruleId: string }> }) => {
    const { ruleId } = await context.params
    if (!rules.get(ruleId)) return notFound('rule not found')

    const body = await request.json().catch(() => null)
    if (!body) return badRequest('invalid JSON body')

    if (body.templateId !== undefined && !templates.get(body.templateId)) {
      return badRequest('templateId must reference an existing template')
    }

    const rule = rules.update(ruleId, {
      name: typeof body.name === 'string' ? body.name.trim() : undefined,
      matchType: body.matchType,
      operator: body.operator,
      value: typeof body.value === 'string' ? body.value.trim() : undefined,
      templateId: body.templateId,
      priority: Number.isFinite(body.priority) ? Number(body.priority) : undefined,
      isActive: typeof body.isActive === 'boolean' ? body.isActive : undefined,
    })

    return ok({ rule })
  }
)

export const DELETE = handler(
  async (_request: NextRequest, context: { params: Promise<{ ruleId: string }> }) => {
    const { ruleId } = await context.params
    if (!rules.get(ruleId)) return notFound('rule not found')
    rules.remove(ruleId)
    return ok({ deleted: true })
  }
)
