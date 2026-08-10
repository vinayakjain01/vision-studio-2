/**
 * Folder import UI.
 *
 * Uses the directory picker (`webkitdirectory`), which hands over the entire
 * tree including nested folders. Files are classified in the browser with the
 * SAME predicates the server validates against (`@/import/file-rules`), so the
 * preview an operator approves is exactly what will be accepted.
 *
 * ── Batched upload ───────────────────────────────────────────────────────────
 * Files go up in size-bounded batches rather than one request or one-per-file.
 * A single request would exceed every body limit on a real catalog; one request
 * per file makes a 4,000-image import 4,000 round trips. Batching by accumulated
 * bytes keeps each request bounded regardless of whether the folder holds 200 KB
 * JPEGs or 40 MB TIFFs.
 *
 * Originals are uploaded untouched — no client-side downscaling or re-encoding.
 * Vision precision depends on full-resolution pixels, and re-encoding would
 * change the content hash that deduplication and analysis reuse depend on.
 */

'use client'

import * as React from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { toast } from 'sonner'
import { AlertTriangle, CheckCircle2, FolderUp, Loader2, RefreshCw, X } from 'lucide-react'
import {
  ACCEPT_ATTRIBUTE,
  MAX_REQUEST_BYTES,
  classifyFile,
  groupIntoProducts,
  normalizePath,
  type SkipReason,
} from '@/import/file-rules'
import { fetcher, postJson, patchJson } from '@/lib/api'
import { DeleteButton } from '@/components/ui/delete-button'
import { formatBytes, timeAgo } from '@/lib/utils'
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Panel,
  PanelHeader,
  Progress,
  Stat,
} from '@/components/ui/primitives'
import type { ImportRecord } from '@/db/types'

interface PickedFile {
  file: File
  relativePath: string
}

interface Scan {
  rootName: string
  accepted: PickedFile[]
  skipped: { relativePath: string; reason: SkipReason }[]
  productCount: number
  totalBytes: number
}

const SKIP_LABELS: Record<SkipReason, string> = {
  system_file: 'system or hidden file',
  unsupported_type: 'unsupported file type',
  too_large: 'file too large',
  empty: 'empty file',
}

export function ImportClient({ recentImports }: { recentImports: ImportRecord[] }) {
  // Server-rendered list is the initial value; SWR keeps it current after an
  // upload or a delete without a full page reload.
  const { data: importList, mutate: refreshImports } = useSWR<{ imports: ImportRecord[] }>(
    '/api/imports',
    fetcher,
    { fallbackData: { imports: recentImports } }
  )
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [scan, setScan] = React.useState<Scan | null>(null)
  const [uploading, setUploading] = React.useState(false)
  const [progress, setProgress] = React.useState({ done: 0, total: 0, bytes: 0 })
  const [result, setResult] = React.useState<{
    importId: string
    imported: number
    duplicates: number
    failed: number
  } | null>(null)

  const { data: status } = useSWR<{
    engine: { ready: boolean; degradations: string[]; error: string | null }
  }>('/api/vision/status', fetcher)

  const handlePick = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    if (files.length === 0) return

    const accepted: PickedFile[] = []
    const skipped: { relativePath: string; reason: SkipReason }[] = []
    let totalBytes = 0

    for (const file of files) {
      // `webkitRelativePath` carries the full path inside the picked directory.
      const relativePath = normalizePath((file as any).webkitRelativePath || file.name)
      const classification = classifyFile({
        relativePath,
        name: file.name,
        mimeType: file.type,
        size: file.size,
      })

      if (classification.accepted) {
        accepted.push({ file, relativePath })
        totalBytes += file.size
      } else {
        skipped.push({ relativePath, reason: classification.reason! })
      }
    }

    const rootName =
      normalizePath((files[0] as any).webkitRelativePath || '').split('/')[0] || 'Imported folder'

    // Same grouping the server will apply, so the product count shown is real.
    const grouped = groupIntoProducts(
      accepted.map(a => ({ relativePath: a.relativePath, name: a.file.name }))
    )
    const productCount = new Set(grouped.map(g => `${g.folderPath}::${g.productSlug}`)).size

    setScan({ rootName, accepted, skipped, productCount, totalBytes })
    setResult(null)
  }

  const reset = () => {
    setScan(null)
    setResult(null)
    setProgress({ done: 0, total: 0, bytes: 0 })
    if (inputRef.current) inputRef.current.value = ''
  }

  const startImport = async () => {
    if (!scan || scan.accepted.length === 0) return

    setUploading(true)
    setProgress({ done: 0, total: scan.accepted.length, bytes: 0 })

    try {
      const { import: created } = await postJson<{ import: ImportRecord }>('/api/imports', {
        name: scan.rootName,
        totalFiles: scan.accepted.length,
      })

      let imported = 0
      let duplicates = 0
      let failed = 0
      let done = 0
      let bytesSent = 0

      for (const batch of batchBySize(scan.accepted, MAX_REQUEST_BYTES)) {
        const form = new FormData()
        for (const item of batch) {
          form.append('files', item.file, item.file.name)
          form.append('paths', item.relativePath)
        }

        const response = await fetch(`/api/imports/${created.id}/files`, {
          method: 'POST',
          body: form,
        })

        if (!response.ok) {
          // One rejected batch must not abandon the rest of the import — the
          // remaining files are independent.
          failed += batch.length
          const body = await response.json().catch(() => null)
          toast.error(body?.error ?? `A batch of ${batch.length} files failed to upload`)
        } else {
          const body = await response.json()
          imported += body.summary.imported
          duplicates += body.summary.duplicates
          failed += body.summary.failed
        }

        done += batch.length
        bytesSent += batch.reduce((sum, item) => sum + item.file.size, 0)
        setProgress({ done, total: scan.accepted.length, bytes: bytesSent })
      }

      await patchJson(`/api/imports/${created.id}`, { action: 'finalize' })

      setResult({ importId: created.id, imported, duplicates, failed })
      toast.success(`Imported ${imported} image${imported === 1 ? '' : 's'}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setUploading(false)
    }
  }

  const skipCounts = React.useMemo(() => {
    const counts = new Map<SkipReason, number>()
    for (const entry of scan?.skipped ?? []) {
      counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1)
    }
    return [...counts.entries()]
  }, [scan])

  return (
    <div className="space-y-5">
      {status && !status.engine.ready && (
        <Alert tone="danger" title="Vision models are not installed">
          {status.engine.error ?? 'Run `npm run models:fetch` to download them.'} Files will still
          import, but analysis is deferred until the models are present — re-run analysis from the
          import row afterwards.
        </Alert>
      )}

      {status?.engine.ready && status.engine.degradations.length > 0 && (
        <Alert tone="warning" title="Running with reduced capability">
          <ul className="list-disc space-y-0.5 pl-4">
            {status.engine.degradations.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </Alert>
      )}

      {/* Picker */}
      {!scan && (
        <Panel>
          <EmptyState
            icon={<FolderUp size={26} />}
            title="Choose a folder"
            description="Nested folders are walked recursively. Each folder becomes a product and the images inside it become that product's shots, ordered naturally so look-2 comes before look-10."
            action={
              <Button variant="primary" onClick={() => inputRef.current?.click()}>
                <FolderUp size={14} /> Select folder
              </Button>
            }
          />
        </Panel>
      )}

      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT_ATTRIBUTE}
        className="hidden"
        onChange={handlePick}
        // Non-standard but universally supported; this is what enables picking
        // a directory rather than individual files.
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
      />

      {/* Scan summary */}
      {scan && !result && (
        <Panel>
          <PanelHeader
            title={scan.rootName}
            description={`${scan.accepted.length} images · ${scan.productCount} products · ${formatBytes(scan.totalBytes)}`}
            action={
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={reset} disabled={uploading}>
                  <X size={13} /> Clear
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={startImport}
                  disabled={uploading || scan.accepted.length === 0}
                >
                  {uploading ? <Loader2 size={13} className="animate-spin" /> : <FolderUp size={13} />}
                  {uploading ? 'Importing…' : `Import ${scan.accepted.length} images`}
                </Button>
              </div>
            }
          />

          <div className="space-y-4 px-4 py-4">
            {uploading && (
              <div className="space-y-1.5">
                <Progress value={progress.total > 0 ? progress.done / progress.total : 0} />
                <p className="numeric text-[11px] text-[var(--color-ink-subtle)]">
                  {progress.done} / {progress.total} files · {formatBytes(progress.bytes)} sent
                </p>
              </div>
            )}

            {skipCounts.length > 0 && (
              <Alert tone="neutral" title={`${scan.skipped.length} files will be skipped`}>
                <ul className="space-y-0.5">
                  {skipCounts.map(([reason, count]) => (
                    <li key={reason}>
                      {count} × {SKIP_LABELS[reason]}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}

            <ProductPreview scan={scan} />
          </div>
        </Panel>
      )}

      {/* Result */}
      {result && (
        <Panel>
          <PanelHeader
            title="Import complete"
            action={
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={reset}>
                  Import another
                </Button>
                <Link
                  href="/products"
                  className="inline-flex h-7 items-center rounded-md bg-[var(--color-accent)] px-2.5 text-xs font-medium text-[var(--color-accent-ink)]"
                >
                  View products
                </Link>
              </div>
            }
          />
          <div className="grid grid-cols-3 gap-3 px-4 py-4">
            <Stat label="Imported" value={result.imported} tone="positive" />
            <Stat
              label="Duplicates"
              value={result.duplicates}
              hint="identical bytes already present"
            />
            <Stat
              label="Failed"
              value={result.failed}
              tone={result.failed > 0 ? 'danger' : 'default'}
            />
          </div>
          <div className="px-4 pb-4">
            <Alert tone="neutral">
              Vision analysis is running in the background. Framing controls and rules that depend
              on shot type become available as images finish.
            </Alert>
          </div>
        </Panel>
      )}

      {/* History */}
      {(importList?.imports.length ?? 0) > 0 && (
        <Panel>
          <PanelHeader
            title="Imported folders"
            description="Deleting a folder removes its products, photos and generated images, and frees the disk space."
          />
          <ul className="divide-y divide-[var(--color-border)]">
            {importList!.imports.map(record => (
              <ImportRow key={record.id} record={record} onDeleted={() => refreshImports()} />
            ))}
          </ul>
        </Panel>
      )}
    </div>
  )
}

/** First few products, so the operator can confirm the grouping is what they meant. */
function ProductPreview({ scan }: { scan: Scan }) {
  const grouped = React.useMemo(
    () =>
      groupIntoProducts(scan.accepted.map(a => ({ relativePath: a.relativePath, name: a.file.name }))),
    [scan]
  )

  const byProduct = React.useMemo(() => {
    const map = new Map<string, { name: string; folder: string; category: string | null; files: string[] }>()
    for (const item of grouped) {
      const key = `${item.folderPath}::${item.productSlug}`
      const existing = map.get(key)
      if (existing) existing.files.push(item.name)
      else
        map.set(key, {
          name: item.productName,
          folder: item.folderPath,
          category: item.category,
          files: [item.name],
        })
    }
    return [...map.values()]
  }, [grouped])

  const shown = byProduct.slice(0, 8)

  return (
    <div>
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-subtle)]">
        Products that will be created
      </p>
      <ul className="divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
        {shown.map((product, index) => (
          <li key={index} className="flex items-center justify-between gap-3 px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium">{product.name}</p>
              <p className="truncate text-[11px] text-[var(--color-ink-subtle)]">
                {product.folder || 'root'}
                {product.category && ` · ${product.category}`}
              </p>
            </div>
            <Badge>{product.files.length} shot{product.files.length === 1 ? '' : 's'}</Badge>
          </li>
        ))}
      </ul>
      {byProduct.length > shown.length && (
        <p className="mt-1.5 text-[11px] text-[var(--color-ink-subtle)]">
          and {byProduct.length - shown.length} more
        </p>
      )}
    </div>
  )
}

function ImportRow({ record, onDeleted }: { record: ImportRecord; onDeleted: () => void }) {
  const [busy, setBusy] = React.useState(false)

  const { data } = useSWR<{
    import: ImportRecord
    imageCount: number
    vision: { pending: number; processing: number; ready: number; failed: number; unavailable: number }
  }>(`/api/imports/${record.id}`, fetcher, {
    refreshInterval: latest => {
      const outstanding = (latest?.vision.pending ?? 0) + (latest?.vision.processing ?? 0)
      return outstanding > 0 ? 2000 : 0
    },
  })

  const vision = data?.vision
  const outstanding = (vision?.pending ?? 0) + (vision?.processing ?? 0)
  const needsAttention = (vision?.unavailable ?? 0) + (vision?.failed ?? 0)
  const total = data?.imageCount ?? 0

  const reanalyze = async () => {
    setBusy(true)
    try {
      const body = await patchJson<{ queued: number }>(`/api/imports/${record.id}`, {
        action: 'reanalyze',
      })
      toast.success(
        body.queued > 0 ? `Queued ${body.queued} images for analysis` : 'Nothing needed re-analysis'
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not queue analysis')
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="flex items-center justify-between gap-3 px-4 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-xs font-medium">{record.name}</p>
        <p className="numeric mt-0.5 text-[11px] text-[var(--color-ink-subtle)]">
          {total} images · {timeAgo(record.createdAt)}
          {vision && outstanding > 0 && ` · ${outstanding} analysing`}
          {vision && needsAttention > 0 && ` · ${needsAttention} need attention`}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {outstanding > 0 ? (
          <Badge tone="accent">
            <Loader2 size={10} className="animate-spin" /> analysing
          </Badge>
        ) : needsAttention > 0 ? (
          <Badge tone="warning">
            <AlertTriangle size={10} /> {needsAttention}
          </Badge>
        ) : total > 0 ? (
          <Badge tone="positive">
            <CheckCircle2 size={10} /> analysed
          </Badge>
        ) : null}

        {needsAttention > 0 && (
          <Button size="sm" variant="ghost" onClick={reanalyze} disabled={busy}>
            {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            Re-analyse
          </Button>
        )}

        <DeleteButton
          confirmLabel={`Delete ${total} photo${total === 1 ? '' : 's'}`}
          successLabel={`Deleted "${record.name}"`}
          onDeleted={onDeleted}
          onDelete={async () => {
            const r = await fetch(`/api/imports/${record.id}`, { method: 'DELETE' })
            if (!r.ok) throw new Error('Could not delete this import')
            return r.json()
          }}
        />
      </div>
    </li>
  )
}

/**
 * Split files into batches bounded by accumulated bytes.
 *
 * Bounding by count instead would send 50 × 40 MB TIFFs in one request on a
 * high-resolution catalog and 50 × 200 KB JPEGs on a web-ready one — the first
 * exceeds every body limit, the second wastes round trips. A file larger than
 * the budget goes alone rather than being dropped.
 */
function* batchBySize<T extends { file: File }>(items: T[], maxBytes: number): Generator<T[]> {
  let batch: T[] = []
  let bytes = 0

  for (const item of items) {
    if (batch.length > 0 && bytes + item.file.size > maxBytes) {
      yield batch
      batch = []
      bytes = 0
    }
    batch.push(item)
    bytes += item.file.size
  }

  if (batch.length > 0) yield batch
}
