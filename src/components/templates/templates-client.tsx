'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import useSWR from 'swr'
import { toast } from 'sonner'
import { LayoutTemplate, Loader2, Plus, Trash2 } from 'lucide-react'
import { fetcher, postJson, del } from '@/lib/api'
import { ASPECT_RATIOS, type AspectRatioId } from '@/templates/types'
import { FRAMING_PRESETS } from '@/framing/types'
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Panel,
  PanelHeader,
  Select,
} from '@/components/ui/primitives'
import { timeAgo } from '@/lib/utils'
import type { TemplateRecord } from '@/db/types'

export function TemplatesClient() {
  const router = useRouter()
  const { data, mutate, isLoading } = useSWR<{ templates: TemplateRecord[] }>(
    '/api/templates',
    fetcher
  )
  const [creating, setCreating] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  const [form, setForm] = React.useState({
    name: '',
    aspectRatio: '4:5' as AspectRatioId,
    framingPreset: 'full_body_editorial',
  })

  const create = async () => {
    if (!form.name.trim()) return
    setBusy(true)
    try {
      const body = await postJson<{ template: TemplateRecord }>('/api/templates', form)
      toast.success('Template created')
      router.push(`/templates/${body.template.id}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create template')
      setBusy(false)
    }
  }

  const remove = async (id: string, name: string) => {
    if (!confirm(`Delete "${name}"? Its rules and creatives are removed too.`)) return
    try {
      await del(`/api/templates/${id}`)
      toast.success('Template deleted')
      mutate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete template')
    }
  }

  const templates = data?.templates ?? []

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button variant="primary" onClick={() => setCreating(v => !v)}>
          <Plus size={14} /> New template
        </Button>
      </div>

      {creating && (
        <Panel>
          <PanelHeader
            title="New template"
            description="Pick a canvas and a starting framing preset. Everything stays editable."
          />
          <div className="grid gap-3 px-4 py-4 sm:grid-cols-3">
            <Field label="Name">
              <Input
                autoFocus
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. AW25 hero 4:5"
                onKeyDown={e => e.key === 'Enter' && create()}
              />
            </Field>

            <Field label="Canvas">
              <Select
                value={form.aspectRatio}
                onChange={e => setForm(f => ({ ...f, aspectRatio: e.target.value as AspectRatioId }))}
              >
                {ASPECT_RATIOS.map(ratio => (
                  <option key={ratio.id} value={ratio.id}>
                    {ratio.label} — {ratio.width}×{ratio.height}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Framing preset"
              hint={FRAMING_PRESETS[form.framingPreset]?.description}
            >
              <Select
                value={form.framingPreset}
                onChange={e => setForm(f => ({ ...f, framingPreset: e.target.value }))}
              >
                {Object.entries(FRAMING_PRESETS).map(([id, preset]) => (
                  <option key={id} value={id}>
                    {preset.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="flex justify-end gap-2 border-t border-[var(--color-border)] px-4 py-3">
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={create} disabled={!form.name.trim() || busy}>
              {busy && <Loader2 size={13} className="animate-spin" />}
              Create and open
            </Button>
          </div>
        </Panel>
      )}

      {templates.length === 0 && !isLoading ? (
        <Panel>
          <EmptyState
            icon={<LayoutTemplate size={26} />}
            title="No templates yet"
            description="A template defines where landmarks sit on the canvas — head at 8% from the top, head-to-feet spanning 84% of the height — and the solver derives whatever crop each photo needs to match."
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus size={14} /> Create the first one
              </Button>
            }
          />
        </Panel>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map(template => {
            const canvas = template.document?.canvas
            const strategies = template.document?.framing?.strategies ?? []

            return (
              <Panel key={template.id} className="flex flex-col">
                <Link
                  href={`/templates/${template.id}`}
                  className="flex flex-1 flex-col gap-2 px-4 py-3 transition-colors hover:bg-[var(--color-surface-raised)]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 truncate text-sm font-medium">{template.name}</p>
                    {!template.isActive && <Badge tone="neutral">inactive</Badge>}
                  </div>

                  {canvas && (
                    <p className="numeric text-[11px] text-[var(--color-ink-subtle)]">
                      {canvas.width} × {canvas.height} · {canvas.aspectRatio}
                    </p>
                  )}

                  <div className="flex flex-wrap gap-1">
                    {strategies.slice(0, 3).map(strategy => (
                      <Badge key={strategy.id} tone="neutral">
                        {strategy.label}
                      </Badge>
                    ))}
                    {strategies.length > 3 && <Badge>+{strategies.length - 3}</Badge>}
                  </div>

                  <p className="mt-auto text-[10px] text-[var(--color-ink-subtle)]">
                    Updated {timeAgo(template.updatedAt)}
                  </p>
                </Link>

                <div className="flex justify-end border-t border-[var(--color-border)] px-3 py-1.5">
                  <button
                    onClick={() => remove(template.id, template.name)}
                    className="p-1 text-[var(--color-ink-subtle)] transition-colors hover:text-[var(--color-danger)]"
                    aria-label={`Delete ${template.name}`}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </Panel>
            )
          })}
        </div>
      )}
    </div>
  )
}
