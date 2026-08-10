'use client'

/**
 * Live reachability of the AI Extend inpaint service.
 *
 * Shown wherever `ai_extend` can be chosen, because that choice is the one
 * setting in this builder whose success depends on a process running
 * somewhere else. Everything else here is local and either works or is
 * visibly wrong immediately; this one looks completely fine until a batch
 * fails. Surfacing it at the point of decision is the whole point.
 */

import useSWR from 'swr'
import { CheckCircle2, Loader2, TriangleAlert } from 'lucide-react'
import { fetcher } from '@/lib/api'

interface Health {
  reachable: boolean
  device?: 'cpu' | 'cuda'
  modelLoaded?: boolean
  serviceUrl: string
  configuredDevice: 'cpu' | 'cuda'
}

export function InpaintStatus() {
  const { data, isLoading } = useSWR<Health>('/api/inpaint/health', fetcher, {
    // The answer changes when someone starts or stops a service by hand, not
    // on a timer — but a template author who just started it should not have
    // to reload the page to find out.
    refreshInterval: 15_000,
    revalidateOnFocus: true,
  })

  if (isLoading || !data) {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-[var(--color-ink-subtle)]">
        <Loader2 size={11} className="animate-spin" />
        Checking inpaint service…
      </p>
    )
  }

  if (!data.reachable) {
    return (
      <div className="space-y-1 rounded-md border border-[color-mix(in_oklch,var(--color-warning)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-warning)_8%,transparent)] px-2.5 py-2">
        <p className="flex items-start gap-1.5 text-[11px] font-medium leading-snug text-[var(--color-warning)]">
          <TriangleAlert size={12} className="mt-0.5 shrink-0" />
          Inpaint service unreachable
        </p>
        <p className="text-[11px] leading-snug text-[var(--color-ink-muted)]">
          Nothing is answering at{' '}
          <code className="font-mono text-[10px]">{data.serviceUrl}</code>. You can still
          save this template, but generating with AI Extend will fail until the service is
          running — see <code className="font-mono text-[10px]">docs/DEPLOY.md</code>.
        </p>
      </div>
    )
  }

  const cpuMode = data.device === 'cpu'

  return (
    <div className="space-y-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2.5 py-2">
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-positive,var(--color-accent))]">
        <CheckCircle2 size={12} className="shrink-0" />
        Inpaint service ready
        {data.device && (
          <span className="font-mono text-[10px] uppercase text-[var(--color-ink-subtle)]">
            {data.device}
          </span>
        )}
      </p>
      {cpuMode && (
        <p className="text-[11px] leading-snug text-[var(--color-ink-muted)]">
          Running on CPU — minutes per image. Fine for checking quality on a few photos,
          not for a real batch.
        </p>
      )}
      {!data.modelLoaded && (
        <p className="text-[11px] leading-snug text-[var(--color-ink-muted)]">
          Model still loading; the first generation will wait for it.
        </p>
      )}
    </div>
  )
}
