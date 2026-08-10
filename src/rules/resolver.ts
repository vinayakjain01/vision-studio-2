/**
 * Rules engine — mapping products to templates.
 *
 * Deliberately small. A rule is one condition and one template; resolution is a
 * scan in a fully-determined order. There is no expression language, no
 * boolean composition, no nesting — those turn "which template did this product
 * get, and why" into a debugging exercise, and that question is asked constantly
 * during a bulk run.
 *
 * ── Ordering is total ────────────────────────────────────────────────────────
 * Rules sort by priority, then SPECIFICITY, then creation time, then id. Every
 * comparison is deterministic, so two runs over the same data always match the
 * same rule.
 *
 * Specificity matters because priority alone forces the operator to hand-manage
 * numbers: with `folder = AW25` and `folder = AW25/dresses` at equal priority,
 * the intent is obviously the more specific one, and a first-match scan in
 * storage order gets it right only by luck.
 *
 * ── Vision-aware matching ────────────────────────────────────────────────────
 * `shot_type` and `garment_type` match against the Vision Engine's findings, so
 * a rule can say "full-body shots use the editorial template, close-ups use the
 * beauty template" — a routing decision no folder structure encodes.
 *
 * Isomorphic: pure functions over plain data, so the UI can preview matches
 * without a round trip.
 */

import type { RuleRecord, RuleMatchType, RuleOperator } from '@/db/types'
import type { GarmentType, ShotType } from '@/vision/types'

/** What a rule is matched against. */
export interface RuleSubject {
  productId: string
  productName: string
  folderPath: string
  category: string | null
  importId: string | null
  /** From the image's analysis. Null when not yet analysed. */
  shotType: ShotType | null
  garmentType: GarmentType | null
}

export interface RuleMatch {
  rule: RuleRecord
  templateId: string
  /** Why this rule won, in words. Shown in the rules UI and the batch report. */
  explanation: string
}

export interface ResolveResult {
  match: RuleMatch | null
  /** Every rule evaluated and its outcome, in order. For the "why" panel. */
  trace: RuleTraceEntry[]
}

export interface RuleTraceEntry {
  ruleId: string
  ruleName: string
  matched: boolean
  /** Set when the rule could not be evaluated rather than simply not matching. */
  skipped?: 'inactive' | 'no_vision_data'
}

/**
 * How narrow a rule is. Higher wins at equal priority.
 *
 * The scale reflects how much a match constrains the subject: an exact folder
 * path identifies one directory, a `contains` on a name could hit anything, and
 * `default` matches everything by definition.
 */
export function specificity(rule: RuleRecord): number {
  if (rule.matchType === 'default') return 0

  const operatorWeight: Record<RuleOperator, number> = {
    any: 1,
    contains: 2,
    ends_with: 3,
    starts_with: 4,
    matches: 4,
    equals: 5,
  }

  const typeWeight: Record<RuleMatchType, number> = {
    default: 0,
    name: 1,
    category: 2,
    import: 3,
    shot_type: 3,
    garment_type: 3,
    folder: 4,
  }

  // Path depth breaks ties between two folder rules: `AW25/dresses/silk` is
  // more specific than `AW25`, and both may use the same operator.
  const depth =
    rule.matchType === 'folder' ? rule.value.split('/').filter(Boolean).length : 0

  return typeWeight[rule.matchType] * 100 + operatorWeight[rule.operator] * 10 + depth
}

/**
 * Evaluation order. Exported so the UI can list rules exactly as the resolver
 * will see them — an operator should never have to guess the order.
 */
export function sortRules(rules: RuleRecord[]): RuleRecord[] {
  return [...rules].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority
    const sa = specificity(a)
    const sb = specificity(b)
    if (sa !== sb) return sb - sa
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
    return a.id < b.id ? -1 : 1
  })
}

export function resolveTemplate(subject: RuleSubject, rules: RuleRecord[]): ResolveResult {
  const ordered = sortRules(rules)
  const trace: RuleTraceEntry[] = []

  for (const rule of ordered) {
    if (!rule.isActive) {
      trace.push({ ruleId: rule.id, ruleName: rule.name, matched: false, skipped: 'inactive' })
      continue
    }

    // A vision-based rule cannot be evaluated before analysis has run. Skipping
    // is right — falling through to a later rule would give this product a
    // different template than it will get once analysed, so the same catalog
    // would render differently depending on when generation was started.
    const needsVision = rule.matchType === 'shot_type' || rule.matchType === 'garment_type'
    const hasVision = subject.shotType !== null || subject.garmentType !== null
    if (needsVision && !hasVision) {
      trace.push({
        ruleId: rule.id,
        ruleName: rule.name,
        matched: false,
        skipped: 'no_vision_data',
      })
      continue
    }

    const matched = evaluate(rule, subject)
    trace.push({ ruleId: rule.id, ruleName: rule.name, matched })

    if (matched) {
      return {
        match: {
          rule,
          templateId: rule.templateId,
          explanation: explain(rule, subject),
        },
        trace,
      }
    }
  }

  return { match: null, trace }
}

function subjectField(rule: RuleRecord, subject: RuleSubject): string | null {
  switch (rule.matchType) {
    case 'folder':
      return subject.folderPath
    case 'category':
      return subject.category
    case 'import':
      return subject.importId
    case 'name':
      return subject.productName
    case 'shot_type':
      return subject.shotType
    case 'garment_type':
      return subject.garmentType
    case 'default':
      return ''
  }
}

function evaluate(rule: RuleRecord, subject: RuleSubject): boolean {
  if (rule.matchType === 'default') return true

  const field = subjectField(rule, subject)
  if (field === null) return false

  // Case-insensitive throughout: folder names come from a filesystem whose
  // case-sensitivity varies by platform, and an operator typing "Dresses"
  // should match a folder named "dresses".
  const haystack = field.toLowerCase()
  const needle = rule.value.trim().toLowerCase()

  switch (rule.operator) {
    case 'any':
      return true
    case 'equals':
      return haystack === needle
    case 'contains':
      return needle.length > 0 && haystack.includes(needle)
    case 'starts_with':
      // For folders, anchor on a path boundary so `AW25` does not match
      // `AW25-archive` — a silent mis-route that is very hard to spot in a
      // bulk run.
      if (rule.matchType === 'folder') {
        return haystack === needle || haystack.startsWith(`${needle}/`)
      }
      return haystack.startsWith(needle)
    case 'ends_with':
      return haystack.endsWith(needle)
    case 'matches':
      return matchGlob(haystack, needle)
  }
}

/**
 * Glob matching for folder patterns: `*` within a segment, `**` across segments.
 *
 * A glob rather than a regular expression because the value is typed by an
 * operator describing a folder layout, and an unanchored user-supplied regex is
 * both a footgun and a denial-of-service surface.
 */
export function matchGlob(value: string, pattern: string): boolean {
  if (pattern.length === 0) return false

  // Build the equivalent regex, escaping everything that is not a wildcard.
  let regex = ''
  let i = 0
  while (i < pattern.length) {
    const char = pattern[i]
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // `**` spans separators; `**/` should also match zero segments.
        if (pattern[i + 2] === '/') {
          regex += '(?:.*/)?'
          i += 3
        } else {
          regex += '.*'
          i += 2
        }
      } else {
        regex += '[^/]*'
        i += 1
      }
    } else if (char === '?') {
      regex += '[^/]'
      i += 1
    } else {
      regex += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      i += 1
    }
  }

  try {
    return new RegExp(`^${regex}$`).test(value)
  } catch {
    return false
  }
}

function explain(rule: RuleRecord, subject: RuleSubject): string {
  if (rule.matchType === 'default') {
    return `Default rule "${rule.name}" — matches every product.`
  }

  const field = subjectField(rule, subject) ?? ''
  const labels: Record<RuleMatchType, string> = {
    folder: 'folder',
    category: 'category',
    import: 'import',
    name: 'product name',
    shot_type: 'detected shot type',
    garment_type: 'detected garment type',
    default: 'default',
  }
  const operators: Record<RuleOperator, string> = {
    equals: 'is',
    contains: 'contains',
    starts_with: 'starts with',
    ends_with: 'ends with',
    matches: 'matches',
    any: 'is anything',
  }

  return `${labels[rule.matchType]} "${field}" ${operators[rule.operator]} "${rule.value}" (rule "${rule.name}", priority ${rule.priority})`
}

// ─── Bulk planning ───────────────────────────────────────────────────────────

export interface PlannedAssignment {
  subject: RuleSubject
  templateId: string | null
  explanation: string
}

export interface GenerationPlan {
  assignments: PlannedAssignment[]
  matched: number
  unmatched: number
  /** Product count per template, for the pre-run summary. */
  byTemplate: { templateId: string; count: number }[]
}

/**
 * Resolve a whole catalog against the rule set.
 *
 * Run before enqueuing so the operator sees exactly what a batch will do —
 * including how many products no rule covers, which is the mistake worth
 * catching before four thousand renders rather than after.
 */
export function planGeneration(subjects: RuleSubject[], rules: RuleRecord[]): GenerationPlan {
  const ordered = sortRules(rules)
  const assignments: PlannedAssignment[] = []
  const counts = new Map<string, number>()

  let matched = 0
  let unmatched = 0

  for (const subject of subjects) {
    const { match } = resolveTemplate(subject, ordered)
    if (match) {
      matched++
      counts.set(match.templateId, (counts.get(match.templateId) ?? 0) + 1)
      assignments.push({
        subject,
        templateId: match.templateId,
        explanation: match.explanation,
      })
    } else {
      unmatched++
      assignments.push({
        subject,
        templateId: null,
        explanation: 'No rule matched. Add a default rule to cover every product.',
      })
    }
  }

  return {
    assignments,
    matched,
    unmatched,
    byTemplate: [...counts.entries()]
      .map(([templateId, count]) => ({ templateId, count }))
      .sort((a, b) => b.count - a.count),
  }
}

// ─── Metadata for the UI ─────────────────────────────────────────────────────

export const MATCH_TYPE_OPTIONS: {
  value: RuleMatchType
  label: string
  description: string
  operators: RuleOperator[]
}[] = [
  {
    value: 'folder',
    label: 'Folder path',
    description: 'The folder the product was imported from, relative to the import root.',
    operators: ['equals', 'starts_with', 'contains', 'matches'],
  },
  {
    value: 'category',
    label: 'Category',
    description: 'The folder one level above the product folder.',
    operators: ['equals', 'contains', 'starts_with'],
  },
  {
    value: 'import',
    label: 'Import batch',
    description: 'Everything from one upload session.',
    operators: ['equals'],
  },
  {
    value: 'shot_type',
    label: 'Detected shot type',
    description: 'What the Vision Engine classified the photo as.',
    operators: ['equals'],
  },
  {
    value: 'garment_type',
    label: 'Detected garment type',
    description: 'What the Vision Engine parsed the clothing as.',
    operators: ['equals'],
  },
  {
    value: 'name',
    label: 'Product name',
    description: 'Derived from the folder or file name.',
    operators: ['contains', 'starts_with', 'ends_with', 'equals'],
  },
  {
    value: 'default',
    label: 'Everything else',
    description: 'Catch-all. Give it the lowest priority so it runs last.',
    operators: ['any'],
  },
]

export const SHOT_TYPE_VALUES: ShotType[] = [
  'full_body',
  'three_quarter',
  'half_body',
  'portrait',
  'close_up',
  'detail',
  'flat_lay',
  'product_only',
  'unknown',
]

export const GARMENT_TYPE_VALUES: GarmentType[] = [
  'full_outfit',
  'upper_body',
  'lower_body',
  'outerwear',
  'accessory',
  'unknown',
]
