'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import useSWR from 'swr'
import { toast } from 'sonner'
import { ArrowLeft, Ban, Download, Loader2, RotateCcw } from 'lucide-react'
import { fetcher, patchJson } from '@/lib/api'
import { DeleteButton } from '@/components/ui/delete-button'
import { PageHeader, PageBody } from '@/components/shell/page-header'
import {
  Alert,
  Badge,
  Button,
  Panel,
  PanelHeader,
  Progress,
  Spinner,
  Stat,
} from '@/components/ui/primitives'
import { formatSeconds, timeAgo } from '@/lib/utils'
import type { BatchProgress } from '@/services/generation-service'

interface Response extends BatchProgress {
  creatives?: {
    id: string
    imageId: string
    productId: string
    templateId: string
    url: string
    width: number
    height: number
    strategyId: string | null
    usedFallback: boolean
    violations: number
    renderMs: number
  }[]
}

export function BatchDetailClient({ batchId }: { batchId: string }) {
  const { data, mutate, isLoading } = useSWR<Response>(
    `/api/batches/${batchId}?creatives=true`,
    fetcher,
    {
      // Poll while the batch is live; stop once it settles.
      refreshInterval: latest =>
        latest && (latest.batch.status === 'running' || latest.batch.status === 'queued')
          ? 1500
          : 0,
    }
  )

  const router = useRouter()
  const [busy, setBusy] = React.useState(false)

  const act = async (action: 'cancel' | 'retry') => {
    setBusy(true)
    try {
      await patchJson(`/api/batches/${batchId}`, { action })
      toast.success(action === 'cancel' ? 'Batch cancelled' : 'Failed jobs requeued')
      mutate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  if (isLoading && !data) {
    return (
      <PageBody>
        <div className="flex items-center gap-2 py-16 text-sm text-[var(--color-ink-subtle)]">
          <Spinner /> Loading batch…
        </div>
      </PageBody>
    )
  }

  if (!data) return null

  const { batch, queue, progress, etaSeconds, failures } = data
  const live = batch.status === 'running' || batch.status === 'queued'

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link
              href="/generate"
              className="text-[var(--color-ink-subtle)] transition-colors hover:text-[var(--color-ink)]"
              aria-label="Back to generate"
            >
              <ArrowLeft size={16} />
            </Link>
            {batch.name}
          </span>
        }
        description={`Created ${timeAgo(batch.createdAt)}`}
        actions={
          <>
            <Badge
              tone={
                batch.status === 'completed'
                  ? 'positive'
                  : batch.status === 'failed'
                    ? 'danger'
                    : batch.status === 'running'
                      ? 'accent'
                      : 'neutral'
              }
            >
              {batch.status === 'running' && <Loader2 size={10} className="animate-spin" />}
              {batch.status}
            </Badge>

            {batch.failedJobs > 0 && (
              <Button size="sm" variant="outline" onClick={() => act('retry')} disabled={busy}>
                <RotateCcw size={13} /> Retry {batch.failedJobs} failed
              </Button>
            )}

            {live && (
              <Button size="sm" variant="ghost" onClick={() => act('cancel')} disabled={busy}>
                <Ban size={13} /> Cancel
              </Button>
            )}

            {batch.completedJobs > 0 && (
              <a
                href={`/api/creatives/download?batchId=${batchId}`}
                className="inline-flex h-7 items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-2.5 text-xs font-medium text-[var(--color-accent-ink)] transition-[filter] hover:brightness-110"
              >
                <Download size={13} /> Download ZIP
              </a>
            )}

            <DeleteButton
              confirmLabel={`Delete ${batch.completedJobs} image${batch.completedJobs === 1 ? '' : 's'}`}
              successLabel="Run deleted"
              onDeleted={() => router.push('/generate')}
              onDelete={async () => {
                const r = await fetch(`/api/batches/${batchId}/delete`, { method: 'POST' })
                if (!r.ok) throw new Error('Could not delete this run')
                return r.json()
              }}
            />
          </>
        }
      />

      <PageBody className="space-y-4">
        <Panel>
          <div className="space-y-3 px-4 py-4">
            <Progress value={progress} />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="numeric text-xs text-[var(--color-ink-muted)]">
                {batch.completedJobs} of {batch.totalJobs} rendered
                {queue.running > 0 && ` · ${queue.running} in flight`}
              </p>
              {etaSeconds != null && (
                <p className="numeric text-xs text-[var(--color-ink-subtle)]">
                  about {formatSeconds(etaSeconds)} remaining
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 border-t border-[var(--color-border)] px-4 py-4 sm:grid-cols-4">
            <Stat label="Completed" value={batch.completedJobs} tone="positive" />
            <Stat label="Pending" value={queue.pending} />
            <Stat
              label="Failed"
              value={batch.failedJobs}
              tone={batch.failedJobs > 0 ? 'danger' : 'default'}
            />
            <Stat label="Cancelled" value={batch.cancelledJobs} />
          </div>
        </Panel>

        {failures.length > 0 && (
          <Panel>
            <PanelHeader
              title="Failures"
              description="Each job kept its error. Fix the cause, then retry the batch."
              action={<Badge tone="danger">{failures.length}</Badge>}
            />
            <ul className="max-h-64 divide-y divide-[var(--color-border)] overflow-y-auto">
              {failures.map(failure => (
                <li key={failure.jobId} className="px-4 py-2">
                  <p className="font-mono text-[10px] text-[var(--color-ink-subtle)]">
                    {failure.imageId ?? failure.jobId}
                  </p>
                  <p className="mt-0.5 text-[11px] leading-snug text-[var(--color-danger)]">
                    {failure.error}
                  </p>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        {data.creatives && data.creatives.length > 0 && (
          <Panel>
            <PanelHeader
              title="Rendered"
              description="Fallback and constraint badges mark the creatives worth reviewing."
              action={<Badge>{data.creatives.length}</Badge>}
            />
            <div className="grid grid-cols-2 gap-3 px-4 py-4 sm:grid-cols-4 lg:grid-cols-6">
              {data.creatives.map(creative => (
                <div key={creative.id} className="space-y-1">
                  <Link
                    href={`/products/${creative.productId}`}
                    className="block overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-canvas)] transition-colors hover:border-[var(--color-border-strong)]"
                  >
                    <img
                      src={creative.url}
                      alt=""
                      loading="lazy"
                      className="block h-auto w-full"
                    />
                  </Link>
                  <div className="flex flex-wrap items-center gap-1">
                    {creative.usedFallback && <Badge tone="warning">fallback</Badge>}
                    {creative.violations > 0 && (
                      <Badge tone="warning">{creative.violations}</Badge>
                    )}
                    <span className="numeric text-[10px] text-[var(--color-ink-subtle)]">
                      {creative.renderMs}ms
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        )}

        {batch.status === 'completed' && batch.completedJobs > 0 && (
          <Alert tone="positive" title="Batch complete">
            {batch.completedJobs} creatives rendered. They are on the{' '}
            <Link href="/creatives" className="underline">
              creatives page
            </Link>{' '}
            and on each product.
          </Alert>
        )}
      </PageBody>
    </>
  )
}
