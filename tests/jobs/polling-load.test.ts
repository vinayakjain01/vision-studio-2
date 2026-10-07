import { describe, it, expect } from 'vitest'
import { createTestTenant, cookieHeader } from '../helpers/tenancy-fixture'
import { makeRequest } from '../helpers/request'
import { runWithTenant } from '@/tenancy/context'
import { getControlDb } from '@/db/client'
import { migrateControl } from '@/db/migrate'
import * as queue from '@/jobs/queue'
import { GET as visionStatusGet } from '@/app/api/vision/status/route'

/**
 * P4 §6: "verify with ~20 simulated clients that the polling load on
 * control.db is small."
 *
 * Simulates 20 tenants (a realistic shape — in practice every polling
 * client IS a distinct tenant's browser tab) each polling their own status
 * endpoint several times in a row the way SWR's real `refreshInterval` loop
 * does: send whatever ETag the previous response returned, so a client
 * whose state hasn't changed gets a cheap 304. Two things are verified:
 * the underlying per-tenant query is an index seek (not a table scan, so
 * cost stays flat as the shared jobs table grows — see
 * `idx_jobs_tenant_claim`), and 100 total requests across 20 "clients"
 * complete fast enough that nothing here is doing real per-poll work once
 * state has settled.
 */
describe('polling load: ~20 simulated clients against shared control.db', () => {
  it('queue.stats(kind, tenantId) is an index seek, not a jobs table scan', () => {
    const db = getControlDb()
    migrateControl(db)
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT status, COUNT(*) AS n FROM jobs WHERE tenant_id = ? AND kind = ? GROUP BY status`
      )
      .all('any-tenant', 'vision') as { detail: string }[]
    const usesScan = plan.some(row => /SCAN jobs\b/.test(row.detail) && !/USING INDEX/.test(row.detail))
    expect(usesScan).toBe(false)
  })

  it('20 tenants x 5 polls each (100 requests), reusing ETags like real SWR polling, completes fast and mostly 304s', async () => {
    const CLIENT_COUNT = 20
    const POLLS_PER_CLIENT = 5

    const clients = Array.from({ length: CLIENT_COUNT }, (_, i) => createTestTenant(`PollClient${i}`))

    // Half the tenants have real pending work (so their status payload is
    // non-trivial and genuinely exercises the tenant-scoped queue query);
    // the rest are idle, which is the common case this endpoint sees most
    // of the time in practice.
    clients.slice(0, 10).forEach(tenant => {
      runWithTenant({ tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }, () => {
        queue.enqueue(tenant.tenantId, [
          { kind: 'vision', payload: { imageId: 'img-1', sourceHash: `h-${tenant.tenantId}`, storageKey: 'k' } },
        ])
      })
    })

    let total200 = 0
    let total304 = 0

    const start = Date.now()
    await Promise.all(
      clients.map(async tenant => {
        let etag: string | null = null
        for (let poll = 0; poll < POLLS_PER_CLIENT; poll++) {
          const response: Response = await (visionStatusGet as any)(
            makeRequest('http://localhost:3000/api/vision/status', {
              cookie: cookieHeader(tenant.sessionToken),
              headers: etag ? { 'if-none-match': etag } : undefined,
            })
          )
          if (response.status === 304) {
            total304++
          } else {
            total200++
            etag = response.headers.get('etag')
          }
        }
      })
    )
    const elapsedMs = Date.now() - start

    expect(total200 + total304).toBe(CLIENT_COUNT * POLLS_PER_CLIENT)
    // First poll per client is always a real 200 (no prior ETag); every
    // later poll against UNCHANGED state should be a cheap 304.
    expect(total200).toBe(CLIENT_COUNT)
    expect(total304).toBe(CLIENT_COUNT * (POLLS_PER_CLIENT - 1))

    // Very generous on purpose: the real regression guard against a full
    // table scan or an N+1 is the EXPLAIN QUERY PLAN assertion above, which
    // is environment-independent. This wall-clock check only catches a
    // gross blowup (e.g. minutes instead of ms) — under a full parallel
    // test-suite run, 20 fresh tenants each opening their own app.db file
    // for the first time already competes with dozens of other test files
    // for CPU and disk I/O, so a tight bound here would flake on load alone
    // rather than on an actual regression.
    expect(elapsedMs).toBeLessThan(20_000)
  })
})
