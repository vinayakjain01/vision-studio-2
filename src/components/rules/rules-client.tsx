'use client'

import * as React from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { toast } from 'sonner'
import { ArrowDown, Loader2, Plus, Route, Trash2 } from 'lucide-react'
import { fetcher, postJson, patchJson, del } from '@/lib/api'
import {
  MATCH_TYPE_OPTIONS,
  SHOT_TYPE_VALUES,
  GARMENT_TYPE_VALUES,
} from '@/rules/resolver'
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Panel,
  PanelHeader,
  Select,
  Toggle,
} from '@/components/ui/primitives'
import { humanize } from '@/lib/utils'
import type { RuleMatchType, RuleOperator, RuleRecord, TemplateRecord, ImportRecord } from '@/db/types'

interface RuleWithMeta extends RuleRecord {
  specificity: number
  templateName: string | null
}

export function RulesClient() {
  const { data, mutate, isLoading } = useSWR<{ rules: RuleWithMeta[] }>('/api/rules', fetcher)
  const { data: templateData } = useSWR<{ templates: TemplateRecord[] }>('/api/templates', fetcher)
  const { data: importData } = useSWR<{ imports: ImportRecord[] }>('/api/imports', fetcher)
  const { data: productData } = useSWR<{ categories: { category: string; count: number }[] }>(
    '/api/products?limit=1',
    fetcher
  )

  const [creating, setCreating] = React.useState(false)

  const rules = data?.rules ?? []
  const templates = templateData?.templates ?? []
  const hasDefault = rules.some(r => r.matchType === 'default' && r.isActive)

  const remove = async (id: string) => {
    try {
      await del(`/api/rules/${id}`)
      mutate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete rule')
    }
  }

  const patch = async (id: string, body: Partial<RuleRecord>) => {
    try {
      await patchJson(`/api/rules/${id}`, body)
      mutate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update rule')
    }
  }

  if (templates.length === 0 && !isLoading) {
    return (
      <Panel>
        <EmptyState
          icon={<Route size={26} />}
          title="Create a template first"
          description="A rule points products at a template, so there needs to be at least one to point at."
          action={
            <Link
              href="/templates"
              className="inline-flex items-center rounded-md bg-[var(--color-accent)] px-3.5 py-2 text-sm font-medium text-[var(--color-accent-ink)]"
            >
              Go to templates
            </Link>
          }
        />
      </Panel>
    )
  }

  return (
    <div className="space-y-4">
      {rules.length > 0 && !hasDefault && (
        <Alert tone="warning" title="No catch-all rule">
          Products matching nothing are skipped during generation. Add an &ldquo;Everything
          else&rdquo; rule with the lowest priority so every product is covered.
        </Alert>
      )}

      <div className="flex justify-end">
        <Button variant="primary" onClick={() => setCreating(v => !v)}>
          <Plus size={14} /> New rule
        </Button>
      </div>

      {creating && (
        <RuleForm
          templates={templates}
          imports={importData?.imports ?? []}
          categories={productData?.categories ?? []}
          suggestedPriority={rules.length > 0 ? Math.max(...rules.map(r => r.priority)) + 10 : 100}
          onCancel={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            mutate()
          }}
        />
      )}

      {rules.length === 0 && !isLoading ? (
        <Panel>
          <EmptyState
            icon={<Route size={26} />}
            title="No rules yet"
            description="Without rules, a bulk run needs a template chosen manually. A rule set lets one run cover a whole catalog — dresses to one template, close-ups to another."
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus size={14} /> Create a rule
              </Button>
            }
          />
        </Panel>
      ) : (
        <Panel>
          <PanelHeader
            title="Evaluation order"
            description="Priority first, then specificity, then age. The first rule that matches decides the template."
          />
          <ul className="divide-y divide-[var(--color-border)]">
            {rules.map((rule, index) => (
              <li key={rule.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="numeric mt-0.5 w-5 shrink-0 text-right text-[11px] text-[var(--color-ink-subtle)]">
                      {index + 1}
                    </span>

                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium">{rule.name}</p>
                      <p className="mt-0.5 text-[11px] text-[var(--color-ink-subtle)]">
                        {describeRule(rule)}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        <Badge tone="accent">{rule.templateName ?? 'missing template'}</Badge>
                        <Badge tone="neutral">priority {rule.priority}</Badge>
                        <Badge tone="neutral">specificity {rule.specificity}</Badge>
                        {!rule.isActive && <Badge tone="warning">inactive</Badge>}
                      </div>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <Toggle
                      label=""
                      checked={rule.isActive}
                      onChange={isActive => patch(rule.id, { isActive })}
                    />
                    <button
                      onClick={() => remove(rule.id)}
                      className="p-1 text-[var(--color-ink-subtle)] transition-colors hover:text-[var(--color-danger)]"
                      aria-label={`Delete ${rule.name}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>

                {index < rules.length - 1 && (
                  <div className="mt-2 flex items-center gap-1 pl-8 text-[10px] text-[var(--color-ink-subtle)]">
                    <ArrowDown size={10} /> if no match
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  )
}

function describeRule(rule: RuleRecord): string {
  if (rule.matchType === 'default') return 'Matches every product'

  const labels: Record<RuleMatchType, string> = {
    folder: 'Folder path',
    category: 'Category',
    import: 'Import',
    shot_type: 'Detected shot type',
    garment_type: 'Detected garment type',
    name: 'Product name',
    default: 'Everything',
  }
  const operators: Record<RuleOperator, string> = {
    equals: 'is',
    contains: 'contains',
    starts_with: 'starts with',
    ends_with: 'ends with',
    matches: 'matches pattern',
    any: 'is anything',
  }

  return `${labels[rule.matchType]} ${operators[rule.operator]} "${rule.value}"`
}

function RuleForm({
  templates,
  imports,
  categories,
  suggestedPriority,
  onCancel,
  onCreated,
}: {
  templates: TemplateRecord[]
  imports: ImportRecord[]
  categories: { category: string; count: number }[]
  suggestedPriority: number
  onCancel: () => void
  onCreated: () => void
}) {
  // Defaults to the most recent IMPORT BATCH: the overwhelmingly common intent is
  // "apply this template to the folder I just uploaded". Folder-path matching is
  // more powerful but requires knowing the tree layout, which is a worse first
  // question to ask someone.
  const [form, setForm] = React.useState({
    name: '',
    matchType: 'import' as RuleMatchType,
    operator: 'equals' as RuleOperator,
    value: imports[0]?.id ?? '',
    templateId: templates[0]?.id ?? '',
    priority: suggestedPriority,
  })
  const [busy, setBusy] = React.useState(false)

  const option = MATCH_TYPE_OPTIONS.find(o => o.value === form.matchType)!

  /**
   * Changing the match type also picks a valid operator for it.
   *
   * Done here rather than in an effect that watches `matchType`: the operator is
   * derived from the match type, so the moment the type changes is the moment to
   * decide it. Reconciling afterwards in an effect renders once with an invalid
   * pair and once more to correct it.
   */
  const changeMatchType = (matchType: RuleMatchType) => {
    const next = MATCH_TYPE_OPTIONS.find(o => o.value === matchType)!
    setForm(f => ({
      ...f,
      matchType,
      operator: next.operators.includes(f.operator) ? f.operator : next.operators[0],
      // A value written for one match type rarely makes sense for another —
      // a folder path is not a shot type.
      value: matchType === f.matchType ? f.value : '',
    }))
  }

  const submit = async () => {
    setBusy(true)
    try {
      // Name it after what it matches when left blank — a required field the
      // user has no opinion about is just friction.
      const fallbackName =
        form.matchType === 'import'
          ? (imports.find(i => i.id === form.value)?.name ?? 'Import batch')
          : form.value || 'Everything else'
      await postJson('/api/rules', { ...form, name: form.name.trim() || fallbackName })
      toast.success('Rule created')
      onCreated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create rule')
      setBusy(false)
    }
  }

  const needsValue = form.matchType !== 'default' && form.operator !== 'any'

  return (
    <Panel>
      <PanelHeader title="New rule" description={option.description} />

      <div className="grid gap-3 px-4 py-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Name" hint="Optional — named after the batch if left blank.">
          <Input
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="Auto"
          />
        </Field>

        <Field label="Match on">
          <Select
            value={form.matchType}
            onChange={e => changeMatchType(e.target.value as RuleMatchType)}
          >
            {MATCH_TYPE_OPTIONS.map(entry => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Condition">
          <Select
            value={form.operator}
            onChange={e => setForm(f => ({ ...f, operator: e.target.value as RuleOperator }))}
          >
            {option.operators.map(op => (
              <option key={op} value={op}>
                {humanize(op)}
              </option>
            ))}
          </Select>
        </Field>

        {needsValue && (
          <Field
            label="Value"
            hint={
              form.matchType === 'folder' && form.operator === 'matches'
                ? 'Glob pattern: * within a segment, ** across segments.'
                : undefined
            }
          >
            <ValueInput
              matchType={form.matchType}
              value={form.value}
              onChange={value => setForm(f => ({ ...f, value }))}
              imports={imports}
              categories={categories}
            />
          </Field>
        )}

        <Field label="Template">
          <Select
            value={form.templateId}
            onChange={e => setForm(f => ({ ...f, templateId: e.target.value }))}
          >
            {templates.map(template => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Priority" hint="Higher runs first. A catch-all should be lowest.">
          <Input
            type="number"
            value={form.priority}
            onChange={e => setForm(f => ({ ...f, priority: Number(e.target.value) || 0 }))}
          />
        </Field>
      </div>

      <div className="flex justify-end gap-2 border-t border-[var(--color-border)] px-4 py-3">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={submit}
          disabled={busy || !form.templateId || (needsValue && !form.value.trim())}
        >
          {busy && <Loader2 size={13} className="animate-spin" />}
          Create rule
        </Button>
      </div>
    </Panel>
  )
}

/** The value field adapts: a dropdown where the set of options is known. */
function ValueInput({
  matchType,
  value,
  onChange,
  imports,
  categories,
}: {
  matchType: RuleMatchType
  value: string
  onChange: (value: string) => void
  imports: ImportRecord[]
  categories: { category: string; count: number }[]
}) {
  if (matchType === 'shot_type') {
    return (
      <Select value={value} onChange={e => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {SHOT_TYPE_VALUES.map(type => (
          <option key={type} value={type}>
            {humanize(type)}
          </option>
        ))}
      </Select>
    )
  }

  if (matchType === 'garment_type') {
    return (
      <Select value={value} onChange={e => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {GARMENT_TYPE_VALUES.map(type => (
          <option key={type} value={type}>
            {humanize(type)}
          </option>
        ))}
      </Select>
    )
  }

  if (matchType === 'import') {
    return (
      <Select value={value} onChange={e => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {imports.map(record => (
          <option key={record.id} value={record.id}>
            {record.name}
          </option>
        ))}
      </Select>
    )
  }

  if (matchType === 'category' && categories.length > 0) {
    return (
      <>
        <Input value={value} onChange={e => onChange(e.target.value)} list="rule-categories" />
        <datalist id="rule-categories">
          {categories.map(entry => (
            <option key={entry.category} value={entry.category} />
          ))}
        </datalist>
      </>
    )
  }

  return <Input value={value} onChange={e => onChange(e.target.value)} placeholder="AW25/dresses" />
}
