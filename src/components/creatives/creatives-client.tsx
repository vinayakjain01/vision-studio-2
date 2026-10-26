'use client'

import * as React from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { Download, Sparkles } from 'lucide-react'
import { fetcher } from '@/lib/api'
import { DeleteButton } from '@/components/ui/delete-button'
import { Badge, Button, EmptyState, Panel, Select, Tabs } from '@/components/ui/primitives'
import { formatBytes, timeAgo } from '@/lib/utils'
import type { ImportRecord } from '@/db/types'
import {
  DEFAULT_EXPORT_SETTINGS,
  ExportOptionsFields,
  exportQueryString,
  type ExportSettings,
} from './export-options'

interface Creative {
  id: string
  productId: string
  productName: string
  /** The sub-folder this creative's product was imported under — "" at an import's own root. */
  folderPath: string
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
  const [importId, setImportId] = React.useState('')
  const [exportSettings, setExportSettings] = React.useState<ExportSettings>(DEFAULT_EXPORT_SETTINGS)
  const exportSuffix = exportQueryString(exportSettings)

  const { data: importsData } = useSWR<{ imports: ImportRecord[] }>('/api/imports', fetcher)
  const imports = importsData?.imports ?? []

  // A master folder selected: every creative in it, grouped by sub-folder
  // below — no offset paging, the whole point is seeing (and downloading)
  // the complete folder. No folder selected: the existing flat, paginated
  // "everything" view, unchanged.
  const { data, isLoading, mutate } = useSWR<{ creatives: Creative[]; total: number; hasMore: boolean }>(
    importId ? `/api/creatives?importId=${importId}` : `/api/creatives?limit=${limit}`,
    fetcher,
    { keepPreviousData: true }
  )

  const all = data?.creatives ?? []
  // "Needs review" is the practically useful filter on a bulk run: these are
  // the creatives where the template's primary rule did not apply cleanly.
  const review = all.filter(c => c.usedFallback || c.violations > 0)
  const shown = filter === 'review' ? review : all

  // Sub-folder sections, in first-seen order — matches how the Products page
  // itself groups a master folder's contents, so a master-folder download's
  // structure (master folder / sub folder / original file name) is exactly
  // what the operator already saw grouped on screen before downloading it.
  const groups = React.useMemo(() => {
    if (!importId) return null
    const byFolder = new Map<string, Creative[]>()
    for (const creative of shown) {
      const key = creative.folderPath || '(root)'
      const list = byFolder.get(key)
      if (list) list.push(creative)
      else byFolder.set(key, [creative])
    }
    return [...byFolder.entries()]
  }, [importId, shown])

  // Download href for whichever scope is active: a selected master folder
  // (master-folder/sub-folder/original-file-name, see
  // src/app/api/creatives/download/route.ts's `?importId=` mode) or, with
  // none selected, the existing "every creative" download — unchanged.
  const downloadParams = new URLSearchParams()
  if (importId) downloadParams.set('importId', importId)
  const exportParams = new URLSearchParams(exportSuffix.replace(/^\?/, ''))
  for (const [key, value] of exportParams) downloadParams.set(key, value)
  const downloadHref = `/api/creatives/download?${downloadParams}`
  const selectedImportName = imports.find(i => i.id === importId)?.name

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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Tabs
            value={filter}
            onChange={setFilter}
            tabs={[
              { value: 'all', label: 'All', count: data?.total },
              { value: 'review', label: 'Needs review', count: review.length },
            ]}
          />

          {imports.length >= 2 && (
            <Select
              aria-label="Master folder"
              value={importId}
              onChange={event => setImportId(event.target.value)}
              className="w-52"
            >
              <option value="">All master folders</option>
              {imports.map(importRecord => (
                <option key={importRecord.id} value={importRecord.id}>
                  {importRecord.name}
                </option>
              ))}
            </Select>
          )}
        </div>

        <div className="flex items-center gap-3">
          {data && (
            <span className="numeric text-xs text-[var(--color-ink-subtle)]">
              {data.total} image{data.total === 1 ? '' : 's'}
            </span>
          )}
          <ExportOptionsFields settings={exportSettings} onChange={setExportSettings} />
          {/* A plain anchor, not a fetch and not next/link: the browser streams
              the ZIP straight to disk with its own progress UI, and nothing is
              held in page memory. `next/link` would client-side navigate to a
              route handler, which downloads nothing. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a
            href={downloadHref}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-[var(--color-accent)] px-3.5 text-sm font-medium text-[var(--color-accent-ink)] transition-[filter] hover:brightness-110"
          >
            <Download size={14} />
            {selectedImportName ? `Download "${selectedImportName}"` : 'Download all'}
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
      ) : groups ? (
        // A master folder is selected: one card per sub-folder, matching the
        // Products page's own folder-card grid — not every individual image
        // unfolded. Each card downloads exactly that sub-folder (the same
        // `?productId=` structure `?importId=` downloads as a whole), and
        // opens onto the product's own detail page to review the individual
        // renders.
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {groups.map(([folder, creativesInFolder]) => (
            <FolderCard key={folder} folder={folder} creatives={creativesInFolder} exportSuffix={exportSuffix} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {shown.map(creative => (
            <CreativeCard
              key={creative.id}
              creative={creative}
              exportSuffix={exportSuffix}
              onDeleted={() => mutate()}
            />
          ))}
        </div>
      )}

      {!importId && data?.hasMore && filter === 'all' && (
        <div className="flex justify-center pt-2">
          <Button variant="outline" onClick={() => setLimit(l => l + PAGE_SIZE)}>
            Load more
          </Button>
        </div>
      )}
    </div>
  )
}

function FolderCard({
  folder,
  creatives,
  exportSuffix,
}: {
  folder: string
  creatives: Creative[]
  exportSuffix: string
}) {
  const cover = creatives[0]
  const needsReview = creatives.some(c => c.usedFallback || c.violations > 0)

  const downloadParams = new URLSearchParams({ productId: cover.productId })
  const exportParams = new URLSearchParams(exportSuffix.replace(/^\?/, ''))
  for (const [key, value] of exportParams) downloadParams.set(key, value)

  return (
    <div className="panel group relative overflow-hidden transition-colors hover:border-[var(--color-border-strong)]">
      {/* Outside the link: a nested control inside an anchor swallows its own clicks. */}
      <div className="absolute right-1.5 top-1.5 z-10 rounded-md bg-black/65 opacity-0 backdrop-blur transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <a
          href={`/api/creatives/download?${downloadParams}`}
          className="flex h-7 w-7 items-center justify-center text-white transition-colors hover:text-[var(--color-accent)]"
          aria-label={`Download "${cover.productName}"`}
        >
          <Download size={13} />
        </a>
      </div>

      <Link href={`/products/${cover.productId}`} className="block">
        <div className="relative aspect-[3/4] overflow-hidden bg-[var(--color-canvas)]">
          <img
            src={cover.url}
            alt={cover.productName}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />

          <span className="numeric absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium">
            {creatives.length}
          </span>
        </div>

        <div className="space-y-1.5 px-2.5 py-2">
          <p className="truncate text-xs font-medium leading-tight">{cover.productName}</p>
          <p className="truncate text-[11px] text-[var(--color-ink-subtle)]">{folder}</p>

          {needsReview && (
            <div className="flex flex-wrap items-center gap-1">
              <Badge tone="warning">needs review</Badge>
            </div>
          )}
        </div>
      </Link>
    </div>
  )
}

function CreativeCard({
  creative,
  exportSuffix,
  onDeleted,
}: {
  creative: Creative
  exportSuffix: string
  onDeleted: () => void
}) {
  return (
    <Panel className="overflow-hidden">
      <Link href={`/products/${creative.productId}`} className="block bg-[var(--color-canvas)]">
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
              href={`/api/creatives/${creative.id}/export${exportSuffix}`}
              download
              className="p-1 text-[var(--color-ink-subtle)] transition-colors hover:text-[var(--color-ink)]"
              aria-label="Download"
            >
              <Download size={12} />
            </a>
            <DeleteButton
              className="h-6 w-6"
              confirmLabel="Delete"
              onDeleted={onDeleted}
              onDelete={async () => {
                const r = await fetch(`/api/creatives/${creative.id}`, { method: 'DELETE' })
                if (!r.ok) throw new Error('Could not delete this image')
                return r.json()
              }}
            />
          </span>
        </div>

        <p className="truncate text-[11px] text-[var(--color-ink-subtle)]">{creative.templateName}</p>

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
          {creative.width}×{creative.height} · {formatBytes(creative.byteSize)} · {timeAgo(creative.createdAt)}
        </p>
      </div>
    </Panel>
  )
}
