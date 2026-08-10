/**
 * Generate.
 *
 * One question ("which photos?"), one number ("how many images will come out"),
 * one button. Everything else is either a warning that needs acting on or sits
 * behind "More options".
 *
 * The earlier version showed four statistic tiles, a template-split bar chart and
 * a sixty-row table explaining which rule matched each product. All of it is
 * true and none of it is what someone deciding whether to press Generate needs.
 * The per-product reasoning moved behind a disclosure; the warnings — unmatched
 * products, photos still analysing — stayed visible, because those change the
 * outcome.
 */

'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import useSWR from 'swr'
import { toast } from 'sonner'
import { ChevronDown, ChevronRight, Download, Loader2, Play, Wand2 } from 'lucide-react'
import { fetcher, postJson } from '@/lib/api'
import { DeleteButton } from '@/components/ui/delete-button'
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Panel,
  PanelHeader,
  Progress,
  Select,
  Toggle,
} from '@/components/ui/primitives'
import { timeAgo } from '@/lib/utils'
import type { BatchPlan } from '@/services/generation-service'
import type { BatchRecord, ImportRecord, TemplateRecord } from '@/db/types'

export function GenerateClient() {
  const router = useRouter()

  const { data: templateData } = useSWR<{ templates: TemplateRecord[] }>(
    '/api/templates?active=true',
    fetcher
  )
  const { data: importData } = useSWR<{ imports: ImportRecord[] }>('/api/imports', fetcher)
  const { data: productData } = useSWR<{ total: number }>('/api/products?limit=1', fetcher)
  const { data: batchData, mutate: refreshBatches } = useSWR<{ batches: BatchRecord[] }>(
    '/api/batches',
    fetcher,
    {
      refreshInterval: latest =>
        latest?.batches.some(b => b.status === 'running' || b.status === 'queued') ? 2000 : 0,
    }
  )

  const [scope, setScope] = React.useState({
    importId: '',
    templateId: '',
    allImages: true,
    requireVision: true,
    overwrite: false,
  })
  const [name, setName] = React.useState('')
  const [showOptions, setShowOptions] = React.useState(false)
  const [showReasons, setShowReasons] = React.useState(false)
  const [plan, setPlan] = React.useState<BatchPlan | null>(null)
  const [planning, setPlanning] = React.useState(false)
  const [starting, setStarting] = React.useState(false)

  const scopeBody = React.useMemo(
    () => ({
      importId: scope.importId || undefined,
      templateId: scope.templateId || undefined,
      allImages: scope.allImages,
      requireVision: scope.requireVision,
      overwrite: scope.overwrite,
    }),
    [scope]
  )

  // Re-plan whenever the scope changes; every setState is inside the timeout so
  // the effect body never triggers a cascading render.
  React.useEffect(() => {
    let cancelled = false
    const timer = setTimeout(async () => {
      if (cancelled) return
      setPlanning(true)
      try {
        const body = await postJson<{ plan: BatchPlan }>('/api/generate', {
          ...scopeBody,
          dryRun: true,
        })
        if (!cancelled) setPlan(body.plan)
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : 'Could not plan')
      } finally {
        if (!cancelled) setPlanning(false)
      }
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [scopeBody])

  const start = async () => {
    setStarting(true)
    try {
      const body = await postJson<{ batch: BatchRecord; queued: number; message?: string }>(
        '/api/generate',
        { ...scopeBody, name: name.trim() || undefined }
      )
      if (body.queued === 0) {
        toast.warning(body.message ?? 'Nothing to generate')
        setStarting(false)
        refreshBatches()
        return
      }
      toast.success(`Generating ${body.queued} image${body.queued === 1 ? '' : 's'}`)
      router.push(`/generate/${body.batch.id}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start')
      setStarting(false)
    }
  }

  const templates = templateData?.templates ?? []
  const imports = importData?.imports ?? []
  const batches = batchData?.batches ?? []

  if ((productData?.total ?? 0) === 0) {
    return (
      <Panel>
        <EmptyState
          icon={<Wand2 size={26} />}
          title="Nothing to generate from"
          description="Import a folder of photographs first."
          action={
            <Link
              href="/import"
              className="inline-flex items-center rounded-md bg-[var(--color-accent)] px-3.5 py-2 text-sm font-medium text-[var(--color-accent-ink)]"
            >
              Import a folder
            </Link>
          }
        />
      </Panel>
    )
  }

  return (
    <div className="space-y-4">
      <Panel>
        <div className="grid gap-4 px-5 py-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Which photos">
              <Select
                aria-label="Which photos"
                value={scope.importId}
                onChange={e => setScope(s => ({ ...s, importId: e.target.value }))}
              >
                <option value="">Everything</option>
                {imports.map(record => (
                  <option key={record.id} value={record.id}>
                    {record.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Design">
              <Select
                aria-label="Design"
                value={scope.templateId}
                onChange={e => setScope(s => ({ ...s, templateId: e.target.value }))}
              >
                <option value="">Decide automatically (rules)</option>
                {templates.map(template => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {/* The number and the button, together — the only two things needed to
              decide and act. */}
          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="numeric text-3xl font-semibold leading-none">
                {planning && !plan ? '—' : plan?.renderable ?? 0}
              </p>
              <p className="mt-1 text-[11px] text-[var(--color-ink-subtle)]">
                image{plan?.renderable === 1 ? '' : 's'} will be created
              </p>
            </div>

            <Button
              variant="primary"
              size="lg"
              onClick={start}
              disabled={starting || planning || !plan || plan.renderable === 0}
            >
              {starting ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
              Generate
            </Button>
          </div>
        </div>

        {plan && plan.warnings.length > 0 && (
          <div className="space-y-2 border-t border-[var(--color-border)] px-5 py-4">
            {plan.warnings.map((warning, index) => (
              <Alert key={index} tone="warning">
                {warning}
              </Alert>
            ))}
          </div>
        )}

        {/* Options and per-product reasoning, folded away. */}
        <div className="border-t border-[var(--color-border)] px-5 py-3">
          <button
            onClick={() => setShowOptions(v => !v)}
            className="flex items-center gap-1.5 text-[11px] text-[var(--color-ink-subtle)] transition-colors hover:text-[var(--color-ink)]"
          >
            {showOptions ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            More options
          </button>

          {showOptions && (
            <div className="mt-3 space-y-3">
              <Field label="Name" hint="Optional — dated automatically if left blank.">
                <Input
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Auto"
                  className="max-w-sm"
                />
              </Field>

              <Toggle
                label="Use every photo of each product"
                checked={scope.allImages}
                onChange={allImages => setScope(s => ({ ...s, allImages }))}
                hint="Off creates one image per product, from its first photo."
              />
              <Toggle
                label="Only use analysed photos"
                checked={scope.requireVision}
                onChange={requireVision => setScope(s => ({ ...s, requireVision }))}
                hint="Off includes photos that have not been analysed; they will be plainly centred instead of landmark-framed."
              />
              <Toggle
                label="Replace images that already exist"
                checked={scope.overwrite}
                onChange={overwrite => setScope(s => ({ ...s, overwrite }))}
              />

              {plan && plan.items.length > 0 && (
                <div className="pt-1">
                  <button
                    onClick={() => setShowReasons(v => !v)}
                    className="flex items-center gap-1.5 text-[11px] text-[var(--color-ink-subtle)] transition-colors hover:text-[var(--color-ink)]"
                  >
                    {showReasons ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    Which design each product gets
                  </button>

                  {showReasons && (
                    <div className="mt-2 max-h-64 overflow-y-auto rounded-md border border-[var(--color-border)]">
                      <table className="w-full text-[11px]">
                        <tbody>
                          {plan.items.slice(0, 60).map(item => (
                            <tr
                              key={`${item.imageId}-${item.templateId}`}
                              className="border-b border-[var(--color-border)] last:border-0"
                            >
                              <td className="px-3 py-1.5">
                                <span className="block truncate">{item.productName}</span>
                                <span className="block truncate text-[10px] text-[var(--color-ink-subtle)]">
                                  {item.explanation}
                                </span>
                              </td>
                              <td className="px-3 py-1.5 text-right">
                                {item.templateName ? (
                                  <Badge tone="neutral">{item.templateName}</Badge>
                                ) : (
                                  <Badge tone="warning">skipped</Badge>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </Panel>

      {batches.length > 0 && (
        <Panel>
          <PanelHeader
            title="Previous runs"
            description="Download a run as a ZIP, or delete it to discard its images. Your photos are never affected."
          />
          <ul className="divide-y divide-[var(--color-border)]">
            {batches.map(batch => {
              const done = batch.status === 'completed'
              return (
                <li key={batch.id} className="flex items-center gap-3 px-4 py-2.5">
                  <Link href={`/generate/${batch.id}`} className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{batch.name}</p>
                    <p className="numeric mt-0.5 text-[11px] text-[var(--color-ink-subtle)]">
                      {batch.completedJobs}/{batch.totalJobs} images
                      {batch.failedJobs > 0 && ` · ${batch.failedJobs} failed`} ·{' '}
                      {timeAgo(batch.createdAt)}
                    </p>
                  </Link>

                  <div className="w-24 shrink-0">
                    <Progress
                      value={batch.totalJobs > 0 ? batch.completedJobs / batch.totalJobs : 0}
                    />
                  </div>

                  <Badge
                    tone={
                      done
                        ? 'positive'
                        : batch.status === 'failed'
                          ? 'danger'
                          : batch.status === 'running'
                            ? 'accent'
                            : 'neutral'
                    }
                  >
                    {batch.status}
                  </Badge>

                  {batch.completedJobs > 0 && (
                    <a
                      href={`/api/creatives/download?batchId=${batch.id}`}
                      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] px-2 text-[11px] transition-colors hover:bg-[var(--color-surface-raised)]"
                      title="Download this run as a ZIP"
                    >
                      <Download size={12} /> ZIP
                    </a>
                  )}

                  <DeleteButton
                    confirmLabel={`Delete ${batch.completedJobs} image${batch.completedJobs === 1 ? '' : 's'}`}
                    successLabel={`Deleted "${batch.name}"`}
                    onDeleted={() => refreshBatches()}
                    onDelete={async () => {
                      const r = await fetch(`/api/batches/${batch.id}/delete`, { method: 'POST' })
                      if (!r.ok) throw new Error('Could not delete this run')
                      return r.json()
                    }}
                  />
                </li>
              )
            })}
          </ul>
        </Panel>
      )}
    </div>
  )
}
