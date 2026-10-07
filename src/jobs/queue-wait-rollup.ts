/**
 * Hourly queue-wait rollups — see control-schema.sql's comment on
 * `queue_wait_hourly_rollups` for why this exists: a raw 24h scan of `jobs`
 * for (started_at - created_at) percentiles measured ~100ms at 100k rows
 * (scripts/bench-admin-queries.ts), over the admin page's ~50ms budget, and
 * an index didn't help (the window covers too large a fraction of the
 * table for an index seek to beat a full scan). Rolling up one hour at a
 * time keeps every read bounded by TIME (one hour's jobs), not by how many
 * total rows retention has accumulated.
 *
 * `computeHourlyRollup` is exact for the one hour it covers. Approximating
 * a 24h p50/p95 as a sample-weighted average across 24 of these hourly
 * values is NOT mathematically a true percentile-of-percentiles — it can
 * under- or over-state the real 24h percentile when wait-time distributions
 * differ sharply hour to hour — but it's the standard, accepted compromise
 * for an operational dashboard (the same tradeoff Prometheus/StatsD-style
 * monitoring makes), and the admin page's own numbers are explicitly
 * "for operators to watch trends", not a precise SLA report.
 */

import { getControlDb, nowIso } from '@/db/client'

export interface HourlyWaitStats {
  tenantId: string
  sampleCount: number
  p50Ms: number
  p95Ms: number
}

/** 'YYYY-MM-DDTHH', UTC — the bucket a given instant falls into. */
export function hourBucketFor(date: Date): string {
  return date.toISOString().slice(0, 13)
}

function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0
  const index = Math.min(sortedMs.length - 1, Math.floor((p / 100) * sortedMs.length))
  return sortedMs[index]
}

/**
 * Read-only: exact p50/p95 queue-wait for every tenant with at least one
 * job whose `created_at` falls within [start, end] — from that window's
 * rows only, never more than roughly (total jobs / 24h) rows for a one-hour
 * window, regardless of how many total rows the table holds.
 */
function computeStatsForWindow(start: string, end: string): HourlyWaitStats[] {
  const rows = getControlDb()
    .prepare(
      `SELECT tenant_id, created_at, started_at FROM jobs
       WHERE created_at >= ? AND created_at <= ? AND started_at IS NOT NULL`
    )
    .all(start, end) as { tenant_id: string; created_at: string; started_at: string }[]

  const byTenant = new Map<string, number[]>()
  for (const row of rows) {
    const waitMs = new Date(row.started_at).getTime() - new Date(row.created_at).getTime()
    if (!Number.isFinite(waitMs) || waitMs < 0) continue
    const list = byTenant.get(row.tenant_id) ?? []
    list.push(waitMs)
    byTenant.set(row.tenant_id, list)
  }

  return Array.from(byTenant.entries(), ([tenantId, waits]) => {
    waits.sort((a, b) => a - b)
    return { tenantId, sampleCount: waits.length, p50Ms: percentile(waits, 50), p95Ms: percentile(waits, 95) }
  })
}

/**
 * Computes AND PERSISTS the rollup for one complete hour — used only by the
 * scheduled backfill below, never by a read path: an admin page load must
 * never have a side effect of writing to the database. Safe to call more
 * than once for the same bucket (e.g. a retry after a crash); it
 * overwrites, not accumulates.
 */
export function computeHourlyRollup(hourBucket: string): HourlyWaitStats[] {
  const results = computeStatsForWindow(`${hourBucket}:00:00.000Z`, `${hourBucket}:59:59.999Z`)

  const upsert = getControlDb().prepare(
    `INSERT INTO queue_wait_hourly_rollups (tenant_id, hour_bucket, sample_count, p50_ms, p95_ms, computed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, hour_bucket) DO UPDATE SET
       sample_count = excluded.sample_count, p50_ms = excluded.p50_ms, p95_ms = excluded.p95_ms,
       computed_at = excluded.computed_at`
  )
  const computedAt = nowIso()
  for (const stats of results) {
    upsert.run(stats.tenantId, hourBucket, stats.sampleCount, stats.p50Ms, stats.p95Ms, computedAt)
  }
  return results
}

/**
 * Called from the slow maintenance sweep (pool.ts). Backfills any of the
 * last `lookbackHours` COMPLETE hours (i.e. not the current, still-running
 * one) that don't have a rollup row yet for ANY tenant — covers a process
 * that was down when an hour rolled over, and the very first run against an
 * existing install. Idempotent and cheap once caught up: a bucket with
 * already-computed rows is skipped without re-querying `jobs`.
 */
export function backfillHourlyRollups(lookbackHours = 25): number {
  const db = getControlDb()
  const existing = new Set(
    (db.prepare('SELECT DISTINCT hour_bucket FROM queue_wait_hourly_rollups').all() as { hour_bucket: string }[]).map(
      r => r.hour_bucket
    )
  )

  const now = new Date()
  const currentBucket = hourBucketFor(now)
  let computed = 0

  for (let i = 1; i <= lookbackHours; i++) {
    const bucket = hourBucketFor(new Date(now.getTime() - i * 60 * 60 * 1000))
    if (bucket === currentBucket || existing.has(bucket)) continue
    computeHourlyRollup(bucket)
    computed++
  }
  return computed
}

/** Drops rollup rows older than `maxAgeHours` — these are small, but there's no reason to keep them forever. */
export function pruneHourlyRollups(maxAgeHours = 24 * 14): number {
  const cutoff = hourBucketFor(new Date(Date.now() - maxAgeHours * 60 * 60 * 1000))
  const result = getControlDb()
    .prepare('DELETE FROM queue_wait_hourly_rollups WHERE hour_bucket < ?')
    .run(cutoff)
  return result.changes
}

/**
 * The admin page's "24h queue wait p50/p95" for one tenant: a sample-
 * weighted average across the last `hours` hourly rollups, PLUS the
 * current (incomplete) hour computed live — live because that one hour's
 * worth of jobs is always a small, bounded query no matter the table size,
 * so there's no need to wait for it to roll up before it's visible.
 */
export function getQueueWaitPercentiles(tenantId: string, hours = 24): { p50Ms: number; p95Ms: number; sampleCount: number } {
  const db = getControlDb()
  const now = new Date()
  const cutoffBucket = hourBucketFor(new Date(now.getTime() - hours * 60 * 60 * 1000))

  const rolledUp = db
    .prepare(
      `SELECT sample_count, p50_ms, p95_ms FROM queue_wait_hourly_rollups
       WHERE tenant_id = ? AND hour_bucket > ? AND hour_bucket < ?
       ORDER BY hour_bucket ASC`
    )
    .all(tenantId, cutoffBucket, hourBucketFor(now)) as { sample_count: number; p50_ms: number; p95_ms: number }[]

  // Read-only — the current hour is never persisted (see computeStatsForWindow's
  // doc comment); it's recomputed on every call, but it's always a small,
  // bounded (at most one hour's worth of jobs) query.
  const liveBucket = computeStatsForWindow(`${hourBucketFor(now)}:00:00.000Z`, now.toISOString()).find(
    s => s.tenantId === tenantId
  )

  const buckets = [
    ...rolledUp.map(r => ({ sampleCount: r.sample_count, p50Ms: r.p50_ms, p95Ms: r.p95_ms })),
    ...(liveBucket ? [liveBucket] : []),
  ]

  const totalSamples = buckets.reduce((sum, b) => sum + b.sampleCount, 0)
  if (totalSamples === 0) return { p50Ms: 0, p95Ms: 0, sampleCount: 0 }

  const weightedP50 = buckets.reduce((sum, b) => sum + b.p50Ms * b.sampleCount, 0) / totalSamples
  const weightedP95 = buckets.reduce((sum, b) => sum + b.p95Ms * b.sampleCount, 0) / totalSamples

  return { p50Ms: weightedP50, p95Ms: weightedP95, sampleCount: totalSamples }
}
