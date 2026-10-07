/**
 * Event-loop delay monitor (P4) — log-only, no new public endpoint.
 *
 * `perf_hooks.monitorEventLoopDelay()` samples the gap between when a timer
 * SHOULD fire and when it actually does, which is the most direct available
 * signal that something (a long synchronous sharp conversion, a big SQLite
 * query, GC) is blocking the web process from servicing other requests —
 * exactly the class of regression bulk ZIP/upload work could reintroduce
 * without anyone noticing until users report the whole app feeling slow.
 *
 * Logged on a fixed interval, then reset — each logged line describes THAT
 * window, not an ever-growing lifetime aggregate, so a spike shows up and
 * then clears rather than permanently dragging the average.
 *
 * `getEventLoopStats()` is exported for the admin page a later phase adds;
 * nothing in this phase exposes it over HTTP.
 */

import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks'
import { config } from '@/config'

declare global {
  var __visionStudioEventLoopHistogram: IntervalHistogram | undefined
  var __visionStudioEventLoopTimer: NodeJS.Timeout | undefined
}

function nsToMs(ns: number): number {
  return Math.round((ns / 1e6) * 100) / 100
}

export interface EventLoopStats {
  meanMs: number
  p50Ms: number
  p99Ms: number
  maxMs: number
}

/** Current window's stats, as of the last reset — does not force a sample. */
export function getEventLoopStats(): EventLoopStats | null {
  const h = global.__visionStudioEventLoopHistogram
  if (!h) return null
  return {
    meanMs: nsToMs(h.mean),
    p50Ms: nsToMs(h.percentile(50)),
    p99Ms: nsToMs(h.percentile(99)),
    maxMs: nsToMs(h.max),
  }
}

/**
 * Idempotent — safe to call from every module that wants the monitor
 * running, same pattern as `getPool()`'s global singleton guard. Only meant
 * to run in the Node.js web server process; the standalone worker
 * (`runner.ts`) has its own, separate event loop that is not what this
 * phase's "keep the UI responsive" goal is about, but enabling it there too
 * is harmless (negligible overhead, independent histogram).
 */
export function startEventLoopMonitor(): void {
  if (global.__visionStudioEventLoopHistogram) return

  const h = monitorEventLoopDelay({ resolution: 20 })
  h.enable()
  global.__visionStudioEventLoopHistogram = h

  const timer = setInterval(() => {
    const stats = getEventLoopStats()
    h.reset()
    if (!stats) return
    console.log(
      `[event-loop] mean=${stats.meanMs}ms p50=${stats.p50Ms}ms p99=${stats.p99Ms}ms max=${stats.maxMs}ms`
    )
  }, config.observability.eventLoopLogIntervalMs)
  timer.unref?.()
  global.__visionStudioEventLoopTimer = timer
}
