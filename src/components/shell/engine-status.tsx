'use client'

import useSWR from 'swr'
import Link from 'next/link'
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { fetcher } from '@/lib/api'
import { cn } from '@/lib/utils'

interface StatusResponse {
  engine: { ready: boolean; error: string | null; degradations: string[] }
  images: { total: number; pending: number; processing: number; ready: number; failed: number; unavailable: number }
  queue: { vision: { pending: number; running: number }; render: { pending: number; running: number } }
}

export function EngineStatusPill() {
  const { data, error } = useSWR<StatusResponse>('/api/vision/status', fetcher, {
    // Polls faster while work is in flight so the counter feels live, and backs
    // right off when idle — this runs on every page.
    refreshInterval: latest => {
      const busy =
        (latest?.queue.vision.pending ?? 0) +
        (latest?.queue.vision.running ?? 0) +
        (latest?.queue.render.pending ?? 0) +
        (latest?.queue.render.running ?? 0)
      return busy > 0 ? 1500 : 20000
    },
  })

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-[var(--color-danger)]">
        <XCircle size={13} />
        Engine unreachable
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-[var(--color-ink-subtle)]">
        <Loader2 size={13} className="animate-spin" />
        Checking engine
      </div>
    )
  }

  const inFlight =
    data.queue.vision.pending +
    data.queue.vision.running +
    data.queue.render.pending +
    data.queue.render.running

  const degraded = data.engine.ready && data.engine.degradations.length > 0

  return (
    <Link
      href="/settings"
      className="block rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--color-surface-raised)]"
    >
      <div className="flex items-center gap-2 text-[11px]">
        {!data.engine.ready ? (
          <XCircle size={13} className="shrink-0 text-[var(--color-danger)]" />
        ) : degraded ? (
          <AlertTriangle size={13} className="shrink-0 text-[var(--color-warning)]" />
        ) : (
          <CheckCircle2 size={13} className="shrink-0 text-[var(--color-positive)]" />
        )}
        <span
          className={cn(
            'font-medium',
            !data.engine.ready
              ? 'text-[var(--color-danger)]'
              : degraded
                ? 'text-[var(--color-warning)]'
                : 'text-[var(--color-ink-muted)]'
          )}
        >
          {!data.engine.ready ? 'Models missing' : degraded ? 'Reduced capability' : 'Engine ready'}
        </span>
      </div>

      {inFlight > 0 && (
        <p className="numeric mt-1 flex items-center gap-1.5 pl-[21px] text-[11px] text-[var(--color-ink-subtle)]">
          <Loader2 size={11} className="animate-spin" />
          {inFlight} job{inFlight === 1 ? '' : 's'} in flight
        </p>
      )}

      {inFlight === 0 && data.images.total > 0 && (
        <p className="numeric mt-1 pl-[21px] text-[11px] text-[var(--color-ink-subtle)]">
          {data.images.ready} / {data.images.total} analysed
        </p>
      )}
    </Link>
  )
}
