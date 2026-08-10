'use client'

/**
 * Generate every photo in this product against one design.
 *
 * The single-photo generator in `CreativeGallery` is scoped to whichever shot
 * is selected. This is the product-level counterpart: pick a design once, and
 * it renders every photo in the folder — the same batch machinery the
 * Generate page uses, just pre-scoped to this one product so there is no
 * "which photos" question to answer.
 */

import * as React from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import { Download, Loader2, Play } from 'lucide-react'
import { fetcher, postJson } from '@/lib/api'
import { Button, Panel, PanelHeader, Progress, Select } from '@/components/ui/primitives'
import type { BatchRecord, TemplateRecord } from '@/db/types'

export function ProductGeneratePanel({
  productId,
  imageCount,
  hasCreatives,
  onGenerated,
}: {
  productId: string
  imageCount: number
  hasCreatives: boolean
  onGenerated: () => void
}) {
  const { data } = useSWR<{ templates: TemplateRecord[] }>('/api/templates?active=true', fetcher)
  const templates = data?.templates ?? []

  const [templateId, setTemplateId] = React.useState('')
  const [starting, setStarting] = React.useState(false)
  const [batchId, setBatchId] = React.useState<string | null>(null)

  // `onSuccess` fires once per completed fetch, which is the right place to
  // react to "the batch just finished" — unlike an effect watching derived
  // render state, it cannot re-trigger itself by writing the state it reads.
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
          setBatchId(null)
        }
      },
    }
  )

  const finished =
    progress?.batch.status === 'completed' ||
    progress?.batch.status === 'failed' ||
    progress?.batch.status === 'cancelled'

  const start = async () => {
    if (!templateId) return
    setStarting(true)
    try {
      const body = await postJson<{ batch: BatchRecord; queued: number; message?: string }>(
        '/api/generate',
        { productIds: [productId], templateId, allImages: true }
      )
      if (body.queued === 0) {
        toast.warning(
          body.message ??
            'Nothing to generate — this design may already be applied to every photo here.'
        )
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

  const running = !!batchId && !finished

  return (
    <Panel>
      <PanelHeader
        title="Generate this product"
        description={`Applies one design to all ${imageCount} photo${imageCount === 1 ? '' : 's'} here, and saves each result.`}
        action={
          <div className="flex items-center gap-2">
            <Select
              aria-label="Design"
              value={templateId}
              onChange={e => setTemplateId(e.target.value)}
              className="w-48"
              disabled={running}
            >
              <option value="">Choose a design…</option>
              {templates.map(template => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </Select>
            <Button variant="primary" onClick={start} disabled={!templateId || starting || running}>
              {starting || running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              {running ? 'Generating…' : 'Generate all'}
            </Button>
          </div>
        }
      />

      {/* Same accent colour as "Generate all" — this is the other half of the
          same job, not a lesser, secondary action. A plain anchor rather than
          a button: the browser streams the ZIP straight to disk, which a
          fetch-based click handler would only get in the way of. */}
      {hasCreatives && (
        <div className="flex justify-end border-t border-[var(--color-border)] px-4 py-3">
          <a
            href={`/api/creatives/download?productId=${productId}`}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-[var(--color-accent)] px-3.5 text-sm font-medium text-[var(--color-accent-ink)] transition-colors select-none hover:brightness-110"
          >
            <Download size={14} />
            Download this product&rsquo;s images
          </a>
        </div>
      )}

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
