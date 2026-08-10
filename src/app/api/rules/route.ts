/**
 * Rules: list and create.
 *
 * The list is returned in EVALUATION order, matching what the resolver will do,
 * and each row carries its computed specificity. Ordering the UI differently
 * from the matcher is how "why did this product get that template" becomes
 * unanswerable.
 */

import { NextRequest } from 'next/server'
import { rules, templates } from '@/db/repositories'
import { sortRules, specificity } from '@/rules/resolver'
import { handler, ok, badRequest } from '@/lib/api'
import type { RuleMatchType, RuleOperator } from '@/db/types'

export const dynamic = 'force-dynamic'

const MATCH_TYPES: RuleMatchType[] = [
  'folder',
  'category',
  'import',
  'shot_type',
  'garment_type',
  'name',
  'default',
]

const OPERATORS: RuleOperator[] = [
  'equals',
  'contains',
  'starts_with',
  'ends_with',
  'matches',
  'any',
]

export const GET = handler(async (request: NextRequest) => {
  const activeOnly = request.nextUrl.searchParams.get('active') === 'true'
  const list = sortRules(rules.list({ activeOnly }))
  const templateNames = new Map(templates.list().map(t => [t.id, t.name]))

  return ok({
    rules: list.map(rule => ({
      ...rule,
      specificity: specificity(rule),
      templateName: templateNames.get(rule.templateId) ?? null,
    })),
  })
})

export const POST = handler(async (request: NextRequest) => {
  const body = await request.json().catch(() => null)
  if (!body) return badRequest('invalid JSON body')

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return badRequest('name is required')

  if (!MATCH_TYPES.includes(body.matchType)) {
    return badRequest(`matchType must be one of: ${MATCH_TYPES.join(', ')}`)
  }
  if (!OPERATORS.includes(body.operator)) {
    return badRequest(`operator must be one of: ${OPERATORS.join(', ')}`)
  }
  if (typeof body.templateId !== 'string' || !templates.get(body.templateId)) {
    return badRequest('templateId must reference an existing template')
  }

  const value = typeof body.value === 'string' ? body.value.trim() : ''
  if (body.matchType !== 'default' && body.operator !== 'any' && !value) {
    return badRequest('value is required for this match type')
  }

  const rule = rules.create({
    name,
    matchType: body.matchType,
    operator: body.operator,
    value,
    templateId: body.templateId,
    priority: Number.isFinite(body.priority) ? Number(body.priority) : 0,
    isActive: body.isActive !== false,
  })

  return ok({ rule }, { status: 201 })
})
