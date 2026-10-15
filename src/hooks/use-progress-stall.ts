'use client'

import * as React from 'react'

/**
 * Phase 1.5 (docs/ISSUES.md issue 10): tracks how long a monotonically
 * increasing "progress signal" (e.g. a batch's completed+failed+cancelled
 * job count) has gone unchanged — the frontend half of "stalled, no
 * progress for N minutes".
 *
 * Deliberately NOT based on the polled resource's own `updatedAt`:
 * `batches.refresh()` (src/db/repositories.ts) stamps `updated_at` on
 * EVERY poll regardless of whether the counts actually moved (see
 * `getBatchProgress()` in generation-service.ts), so that timestamp alone
 * can't tell a genuinely stalled batch from one simply being polled.
 *
 * `Date.now()` is read only inside effects/timer callbacks, never during
 * render (an impure call during render is not idempotent) — the refs start
 * `null` and are given a real timestamp the first time an effect runs.
 * Recomputes on a 5s ticker so the UI counts up live between polls rather
 * than jumping once per refresh; setState happens only inside the
 * interval's own callback, never synchronously in an effect body.
 */
export function useProgressStall(progress: number, active: boolean): number {
  const sinceRef = React.useRef<number | null>(null)
  const prevProgressRef = React.useRef(progress)
  const [stalledMs, setStalledMs] = React.useState(0)

  React.useEffect(() => {
    if (sinceRef.current === null || progress !== prevProgressRef.current) {
      prevProgressRef.current = progress
      sinceRef.current = Date.now()
    }
  }, [progress])

  React.useEffect(() => {
    if (!active) return
    const timer = setInterval(() => {
      setStalledMs(Date.now() - (sinceRef.current ?? Date.now()))
    }, 5000)
    return () => clearInterval(timer)
  }, [active, progress])

  return active ? stalledMs : 0
}
