/**
 * Health/readiness check. Status only — no counts, no tenant data, nothing
 * an unauthenticated prober shouldn't see (see the privacy posture every
 * other public endpoint in this app follows). Public on purpose: a load
 * balancer, Docker's own HEALTHCHECK, or an uptime monitor has no session.
 *
 * P6: actually verifies readiness rather than always answering 'ok' — the
 * two things genuinely worth probing before telling an orchestrator "route
 * traffic here":
 *
 *  - control.db is writable: `BEGIN IMMEDIATE; ROLLBACK` acquires (and
 *    immediately releases) the write lock a real write would need, without
 *    touching any actual row. This is what catches a read-only filesystem,
 *    a full disk, or a corrupted database file — exactly the states where
 *    the process is "alive" (this route itself still runs) but every real
 *    request would fail.
 *  - the data directory is writable: write-and-delete a small sentinel
 *    file. Catches a data VOLUME gone read-only independently of the
 *    database file specifically (e.g. the mount itself remounted ro).
 *
 * Returns 503 (not a thrown error) on failure, with no detail beyond
 * 'status: error' — an orchestrator needs the boolean, not the reason; the
 * reason goes to the server's own logs instead.
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { config } from '@/config'
import { getControlDb } from '@/db/client'
import { handler } from '@/lib/api-handler'

function checkControlDbWritable(): void {
  const db = getControlDb()
  db.exec('BEGIN IMMEDIATE')
  db.exec('ROLLBACK')
}

function checkDataDirWritable(): void {
  const sentinel = path.join(config.paths.dataDir, `.health-${process.pid}-${crypto.randomBytes(4).toString('hex')}`)
  fs.writeFileSync(sentinel, 'ok')
  fs.unlinkSync(sentinel)
}

export const dynamic = 'force-dynamic'

export const GET = handler(
  async () => {
    try {
      checkControlDbWritable()
      checkDataDirWritable()
      return NextResponse.json({ status: 'ok' })
    } catch (err) {
      console.error('[health] readiness check failed:', err)
      return NextResponse.json({ status: 'error' }, { status: 503 })
    }
  },
  { public: true }
)
