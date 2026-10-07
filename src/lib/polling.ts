/**
 * Shared helper for every SWR `refreshInterval` callback in this app.
 *
 * Pause-when-hidden and error backoff are already SWR defaults
 * (`refreshWhenHidden: false`, `onErrorRetry`'s built-in exponential
 * backoff-with-jitter) — neither needs custom code here, just not being
 * overridden at any call site. What SWR does NOT jitter on its own is the
 * steady-state polling cadence itself: every client computing the exact same
 * `refreshInterval` would otherwise drift into sync (worst case, many
 * browser tabs opened around the same moment polling in lockstep), which is
 * exactly the kind of synchronized-herd load pattern that turns "20 clients
 * polling" into a correlated spike instead of a smooth, spread-out one.
 *
 * `refreshInterval` is a function SWR re-invokes before scheduling EACH
 * poll, so wrapping the returned delay here re-randomizes it every time,
 * not just once at mount.
 */
export function jitterMs(baseMs: number, spread = 0.2): number {
  return Math.round(baseMs * (1 + (Math.random() * 2 - 1) * spread))
}
