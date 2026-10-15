/**
 * Linux-only resident-memory reader (`/proc/<pid>/status`) — shared by
 * `admin-service.ts`'s diagnostics (per-worker RSS in `npm run diag`) and
 * `pool.ts`'s Phase 1.5 worker recycling (an RSS-threshold trigger).
 * Returns null anywhere else (no /proc, e.g. macOS/Windows dev machines) or
 * on any read failure — a missing number is never worth crashing either
 * caller over.
 */

import fs from 'fs/promises'

export async function readRssMb(pid: number): Promise<number | null> {
  try {
    const text = await fs.readFile(`/proc/${pid}/status`, 'utf8')
    const match = text.match(/^VmRSS:\s+(\d+)\s+kB$/m)
    return match ? Math.round(Number(match[1]) / 1024) : null
  } catch {
    return null
  }
}
