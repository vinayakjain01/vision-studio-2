/**
 * Phase 1.3 companion to reproduce-issue4-slow-batch.ts — parses the
 * `[stage] stage=... tenantId=... jobId=... ms=... key=value...` lines
 * `src/lib/stage-timer.ts` emits (Phase 1.2) out of a captured log file and
 * builds the per-image timeline / aggregate breakdown issue 4 needs:
 * "say where about 30s per image goes."
 *
 *   npx tsx scripts/parse-stage-log.ts <path-to-log-file> [--job=<jobId>]
 *
 * `--job` prints one job's full stage-by-stage timeline instead of the
 * aggregate summary — useful for picking out a representative render job
 * once the aggregate points at a stage worth inspecting individually.
 */

import fs from 'fs'

interface StageEvent {
  stage: string
  tenantId: string
  jobId: string
  ms: number
  extra: Record<string, string>
}

const LINE_RE = /^\[stage\] stage=(\S+) tenantId=(\S+) jobId=(\S+) ms=(\d+)(.*)$/

function parseLine(line: string): StageEvent | null {
  const m = LINE_RE.exec(line)
  if (!m) return null
  const [, stage, tenantId, jobId, msStr, rest] = m
  const extra: Record<string, string> = {}
  for (const pair of rest.trim().split(/\s+/).filter(Boolean)) {
    const eq = pair.indexOf('=')
    if (eq > 0) extra[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return { stage, tenantId, jobId, ms: Number(msStr), extra }
}

function parseFile(filePath: string): StageEvent[] {
  const text = fs.readFileSync(filePath, 'utf8')
  const events: StageEvent[] = []
  for (const line of text.split('\n')) {
    const ev = parseLine(line)
    if (ev) events.push(ev)
  }
  return events
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function printJobTimeline(events: StageEvent[], jobId: string): void {
  const jobEvents = events.filter(e => e.jobId === jobId)
  if (jobEvents.length === 0) {
    console.log(`No [stage] lines found for job ${jobId}`)
    return
  }
  console.log(`\nTimeline for job ${jobId} (tenant ${jobEvents[0].tenantId}):`)
  let total = 0
  for (const e of jobEvents) {
    total += e.ms
    const extra = Object.entries(e.extra)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')
    console.log(`  ${e.stage.padEnd(28)} ${fmtMs(e.ms).padStart(8)}${extra ? '  ' + extra : ''}`)
  }
  console.log(`  ${'TOTAL (sum of logged stages)'.padEnd(28)} ${fmtMs(total).padStart(8)}`)
}

function printAggregate(events: StageEvent[]): void {
  if (events.length === 0) {
    console.log('No [stage] lines found in this log file.')
    return
  }

  const byStage = new Map<string, { count: number; totalMs: number }>()
  for (const e of events) {
    const bucket = byStage.get(e.stage) ?? { count: 0, totalMs: 0 }
    bucket.count++
    bucket.totalMs += e.ms
    byStage.set(e.stage, bucket)
  }

  const grandTotalMs = [...byStage.values()].reduce((a, b) => a + b.totalMs, 0)

  console.log(`Parsed ${events.length} [stage] events across ${new Set(events.map(e => e.jobId)).size} jobs.\n`)
  console.log('Aggregate time by stage (sorted by total time, descending):\n')
  console.log(`  ${'stage'.padEnd(28)} ${'count'.padStart(6)} ${'total'.padStart(10)} ${'avg'.padStart(10)} ${'% of total'.padStart(10)}`)

  const rows = [...byStage.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs)
  for (const [stage, { count, totalMs }] of rows) {
    const pct = grandTotalMs > 0 ? ((totalMs / grandTotalMs) * 100).toFixed(1) : '0.0'
    console.log(
      `  ${stage.padEnd(28)} ${String(count).padStart(6)} ${fmtMs(totalMs).padStart(10)} ${fmtMs(totalMs / count).padStart(10)} ${(pct + '%').padStart(10)}`
    )
  }

  // Grouped view: how much of the total is spent waiting on AI Extend
  // (provider call + the three defer:* polling stages) vs everything else.
  const aiExtendStages = rows.filter(([s]) => s.startsWith('ai_extend:') || s.startsWith('defer:'))
  const aiExtendTotal = aiExtendStages.reduce((a, [, v]) => a + v.totalMs, 0)
  const visionStages = rows.filter(([s]) => s.startsWith('vision:'))
  const visionTotal = visionStages.reduce((a, [, v]) => a + v.totalMs, 0)
  console.log('\nGrouped:')
  console.log(`  AI Extend wait (provider_request + defer:* polling): ${fmtMs(aiExtendTotal)} (${grandTotalMs > 0 ? ((aiExtendTotal / grandTotalMs) * 100).toFixed(1) : '0'}%)`)
  console.log(`  Vision analysis sub-stages:                          ${fmtMs(visionTotal)} (${grandTotalMs > 0 ? ((visionTotal / grandTotalMs) * 100).toFixed(1) : '0'}%)`)

  // Per-job totals, to report a representative "per image" number alongside
  // the aggregate — the aggregate alone hides whether cost is spread evenly
  // or concentrated in a few straggler jobs.
  const byJob = new Map<string, number>()
  for (const e of events) byJob.set(e.jobId, (byJob.get(e.jobId) ?? 0) + e.ms)
  const perJobTotals = [...byJob.values()].sort((a, b) => a - b)
  if (perJobTotals.length > 0) {
    const p50 = perJobTotals[Math.floor(perJobTotals.length * 0.5)]
    const p95 = perJobTotals[Math.min(perJobTotals.length - 1, Math.floor(perJobTotals.length * 0.95))]
    console.log(`\nPer-job logged-stage total: p50=${fmtMs(p50)} p95=${fmtMs(p95)} max=${fmtMs(perJobTotals[perJobTotals.length - 1])} (n=${perJobTotals.length} jobs)`)
  }
}

function main() {
  const args = process.argv.slice(2)
  const filePath = args.find(a => !a.startsWith('--'))
  const jobArg = args.find(a => a.startsWith('--job='))
  if (!filePath) {
    console.error('Usage: npx tsx scripts/parse-stage-log.ts <path-to-log-file> [--job=<jobId>]')
    process.exit(1)
  }
  const events = parseFile(filePath)
  if (jobArg) {
    printJobTimeline(events, jobArg.slice('--job='.length))
  } else {
    printAggregate(events)
  }
}

main()
