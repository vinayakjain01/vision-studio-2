import path from 'path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestTenant } from '../helpers/tenancy-fixture'
import { runWithTenant } from '@/tenancy/context'
import * as queue from '@/jobs/queue'
import { getPool } from '@/jobs/pool'
import { getControlDb } from '@/db/client'
import { migrateControl } from '@/db/migrate'

/**
 * Reported 2026-10-30: a "Generate" batch was mid-flight when an unrelated
 * deploy restarted the app. The pool (started lazily by ensurePoolRunning(),
 * only on a NEW enqueue — see pool.ts's module doc) died with the process,
 * and its remaining already-queued jobs never resumed on their own — nothing
 * enqueues NEW work just because the server restarted, so they sat `pending`
 * forever until manually nudged.
 *
 * instrumentation.ts's register() now checks for existing unclaimed work at
 * boot and starts the pool immediately if there is any, rather than only
 * reacting to future enqueues.
 */
describe('register() resumes the pool at boot if work is already queued', () => {
  const originalOverride = process.env.VISION_STUDIO_WORKER_ENTRY_OVERRIDE
  const originalRuntime = process.env.NEXT_RUNTIME

  beforeEach(() => {
    const db = getControlDb()
    migrateControl(db)
    db.exec('DELETE FROM jobs')
    db.exec('DELETE FROM tenant_queue_state')
    db.exec('DELETE FROM memberships')
    db.exec('DELETE FROM sessions')
    db.exec('DELETE FROM users')
    db.exec('DELETE FROM tenants')

    process.env.VISION_STUDIO_WORKER_ENTRY_OVERRIDE = path.resolve(__dirname, '../helpers/fake-worker-entry.ts')
    // register() no-ops outside the nodejs runtime (its own first check) —
    // real `next start` sets this; tests have to set it explicitly.
    process.env.NEXT_RUNTIME = 'nodejs'
  })

  afterEach(async () => {
    await getPool().stop()
    if (originalOverride) process.env.VISION_STUDIO_WORKER_ENTRY_OVERRIDE = originalOverride
    else delete process.env.VISION_STUDIO_WORKER_ENTRY_OVERRIDE
    if (originalRuntime) process.env.NEXT_RUNTIME = originalRuntime
    else delete process.env.NEXT_RUNTIME
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

  it('starts the pool when a job is already pending from before the restart', async () => {
    const tenant = createTestTenant('BootResumePending')
    const jobId = await runWithTenant(
      { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' },
      async () => {
        const { ids } = queue.enqueue(tenant.tenantId, [{ kind: 'vision', payload: { action: 'noop' } as any }])
        return ids[0]
      }
    )

    const { register } = await import('../../instrumentation')
    await register()

    expect(getPool().isRunning()).toBe(true)
    // Proves it's actually running, not just flagged — the fake worker picks
    // the job up and finishes it.
    await waitUntil(() => queue.get(tenant.tenantId, jobId)?.status === 'completed')
  }, 15_000)

  it('does not start the pool when the queue is empty — a browsing-only boot pays for no idle workers', async () => {
    const { register } = await import('../../instrumentation')
    await register()

    expect(getPool().isRunning()).toBe(false)
  })
})
