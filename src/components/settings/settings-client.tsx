'use client'

import * as React from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import { CheckCircle2, HardDrive, Loader2, RefreshCw, Trash2, XCircle } from 'lucide-react'
import { fetcher, postJson } from '@/lib/api'
import {
  Alert,
  Badge,
  Button,
  DataList,
  Panel,
  PanelHeader,
  Progress,
  Spinner,
  Stat,
} from '@/components/ui/primitives'
import { formatBytes, humanize } from '@/lib/utils'

interface StatusResponse {
  engine: {
    ready: boolean
    engineVersion: string
    error: string | null
    degradations: string[]
    capabilities: Record<string, boolean>
    modelDir: string
  }
  models: {
    id: string
    file: string
    version: string
    description: string
    required: boolean
    present: boolean
    byteSize: number
    license: string
  }[]
  images: {
    total: number
    pending: number
    processing: number
    ready: number
    failed: number
    unavailable: number
  }
  queue: {
    vision: Record<string, number>
    render: Record<string, number>
  }
  pool: {
    running: boolean
    workers: { id: string; kinds: string[]; state: string }[]
    completed: number
    failed: number
  }
}

export function SettingsClient() {
  const { data, mutate, isLoading } = useSWR<StatusResponse>('/api/vision/status', fetcher, {
    refreshInterval: 4000,
  })
  const [busy, setBusy] = React.useState(false)
  const [sweeping, setSweeping] = React.useState(false)

  const { data: storage, mutate: refreshStorage } = useSWR<{
    usage: Record<string, { files: number; bytes: number }>
    totalBytes: number
    totalFiles: number
    dataDir: string
  }>('/api/storage/sweep', fetcher)

  const sweep = async () => {
    setSweeping(true)
    try {
      const r = await postJson<{
        orphanedCreatives: number
        orphanedOriginals: number
        orphanedDerived: number
        emptyDirectories: number
        freedBytes: number
      }>('/api/storage/sweep', {})
      const total = r.orphanedCreatives + r.orphanedOriginals + r.orphanedDerived
      toast.success(
        total > 0
          ? `Removed ${total} unused file${total === 1 ? '' : 's'} — ${formatBytes(r.freedBytes)} freed`
          : 'Nothing to reclaim — every file is in use'
      )
      refreshStorage()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sweep failed')
    } finally {
      setSweeping(false)
    }
  }

  const reanalyze = async () => {
    setBusy(true)
    try {
      const body = await postJson<{ queued: number }>('/api/vision/reanalyze', {})
      toast.success(
        body.queued > 0 ? `Queued ${body.queued} images` : 'Every image is already analysed'
      )
      mutate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not queue analysis')
    } finally {
      setBusy(false)
    }
  }

  if (isLoading && !data) {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-[var(--color-ink-subtle)]">
        <Spinner /> Loading engine status…
      </div>
    )
  }

  if (!data) return null

  const { engine, models, images, queue, pool } = data
  const coverage = images.total > 0 ? images.ready / images.total : 0
  const outstanding = images.pending + images.processing
  const needsAttention = images.failed + images.unavailable

  return (
    <div className="space-y-4">
      {!engine.ready && (
        <Alert tone="danger" title="Vision analysis cannot run">
          {engine.error}
          <p className="mt-1.5">
            Run <code className="font-mono">npm run models:fetch</code> to download the model
            weights, then re-run analysis below.
          </p>
        </Alert>
      )}

      {engine.ready && engine.degradations.length > 0 && (
        <Alert tone="warning" title="Reduced capability">
          <ul className="list-disc space-y-0.5 pl-4">
            {engine.degradations.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader
            title="Models"
            description={engine.modelDir}
            action={
              engine.ready ? (
                <Badge tone="positive">ready</Badge>
              ) : (
                <Badge tone="danger">not ready</Badge>
              )
            }
          />
          <ul className="divide-y divide-[var(--color-border)]">
            {models.map(model => (
              <li key={model.id} className="flex items-start gap-3 px-4 py-3">
                {model.present ? (
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-[var(--color-positive)]" />
                ) : (
                  <XCircle
                    size={14}
                    className={
                      model.required
                        ? 'mt-0.5 shrink-0 text-[var(--color-danger)]'
                        : 'mt-0.5 shrink-0 text-[var(--color-warning)]'
                    }
                  />
                )}

                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-xs font-medium">{humanize(model.id)}</p>
                    <span className="numeric shrink-0 text-[10px] text-[var(--color-ink-subtle)]">
                      {formatBytes(model.byteSize)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] leading-snug text-[var(--color-ink-subtle)]">
                    {model.description}
                  </p>
                  <p className="mt-1 font-mono text-[10px] text-[var(--color-ink-subtle)]">
                    {model.version}
                  </p>
                  <p className="mt-0.5 text-[10px] text-[var(--color-ink-subtle)]">
                    Licence: {model.license}
                  </p>
                </div>

                {!model.required && <Badge tone="neutral">optional</Badge>}
              </li>
            ))}
          </ul>
        </Panel>

        <div className="space-y-4">
          <Panel>
            <PanelHeader title="Capabilities" />
            <div className="px-4 py-3">
              <DataList
                rows={Object.entries(engine.capabilities).map(([key, enabled]) => ({
                  label: humanize(key.replace(/([A-Z])/g, ' $1').toLowerCase()),
                  value: enabled ? (
                    <span className="text-[var(--color-positive)]">available</span>
                  ) : (
                    <span className="text-[var(--color-ink-subtle)]">unavailable</span>
                  ),
                }))}
              />
              <p className="mt-2 border-t border-[var(--color-border)] pt-2 font-mono text-[10px] leading-relaxed text-[var(--color-ink-subtle)]">
                {engine.engineVersion}
              </p>
            </div>
          </Panel>

          <Panel>
            <PanelHeader
              title="Analysis coverage"
              action={
                needsAttention > 0 || outstanding === 0 ? (
                  <Button size="sm" variant="outline" onClick={reanalyze} disabled={busy}>
                    {busy ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <RefreshCw size={12} />
                    )}
                    Re-analyse pending
                  </Button>
                ) : undefined
              }
            />
            <div className="space-y-3 px-4 py-3">
              <Progress value={coverage} />
              <DataList
                rows={[
                  { label: 'Total images', value: images.total },
                  { label: 'Analysed', value: images.ready },
                  { label: 'Queued', value: images.pending },
                  { label: 'In progress', value: images.processing },
                  { label: 'Failed', value: images.failed },
                  { label: 'Models were missing', value: images.unavailable },
                ]}
              />
            </div>
          </Panel>
        </div>
      </div>

      <Panel>
        <PanelHeader
          title={
            <span className="flex items-center gap-1.5">
              <HardDrive size={13} /> Storage
            </span>
          }
          description={storage?.dataDir}
          action={
            <Button size="sm" variant="outline" onClick={sweep} disabled={sweeping}>
              {sweeping ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
              Reclaim unused space
            </Button>
          }
        />
        <div className="px-4 py-3">
          <DataList
            rows={[
              ...Object.entries(storage?.usage ?? {}).map(([root, u]) => ({
                label: `${humanize(root)} (${u.files} file${u.files === 1 ? '' : 's'})`,
                value: formatBytes(u.bytes),
              })),
              { label: 'Total', value: formatBytes(storage?.totalBytes ?? 0) },
            ]}
          />
          <p className="mt-2 border-t border-[var(--color-border)] pt-2 text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
            Reclaiming deletes only files that no product or generated image
            references — leftovers from interrupted imports or removed data. Nothing
            reachable in the app is touched.
          </p>
        </div>
      </Panel>

      <Panel>
        <PanelHeader
          title="Workers"
          description={
            pool.running
              ? 'The pool starts on demand and drains the queue.'
              : 'Idle. The pool starts automatically when work is enqueued.'
          }
          action={<Badge tone={pool.running ? 'accent' : 'neutral'}>{pool.running ? 'running' : 'idle'}</Badge>}
        />

        <div className="grid grid-cols-2 gap-3 px-4 py-4 sm:grid-cols-4">
          <Stat label="Vision queued" value={queue.vision.pending ?? 0} />
          <Stat label="Vision running" value={queue.vision.running ?? 0} />
          <Stat label="Render queued" value={queue.render.pending ?? 0} />
          <Stat
            label="Render failed"
            value={queue.render.failed ?? 0}
            tone={(queue.render.failed ?? 0) > 0 ? 'danger' : 'default'}
          />
        </div>

        {pool.workers.length > 0 && (
          <div className="flex flex-wrap gap-1.5 border-t border-[var(--color-border)] px-4 py-3">
            {pool.workers.map(worker => (
              <Badge
                key={worker.id}
                tone={
                  worker.state === 'busy'
                    ? 'accent'
                    : worker.state === 'stopped'
                      ? 'danger'
                      : 'neutral'
                }
              >
                {worker.id} · {worker.state}
              </Badge>
            ))}
          </div>
        )}
      </Panel>
    </div>
  )
}
