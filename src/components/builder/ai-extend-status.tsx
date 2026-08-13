'use client'

/**
 * Whether AI Extend can actually run, shown wherever it can be selected.
 *
 * Two things worth surfacing at the point of the decision rather than after
 * a batch fails: whether Cloudinary is configured at all, and — since every
 * generative fill is billed — that the feature costs credits per new photo.
 */

import useSWR from 'swr'
import { CheckCircle2, Loader2, TriangleAlert } from 'lucide-react'
import { fetcher } from '@/lib/api'

interface Status {
  configured: boolean
  cloudName: string | null
}

export function AiExtendStatus() {
  const { data, isLoading } = useSWR<Status>('/api/ai-extend/status', fetcher, {
    revalidateOnFocus: true,
  })

  if (isLoading || !data) {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-[var(--color-ink-subtle)]">
        <Loader2 size={11} className="animate-spin" />
        Checking Cloudinary…
      </p>
    )
  }

  if (!data.configured) {
    return (
      <div className="space-y-1 rounded-md border border-[color-mix(in_oklch,var(--color-warning)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-warning)_8%,transparent)] px-2.5 py-2">
        <p className="flex items-start gap-1.5 text-[11px] font-medium leading-snug text-[var(--color-warning)]">
          <TriangleAlert size={12} className="mt-0.5 shrink-0" />
          Cloudinary not configured
        </p>
        <p className="text-[11px] leading-snug text-[var(--color-ink-muted)]">
          Set <code className="font-mono text-[10px]">CLOUDINARY_CLOUD_NAME</code>,{' '}
          <code className="font-mono text-[10px]">CLOUDINARY_API_KEY</code> and{' '}
          <code className="font-mono text-[10px]">CLOUDINARY_API_SECRET</code> in{' '}
          <code className="font-mono text-[10px]">.env.local</code>. You can still save this
          template, but generating with AI Extend will fail until they are set.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2.5 py-2">
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-accent)]">
        <CheckCircle2 size={12} className="shrink-0" />
        Cloudinary connected
        {data.cloudName && (
          <span className="font-mono text-[10px] text-[var(--color-ink-subtle)]">
            {data.cloudName}
          </span>
        )}
      </p>
      <p className="text-[11px] leading-snug text-[var(--color-ink-muted)]">
        Each new photo costs one generative credit. Results are cached, so re-rendering the
        same photo with the same settings is free.
      </p>
    </div>
  )
}
