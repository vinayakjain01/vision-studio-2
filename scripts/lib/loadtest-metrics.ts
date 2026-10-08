/**
 * Shared math/formatting for scripts/loadtest-multitenant.ts — percentiles,
 * a running stopwatch, and the markdown report writer. No tenancy/DB
 * knowledge here on purpose, so this stays trivially unit-testable and
 * reusable across every scenario.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'

export function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0
  const idx = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1)
  return sortedMs[Math.max(0, idx)]
}

export interface LatencyStats {
  count: number
  p50: number
  p95: number
  p99: number
  max: number
  mean: number
}

export function summarize(samplesMs: number[]): LatencyStats {
  if (samplesMs.length === 0) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 }
  const sorted = [...samplesMs].sort((a, b) => a - b)
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
    mean,
  }
}

export class Stopwatch {
  private readonly startedAt = process.hrtime.bigint()
  elapsedMs(): number {
    return Number(process.hrtime.bigint() - this.startedAt) / 1e6
  }
}

export interface MachineSpec {
  platform: string
  release: string
  arch: string
  cpuModel: string
  cpuCount: number
  totalMemGb: number
  nodeVersion: string
}

export function captureMachineSpec(): MachineSpec {
  const cpus = os.cpus()
  return {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpuModel: cpus[0]?.model ?? 'unknown',
    cpuCount: cpus.length,
    totalMemGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    nodeVersion: process.version,
  }
}

export interface ScenarioResult {
  name: string
  mode: 'fast' | 'real'
  metrics: Record<string, string | number | boolean>
  targets: { description: string; met: boolean | null; evidence: string }[]
  notes: string[]
  durationMs: number
}

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

export function writeMarkdownReport(opts: {
  outPath: string
  mode: 'fast' | 'real'
  machine: MachineSpec
  results: ScenarioResult[]
}): void {
  const { outPath, mode, machine, results } = opts
  const lines: string[] = []

  lines.push(`# Multi-tenancy load test report`)
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push(`Mode: **${mode}**`)
  lines.push('')
  lines.push(`## Machine`)
  lines.push('')
  lines.push(`| Field | Value |`)
  lines.push(`|---|---|`)
  lines.push(`| Platform | ${machine.platform} ${machine.release} (${machine.arch}) |`)
  lines.push(`| CPU | ${machine.cpuModel} × ${machine.cpuCount} |`)
  lines.push(`| Memory | ${machine.totalMemGb} GB |`)
  lines.push(`| Node | ${machine.nodeVersion} |`)
  lines.push('')

  if (mode === 'fast') {
    lines.push(
      `> **Fast mode** uses a synthetic worker (no ONNX, no Cloudinary) to exercise the ` +
        `real queue/scheduler/pool code deterministically. Timing numbers below measure ` +
        `SCHEDULER behavior (fairness, ordering, throughput under contention), not real ` +
        `inference wall-clock time. Re-run with \`--mode=real\` on the target production ` +
        `hardware for real-world latency numbers.`
    )
    lines.push('')
  }

  for (const r of results) {
    lines.push(`## ${r.name}`)
    lines.push('')
    lines.push(`Duration: ${fmtMs(r.durationMs)}`)
    lines.push('')
    lines.push(`| Metric | Value |`)
    lines.push(`|---|---|`)
    for (const [k, v] of Object.entries(r.metrics)) {
      lines.push(`| ${k} | ${v} |`)
    }
    lines.push('')
    if (r.targets.length > 0) {
      lines.push(`**Targets:**`)
      lines.push('')
      for (const t of r.targets) {
        const mark = t.met === null ? '—' : t.met ? '✅' : '❌'
        lines.push(`- ${mark} ${t.description} — ${t.evidence}`)
      }
      lines.push('')
    }
    if (r.notes.length > 0) {
      lines.push(`**Notes:**`)
      lines.push('')
      for (const n of r.notes) lines.push(`- ${n}`)
      lines.push('')
    }
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, lines.join('\n'))
}
