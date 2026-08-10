'use client'

/**
 * Bulk "one template, everything in view" generate + download for the
 * Products page.
 *
 * Distinct from the Rules-based Generate page on purpose: this is a
 * deliberate override ("apply this exact design to every one of these
 * products"), not rule resolution, and it is scoped to whatever the
 * Products page's own search/category filters currently show — the same
 * scope the operator is already looking at, not a separate selection step.
 *
 * Uses the same batch queue and progress-polling pattern as
 * `ProductGeneratePanel` (the per-product version on the product detail
 * page) and `getBatchProgress` on the Generate page — no parallel execution
 * path, just a different scope.
 */

import * as React from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import { Download, Loader2, Play } from 'lucide-react'
import { fetcher, postJson } from '@/lib/api'
import { Button, Panel, Progress, Select } from '@/components/ui/primitives'
import type { BatchRecord, TemplateRecord } from '@/db/types'

export function BulkGeneratePanel({
  search,
  category,
  productCount,
  onGenerated,
}: {
  /** Current Products-page filters — the bulk action's scope. */
  search: string
  category: string
  /** How many products currently match, just for the button's label. */
  productCount: number
  onGenerated: () => void
}) {
  const { data } = useSWR<{ templates: TemplateRecord[] }>('/api/templates?active=true', fetcher)
  const templates = data?.templates ?? []

  const [templateId, setTemplateId] = React.useState('')
  const [starting, setStarting] = React.useState(false)
  const [batchId, setBatchId] = React.useState<string | null>(null)
  // The batch a completed download link should point at. Kept separate from
  // `batchId` (which clears back to null once a run finishes) so the
  // Download button survives after the progress bar disappears — "always
  // reflects the latest generation" only needs the last completed run, not
  // a history of every one.
  const [downloadBatchId, setDownloadBatchId] = React.useState<string | null>(null)

  const { data: progress } = useSWR<{ batch: BatchRecord }>(
    batchId ? `/api/batches/${batchId}` : null,
    fetcher,
    {
      refreshInterval: latest =>
        latest?.batch.status === 'running' || latest?.batch.status === 'queued' ? 1200 : 0,
      onSuccess: latest => {
        const status = latest.batch.status
        if (status === 'completed' || status === 'failed' || status === 'cancelled') {
          onGenerated()
          if (latest.batch.completedJobs > 0) setDownloadBatchId(latest.batch.id)
          setBatchId(null)
        }
      },
    }
  )

  const running = !!batchId

  const start = async () => {
    if (!templateId) return
    setStarting(true)
    try {
      const body = await postJson<{ batch: BatchRecord; queued: number; message?: string }>(
        '/api/generate',
        {
          search: search || undefined,
          category: category || undefined,
          templateId,
          allImages: true,
        }
      )
      if (body.queued === 0) {
        toast.warning(body.message ?? 'Nothing to generate for the products currently shown.')
        return
      }
      toast.success(`Generating ${body.queued} image${body.queued === 1 ? '' : 's'}`)
      setBatchId(body.batch.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start')
    } finally {
      setStarting(false)
    }
  }

  const scopeLabel =
    search || category
      ? `the ${productCount} product${productCount === 1 ? '' : 's'} currently shown`
      : `all ${productCount} product${productCount === 1 ? '' : 's'}`

  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <Select
          aria-label="Design"
          value={templateId}
          onChange={e => setTemplateId(e.target.value)}
          className="h-8 w-52 text-xs"
          disabled={running}
        >
          <option value="">Choose a design…</option>
          {templates.map(template => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </Select>

        <Button size="sm" variant="primary" onClick={start} disabled={!templateId || starting || running}>
          {starting || running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
          {running ? 'Generating…' : 'Generate'}
        </Button>

        {downloadBatchId && !running && (
          <a
            href={`/api/creatives/download?batchId=${downloadBatchId}&layout=catalog`}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 text-xs font-medium text-[var(--color-accent-ink)] transition-colors hover:brightness-110"
          >
            <Download size={13} />
            Download
          </a>
        )}

        <span className="text-[11px] text-[var(--color-ink-subtle)]">
          Applies to {scopeLabel}, all photos.
        </span>
      </div>

      {running && progress && (
        <div className="space-y-1.5 border-t border-[var(--color-border)] px-4 py-3">
          <Progress
            value={
              progress.batch.totalJobs > 0
                ? progress.batch.completedJobs / progress.batch.totalJobs
                : 0
            }
          />
          <p className="numeric text-[11px] text-[var(--color-ink-subtle)]">
            {progress.batch.completedJobs}/{progress.batch.totalJobs} done
            {progress.batch.failedJobs > 0 && ` · ${progress.batch.failedJobs} failed`}
          </p>
        </div>
      )}
    </Panel>
  )
}
