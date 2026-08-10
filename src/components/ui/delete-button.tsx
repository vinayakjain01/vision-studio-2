/**
 * Delete control with inline confirmation.
 *
 * Confirmation happens in place — the button turns into "Delete?" / "Cancel" —
 * rather than through `window.confirm`. A native dialog gives no room to say
 * what will actually be removed, and these deletions cascade: an import takes
 * its products, images and generated pictures with it. `confirmLabel` carries
 * that consequence, and it is spelled out before the click, not after.
 *
 * Reports what was reclaimed on success, because a delete that frees no space is
 * the failure mode worth noticing on a catalog measured in gigabytes.
 */

'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Check, Loader2, Trash2, X } from 'lucide-react'
import { formatBytes } from '@/lib/utils'
import { cn } from '@/lib/utils'

export interface DeleteResultShape {
  removed?: { products?: number; images?: number; creatives?: number; batches?: number }
  filesDeleted?: number
  freedBytes?: number
  sharedFilesKept?: number
}

export function DeleteButton({
  onDelete,
  confirmLabel,
  successLabel = 'Deleted',
  size = 'icon',
  className,
  onDeleted,
}: {
  /** Performs the deletion. Resolve with the server's result to report space freed. */
  onDelete: () => Promise<DeleteResultShape | void>
  /** What will be removed, shown while confirming. Be specific. */
  confirmLabel: string
  successLabel?: string
  size?: 'icon' | 'sm'
  className?: string
  onDeleted?: () => void
}) {
  const [confirming, setConfirming] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  // Abandon the confirmation if the user's attention moves on, so a primed
  // delete button is never left sitting there to be hit by accident.
  React.useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), 6000)
    return () => clearTimeout(timer)
  }, [confirming])

  const run = async () => {
    setBusy(true)
    try {
      const result = (await onDelete()) ?? {}
      const freed = result.freedBytes ?? 0
      const kept = result.sharedFilesKept ?? 0

      toast.success(
        freed > 0 ? `${successLabel} — ${formatBytes(freed)} freed` : successLabel,
        {
          description:
            kept > 0
              ? `${kept} photo${kept === 1 ? '' : 's'} kept: still used by another product.`
              : undefined,
        }
      )
      onDeleted?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  if (busy) {
    return (
      <span className="inline-flex h-7 items-center gap-1.5 px-2 text-[11px] text-[var(--color-ink-subtle)]">
        <Loader2 size={12} className="animate-spin" /> Deleting…
      </span>
    )
  }

  if (confirming) {
    return (
      <span className="inline-flex items-center gap-1">
        <button
          onClick={run}
          className="inline-flex h-7 items-center gap-1 rounded-md bg-[var(--color-danger)] px-2 text-[11px] font-medium text-white transition-[filter] hover:brightness-110"
        >
          <Check size={12} /> {confirmLabel}
        </button>
        <button
          onClick={() => setConfirming(false)}
          className="inline-flex h-7 items-center rounded-md px-1.5 text-[var(--color-ink-subtle)] transition-colors hover:text-[var(--color-ink)]"
          aria-label="Cancel"
        >
          <X size={13} />
        </button>
      </span>
    )
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      className={cn(
        'inline-flex items-center justify-center rounded-md text-[var(--color-ink-subtle)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-danger)]',
        size === 'icon' ? 'h-7 w-7' : 'h-7 gap-1.5 px-2 text-[11px]',
        className
      )}
      aria-label="Delete"
      title="Delete"
    >
      <Trash2 size={13} />
      {size === 'sm' && 'Delete'}
    </button>
  )
}
