/**
 * Per-stage timing log (Phase 1.2 of the issue-fix program, docs/ISSUES.md) —
 * one structured, greppable line per pipeline stage a job passes through:
 * upload, queue wait, each vision-analysis sub-stage, render, AI Extend
 * provider request, defer/poll wait, and render's own encode.
 *
 * Deliberately log-only, same pattern as `event-loop-monitor.ts` — this is
 * for `npm run diag` and manual `grep '\[stage\]'` log analysis while
 * reproducing the "30 images / 15 minutes" issue, not a new metrics
 * database. `key=value` pairs (not JSON) so a line reads directly in a
 * terminal and still parses cleanly with a regex or `awk`.
 */

export interface StageTimingFields {
  tenantId: string
  jobId: string
  stage: string
  durationMs: number
  /** Free-form extra context — e.g. `{ kind: 'vision', imageId }` or `{ attempt: 2 }`. */
  [key: string]: string | number | undefined
}

export function logStageTiming(fields: StageTimingFields): void {
  const { tenantId, jobId, stage, durationMs, ...rest } = fields
  const extra = Object.entries(rest)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
  console.log(
    `[stage] stage=${stage} tenantId=${tenantId} jobId=${jobId} ms=${Math.round(durationMs)}${extra ? ' ' + extra : ''}`
  )
}

