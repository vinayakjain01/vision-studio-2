import path from 'path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestTenant } from '../helpers/tenancy-fixture'
import { runWithTenant } from '@/tenancy/context'
import * as queue from '@/jobs/queue'
import { getPool } from '@/jobs/pool'
import { getControlDb, closeDb } from '@/db/client'
import { migrateControl } from '@/db/migrate'
import { tenantQueueState } from '@/db/control-repositories'
import { config } from '@/config'

/**
 * P6 graceful shutdown, end to end through the REAL `WorkerPool` class —
 * not a simulation of it. Points `WorkerPool.spawn()` at the lightweight
 * `fake-worker-entry.ts` test harness (via `VISION_STUDIO_WORKER_ENTRY_OVERRIDE`,
 * a test-only escape hatch — see pool.ts's `spawn()`) rather than the real
 * worker, so this proves `pool.stop()`'s actual grace-period/kill/return-to-
 * pending sequence against a REAL spawned OS process without loading real
 * ONNX models. `config.jobs.shutdownGraceMs` is lowered for the duration of
 * this file so the test doesn't take the real default (30s) to run.
 */
describe('graceful shutdown (real WorkerPool, real spawned process)', () => {
  const originalGraceMs = config.jobs.shutdownGraceMs
  const originalOverride = process.env.VISION_STUDIO_WORKER_ENTRY_OVERRIDE

  beforeEach(() => {
    const db = getControlDb()
    migrateControl(db)
    db.exec('DELETE FROM jobs')
    db.exec('DELETE FROM tenant_queue_state')
    db.exec('DELETE FROM memberships')
    db.exec('DELETE FROM sessions')
    db.exec('DELETE FROM users')
    db.exec('DELETE FROM tenants')

    ;(config.jobs as any).shutdownGraceMs = 400
    process.env.VISION_STUDIO_WORKER_ENTRY_OVERRIDE = path.resolve(__dirname, '../helpers/fake-worker-entry.ts')
  })

  afterEach(async () => {
    await getPool().stop() // in case a test fails before its own stop() runs
    ;(config.jobs as any).shutdownGraceMs = originalGraceMs
    if (originalOverride) process.env.VISION_STUDIO_WORKER_ENTRY_OVERRIDE = originalOverride
    else delete process.env.VISION_STUDIO_WORKER_ENTRY_OVERRIDE
  })

  function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now()
      const check = () => {
        if (predicate()) return resolve()
        if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting for condition'))
        setTimeout(check, 50)
      }
      check()
    })
  }

  it('a job stuck past the grace period is returned to pending with NO attempt consumed, and running_jobs settles to 0', async () => {
    const tenant = createTestTenant('GracefulShutdown')
    const jobId = await runWithTenant(
      { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' },
      async () => {
        const { ids } = queue.enqueue(tenant.tenantId, [{ kind: 'vision', payload: { action: 'hang' } as any }])
        return ids[0]
      }
    )

    const pool = getPool()
    pool.start()

    // Wait for the (fake) worker to actually claim and start this job.
    await waitUntil(() => queue.get(tenant.tenantId, jobId)?.status === 'running')
    const beforeStop = queue.get(tenant.tenantId, jobId)!
    expect(beforeStop.attempts).toBe(1) // claim() always increments on claim, not on failure
    expect(tenantQueueState.get(tenant.tenantId)?.runningJobs).toBe(1)

    await pool.stop() // grace period is 400ms; the 'hang' job never finishes on its own

    const after = queue.get(tenant.tenantId, jobId)!
    expect(after.status).toBe('pending')
    expect(after.attempts).toBe(0) // the attempt claim() counted was refunded — this is the whole point
    expect(tenantQueueState.get(tenant.tenantId)?.runningJobs).toBe(0)

    // Immediately claimable again by whatever starts next.
    const reclaimed = queue.claim('vision', 'post-shutdown-worker')
    expect(reclaimed?.id).toBe(jobId)
  }, 15_000)

  it('closeDb() checkpoints the WAL — the -wal file is truncated to empty afterward', async () => {
    const tenant = createTestTenant('WalCheckpoint')
    await runWithTenant({ tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }, async () => {
      queue.enqueue(tenant.tenantId, [{ kind: 'vision', payload: { imageId: 'i1', sourceHash: 'h', storageKey: 'k' } }])
    })

    const fs = await import('fs')
    const walPath = `${config.paths.controlDatabase}-wal`
    // Writing via enqueue() above should have put SOMETHING in the WAL file
    // under normal (non-checkpointing) operation — not asserted directly
    // (timing-dependent whether SQLite's own auto-checkpoint already fired),
    // only that after OUR explicit checkpoint it's reliably empty.
    closeDb()
    if (fs.existsSync(walPath)) {
      expect(fs.statSync(walPath).size).toBe(0)
    }
    // If the file doesn't exist at all, TRUNCATE mode removed it entirely —
    // also a valid "nothing left pending" outcome.
  })
})
