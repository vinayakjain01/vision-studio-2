/**
 * Minimal stand-in for src/jobs/worker-entry.ts, used ONLY by
 * tests/jobs/child-process-recovery.test.ts — same claim/bind-tenant/report
 * loop shape, but with a trivial fake handler instead of real vision/render
 * work, so the integration test can spawn a REAL OS process (proving actual
 * crash recovery, not a simulation of it) without loading ONNX models.
 *
 * Payload controls what the fake handler does:
 *   { action: 'sleep', ms }   — wait, then complete successfully. Long
 *                               enough values let a test kill -9 this
 *                               process mid-job to test lease-based recovery.
 *   { action: 'fail' }        — throw immediately (poison-job testing).
 *   { action: 'succeed' }     — complete immediately.
 *
 * Config arrives the same way the real worker-entry does: a JSON CLI arg.
 */

import * as queue from '../../src/jobs/queue'
import { closeDb } from '../../src/db/client'
import { runWithTenant } from '../../src/tenancy/context'
import type { JobKind } from '../../src/db/types'

interface FakeWorkerConfig {
  workerId: string
  kinds: JobKind[]
  pollIntervalMs: number
}

const cfg: FakeWorkerConfig = JSON.parse(process.argv[2] ?? '{}')
if (!cfg.workerId) {
  console.error('[fake-worker] missing configuration argument')
  process.exit(1)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function post(message: unknown): void {
  process.send?.(message)
}

let running = true

async function runOne(kind: JobKind): Promise<boolean> {
  const job = queue.claim(kind, cfg.workerId)
  if (!job) return false

  queue.markRunning(job.id, cfg.workerId)
  post({ type: 'job:started', jobId: job.id, tenantId: job.tenantId })

  const beat = setInterval(() => {
    try {
      queue.heartbeat(job.id, cfg.workerId)
    } catch {
      // Transient — next beat covers it.
    }
  }, 200)

  try {
    await runWithTenant({ tenantId: job.tenantId, userId: 'system', role: 'owner' }, async () => {
      const payload = job.payload as unknown as { action: 'sleep' | 'fail' | 'succeed'; ms?: number }
      if (payload.action === 'fail') throw new Error('poison job: always fails')
      if (payload.action === 'sleep') await sleep(payload.ms ?? 0)
      // 'succeed' and post-sleep both fall through to completion.
    })
    queue.complete(job.id, cfg.workerId, { ok: true })
    post({ type: 'job:done', jobId: job.id })
  } catch (err) {
    const { retrying } = queue.fail(job.id, cfg.workerId, err instanceof Error ? err.message : String(err))
    post({ type: 'job:failed', jobId: job.id, retrying })
  } finally {
    clearInterval(beat)
  }

  return true
}

async function loop(): Promise<void> {
  post({ type: 'ready' })
  while (running) {
    let didWork = false
    for (const kind of cfg.kinds) {
      if (!running) break
      if (await runOne(kind)) {
        didWork = true
        break
      }
    }
    if (!didWork) {
      post({ type: 'idle' })
      await sleep(cfg.pollIntervalMs)
    }
  }
}

process.on('message', (message: { type: string }) => {
  if (message?.type === 'stop') running = false
})

loop()
  .catch(err => {
    console.error('[fake-worker] fatal:', err)
    process.exitCode = 1
  })
  .finally(() => {
    closeDb()
    process.exit(process.exitCode ?? 0)
  })
