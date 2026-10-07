import { describe, it, expect } from 'vitest'
import { createTestTenant } from '../helpers/tenancy-fixture'
import * as queue from '@/jobs/queue'
import { runWithTenant, tryCurrentTenant } from '@/tenancy/context'
import { writeFileAtomic, readMedia, mediaExists } from '@/storage/media-store'

/**
 * Mirrors `worker-entry.ts`'s `runOne()` exactly in shape — claim, bind ONLY
 * that job's tenant via `runWithTenant`, run the handler, release — without
 * spawning a real child process or loading the vision engine. The property
 * under test is the per-job BINDING itself: a single JS process (one
 * `worker-entry.ts`, many claimed jobs over its lifetime) must never let one
 * job's tenant context leak into the next, and two tenants' byte-identical
 * uploads processed back-to-back in that same process must land as fully
 * separate files — the same property tests/isolation/dedup-separation.test.ts
 * proves at the HTTP-route level, reproduced here at the worker-loop level
 * where P3 actually introduces it (P1/P2's bridge ran every job as one fixed
 * tenant for the worker's entire lifetime; P3 removes that).
 */
describe('per-job tenant binding (simulated worker loop, no real child process)', () => {
  async function runOneFake(kind: 'vision'): Promise<{ tenantId: string; wrote: string }> {
    const job = queue.claim(kind, 'sim-worker')
    if (!job) throw new Error('nothing to claim')
    queue.markRunning(job.id, 'sim-worker')

    // Outside any runWithTenant scope — must be unset before binding.
    expect(tryCurrentTenant()).toBeNull()

    const wrote = await runWithTenant({ tenantId: job.tenantId, userId: 'system', role: 'owner' }, async () => {
      // The "handler" — a stand-in for handleVisionJob, exercising the same
      // tenant-scoped storage call a real one would.
      const payload = job.payload as { sourceHash: string; storageKey: string }
      await writeFileAtomic('originals', payload.storageKey, Buffer.from(`bytes-for-${payload.sourceHash}`))
      return payload.storageKey
    })

    // Unwound the instant the handler returned — not leaked into the
    // worker's next loop iteration.
    expect(tryCurrentTenant()).toBeNull()

    queue.complete(job.id, 'sim-worker', {})
    return { tenantId: job.tenantId, wrote }
  }

  it('two tenants processing BYTE-IDENTICAL uploads in the same simulated worker loop get fully separate files', async () => {
    const a = createTestTenant('A')
    const b = createTestTenant('B')

    // Same storage key AND same source hash on purpose — this is exactly
    // the scenario where a context leak would be invisible (same key/bytes
    // either way) unless checked by actually reading back from the OTHER
    // tenant's own storage root.
    const key = 'ab/cd/samehash.jpg'
    queue.enqueue(a.tenantId, [{ kind: 'vision', payload: { imageId: 'ia', sourceHash: 'samehash', storageKey: key } }])
    queue.enqueue(b.tenantId, [{ kind: 'vision', payload: { imageId: 'ib', sourceHash: 'samehash', storageKey: key } }])

    const first = await runOneFake('vision')
    const second = await runOneFake('vision')

    expect(new Set([first.tenantId, second.tenantId])).toEqual(new Set([a.tenantId, b.tenantId]))

    // Both tenants' copies exist independently under their OWN root.
    const existsForA = await runWithTenant({ tenantId: a.tenantId, userId: 'u', role: 'owner' }, () =>
      mediaExists('originals', key)
    )
    const existsForB = await runWithTenant({ tenantId: b.tenantId, userId: 'u', role: 'owner' }, () =>
      mediaExists('originals', key)
    )
    expect(existsForA).toBe(true)
    expect(existsForB).toBe(true)
  })

  it('ten consecutive jobs alternating between two tenants never cross-contaminate context', async () => {
    const a = createTestTenant('A')
    const b = createTestTenant('B')

    for (let i = 0; i < 5; i++) {
      queue.enqueue(a.tenantId, [{ kind: 'vision', payload: { imageId: `a${i}`, sourceHash: `ha${i}`, storageKey: `k/a${i}.jpg` } }])
      queue.enqueue(b.tenantId, [{ kind: 'vision', payload: { imageId: `b${i}`, sourceHash: `hb${i}`, storageKey: `k/b${i}.jpg` } }])
    }

    const results = []
    for (let i = 0; i < 10; i++) {
      results.push(await runOneFake('vision'))
    }

    // Every job resolved to a real tenant, and reading each one's own file
    // back under its OWN tenant context succeeds — proves the binding held
    // for that specific job's write, not just "some" tenant.
    for (const r of results) {
      const content = await runWithTenant({ tenantId: r.tenantId, userId: 'u', role: 'owner' }, () =>
        readMedia('originals', r.wrote)
      )
      expect(content.toString()).toContain('bytes-for-')
    }
  })
})
