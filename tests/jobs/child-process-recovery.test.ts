import path from 'path'
import { spawn, type ChildProcess } from 'child_process'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestTenant } from '../helpers/tenancy-fixture'
import * as queue from '@/jobs/queue'
import { getControlDb } from '@/db/client'
import { migrateControl } from '@/db/migrate'
import { tenantQueueState } from '@/db/control-repositories'

/**
 * Integration tests with a REAL separate OS process (not a simulation) —
 * see tests/helpers/fake-worker-entry.ts, a trivial stand-in for
 * src/jobs/worker-entry.ts's claim/bind/report loop. Proves the queue's
 * crash-recovery semantics hold across an actual process boundary: a
 * `kill -9` genuinely terminates the process mid-job the way a native
 * ONNX/sharp/skia fault would, which nothing short of a real child process
 * can exercise.
 */
describe('child-process recovery (real spawned worker)', () => {
  const children: ChildProcess[] = []

  // No leftover jobs from a previous test in this file — a job the first
  // test reclaimed back to 'pending' (rather than completing) would
  // otherwise still be sitting in the shared queue, claimable by the NEXT
  // test's spawned worker ahead of the job that test actually cares about
  // (exactly what happened before this existed: the poison-job test's
  // worker claimed the FIRST test's leftover 30-second sleep job instead).
  beforeEach(() => {
    const db = getControlDb()
    migrateControl(db)
    db.exec('DELETE FROM jobs')
    db.exec('DELETE FROM tenant_queue_state')
    db.exec('DELETE FROM memberships')
    db.exec('DELETE FROM sessions')
    db.exec('DELETE FROM users')
    db.exec('DELETE FROM tenants')
  })

  function spawnFakeWorker(workerId: string, pollIntervalMs = 200): ChildProcess {
    const entry = path.resolve(__dirname, '../helpers/fake-worker-entry.ts')
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', entry, JSON.stringify({ workerId, kinds: ['vision'], pollIntervalMs })],
      { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: { ...process.env } }
    )
    children.push(child)
    return child
  }

  function waitForMessage(child: ChildProcess, type: string, timeoutMs = 10_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for '${type}'`)), timeoutMs)
      child.on('message', (msg: any) => {
        if (msg?.type === type) {
          clearTimeout(timer)
          resolve(msg)
        }
      })
    })
  }

  function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for exit')), timeoutMs)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  afterEach(async () => {
    for (const child of children) {
      if (!child.killed && child.exitCode === null) {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
      }
    }
    children.length = 0
  })

  it('kill -9 mid-job: the job is still claimed immediately after, then reclaimStale() requeues it and running_jobs settles back to 0', async () => {
    const t = createTestTenant('T')
    queue.enqueue(t.tenantId, [
      { kind: 'vision', payload: { action: 'sleep', ms: 30_000, imageId: 'i1', sourceHash: 'h1', storageKey: 'k' } as any },
    ])

    const child = spawnFakeWorker('real-worker-killed')
    const started = await waitForMessage(child, 'job:started')
    expect(started.tenantId).toBe(t.tenantId)

    // The job is genuinely in flight in a real OS process right now.
    const midFlight = queue.get(t.tenantId, started.jobId)!
    expect(['claimed', 'running']).toContain(midFlight.status)
    expect(tenantQueueState.get(t.tenantId)?.runningJobs).toBe(1)

    child.kill('SIGKILL')
    await waitForExit(child)

    // A real crash: the row is exactly where the worker left it — nothing
    // auto-corrects on process death, which is the entire reason
    // reclaimStale() has to exist.
    const afterKill = queue.get(t.tenantId, started.jobId)!
    expect(['claimed', 'running']).toContain(afterKill.status)

    // Force the lease to have expired (a real 30s wait would make this test
    // slow for no further confidence — the lease mechanism itself is
    // unit-tested precisely in tests/jobs/queue.test.ts; what this test
    // uniquely proves is that a REAL killed process leaves the row in
    // exactly the state reclaimStale() expects to find it in).
    getControlDb()
      .prepare('UPDATE jobs SET lease_expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), started.jobId)

    const reclaimed = queue.reclaimStale()
    expect(reclaimed).toBe(1)

    const afterReclaim = queue.get(t.tenantId, started.jobId)!
    expect(afterReclaim.status).toBe('pending')
    expect(afterReclaim.workerId).toBeNull()
    expect(tenantQueueState.get(t.tenantId)?.runningJobs).toBe(0)
  }, 20_000)

  it('a poison job that always throws fails permanently after max_attempts, processed entirely by a real worker process', async () => {
    const t = createTestTenant('T')
    queue.enqueue(t.tenantId, [
      { kind: 'vision', payload: { action: 'fail' } as any, maxAttempts: 2 },
    ])

    const child = spawnFakeWorker('real-worker-poison', 150)

    // Two 'job:failed' messages: one retrying, one final.
    const first = await waitForMessage(child, 'job:failed')
    expect(first.retrying).toBe(true)

    const second = await waitForMessage(child, 'job:failed', 15_000) // backoff before the 2nd attempt
    expect(second.retrying).toBe(false)
    expect(second.jobId).toBe(first.jobId)

    const final = queue.get(t.tenantId, first.jobId)!
    expect(final.status).toBe('failed')
    expect(final.attempts).toBe(2)
    expect(tenantQueueState.get(t.tenantId)?.runningJobs).toBe(0)

    child.send({ type: 'stop' })
    await waitForExit(child, 5000).catch(() => child.kill('SIGKILL'))
  }, 25_000)
})
