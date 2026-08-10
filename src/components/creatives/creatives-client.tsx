'use client'

import * as React from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { Download, Sparkles } from 'lucide-react'
import { fetcher } from '@/lib/api'
import { DeleteButton } from '@/components/ui/delete-button'
import { Badge, Button, EmptyState, Panel, Tabs } from '@/components/ui/primitives'
import { formatBytes, timeAgo } from '@/lib/utils'

interface Creative {
  id: string
  productId: string
  productName: string
  imageId: string
  templateId: string
  templateName: string
  url: string
  width: number
  height: number
  byteSize: number
  strategyId: string | null
  strategyLabel: string | null
  usedFallback: boolean
  violations: number
  renderMs: number
  createdAt: string
}

type Filter = 'all' | 'review'

const PAGE_SIZE = 60

export function CreativesClient() {
  const [limit, setLimit] = React.useState(PAGE_SIZE)
  const [filter, setFilter] = React.useState<Filter>('all')

  const { data, isLoading, mutate } = useSWR<{ creatives: Creative[]; total: number; hasMore: boolean }>(
    `/api/creatives?limit=${limit}`,
    fetcher,
    { keepPreviousData: true }
  )

  const all = data?.creatives ?? []
  // "Needs review" is the practically useful filter on a bulk run: these are
  // the creatives where the template's primary rule did not apply cleanly.
  const review = all.filter(c => c.usedFallback || c.violations > 0)
  const shown = filter === 'review' ? review : all

  if (all.length === 0 && !isLoading) {
    return (
      <Panel>
        <EmptyState
          icon={<Sparkles size={26} />}
          title="No creatives yet"
          description="Run a batch from the Generate page, or render a single shot from a product."
          action={
            <Link
              href="/generate"
              className="inline-flex items-center rounded-md bg-[var(--color-accent)] px-3.5 py-2 text-sm font-medium text-[var(--color-accent-ink)]"
            >
              Go to generate
            </Link>
          }
        />
      </Panel>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <Tabs
          value={filter}
          onChange={setFilter}
          tabs={[
            { value: 'all', label: 'All', count: data?.total },
            { value: 'review', label: 'Needs review', count: review.length },
          ]}
        />

        <div className="flex items-center gap-3">
          {data && (
            <span className="numeric text-xs text-[var(--color-ink-subtle)]">
              {data.total} image{data.total === 1 ? '' : 's'}
            </span>
          )}
          {/* A plain anchor, not a fetch and not next/link: the browser streams
              the ZIP straight to disk with its own progress UI, and nothing is
              held in page memory. `next/link` would client-side navigate to a
              route handler, which downloads nothing. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a
            href="/api/creatives/download"
            className="inline-flex h-9 items-center gap-2 rounded-md bg-[var(--color-accent)] px-3.5 text-sm font-medium text-[var(--color-accent-ink)] transition-[filter] hover:brightness-110"
          >
            <Download size={14} />
            Download all
          </a>
          <DeleteButton
            size="sm"
            confirmLabel={`Delete all ${data?.total ?? 0}`}
            successLabel="All generated images deleted"
            onDeleted={() => mutate()}
            onDelete={async () => {
              const r = await fetch('/api/creatives/all', { method: 'DELETE' })
              if (!r.ok) throw new Error('Could not delete the images')
              return r.json()
            }}
          />
        </div>
      </div>

      {shown.length === 0 ? (
        <Panel>
          <EmptyState
            title="Nothing needs review"
            description="Every creative in this page used its template's primary framing rule with no constraint violations."
          />
        </Panel>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {shown.map(creative => (
            <Panel key={creative.id} className="overflow-hidden">
              <Link
                href={`/products/${creative.productId}`}
                className="block bg-[var(--color-canvas)]"
              >
                <img
                  src={creative.url}
                  alt={creative.productName}
                  loading="lazy"
                  className="block h-auto w-full"
                />
              </Link>

              <div className="space-y-1.5 px-2.5 py-2">
                <div className="flex items-start justify-between gap-1.5">
                  <p className="min-w-0 truncate text-xs font-medium">{creative.productName}</p>
                  <span className="flex shrink-0 items-center">
                    <a
                      href={creative.url}
                      download
                      className="p-1 text-[var(--color-ink-subtle)] transition-colors hover:text-[var(--color-ink)]"
                      aria-label="Download"
                    >
                      <Download size={12} />
                    </a>
                    <DeleteButton
                      className="h-6 w-6"
                      confirmLabel="Delete"
                      onDeleted={() => mutate()}
                      onDelete={async () => {
                        const r = await fetch(`/api/creatives/${creative.id}`, { method: 'DELETE' })
                        if (!r.ok) throw new Error('Could not delete this image')
                        return r.json()
                      }}
                    />
                  </span>
                </div>

                <p className="truncate text-[11px] text-[var(--color-ink-subtle)]">
                  {creative.templateName}
                </p>

                <div className="flex flex-wrap items-center gap-1">
                  {creative.usedFallback && <Badge tone="warning">fallback</Badge>}
                  {creative.violations > 0 && (
                    <Badge tone="warning">
                      {creative.violations} constraint{creative.violations === 1 ? '' : 's'}
                    </Badge>
                  )}
                  {!creative.usedFallback && creative.violations === 0 && creative.strategyLabel && (
                    <Badge tone="neutral">{creative.strategyLabel}</Badge>
                  )}
                </div>

                <p className="numeric text-[10px] text-[var(--color-ink-subtle)]">
                  {creative.width}×{creative.height} · {formatBytes(creative.byteSize)} ·{' '}
                  {timeAgo(creative.createdAt)}
                </p>
              </div>
            </Panel>
          ))}
        </div>
      )}

      {data?.hasMore && filter === 'all' && (
        <div className="flex justify-center pt-2">
          <Button variant="outline" onClick={() => setLimit(l => l + PAGE_SIZE)}>
            Load more
          </Button>
        </div>
      )}
    </div>
  )
}
