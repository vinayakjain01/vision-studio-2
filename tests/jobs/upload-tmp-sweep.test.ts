import fs from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'
import { createTestTenant } from '../helpers/tenancy-fixture'
import { runWithTenant } from '@/tenancy/context'
import { tenantTmpDir, sweepStaleTmpFiles } from '@/storage/media-store'

/**
 * `sweepStaleTmpFiles` is the backstop for upload temp fragments left behind
 * by a crashed or killed request — the upload route's own `cleanupAll()`
 * only runs on a normal catch/finally path within that one request, so
 * anything orphaned outside that (a killed process, in particular) has no
 * other path to get removed.
 */
describe('sweepStaleTmpFiles', () => {
  it('removes files older than the TTL, keeps fresh ones, for the current tenant only', async () => {
    const tenant = createTestTenant('TmpSweep')
    const ctx = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' as const }

    const { oldPath, freshPath } = await runWithTenant(ctx, () => {
      const dir = tenantTmpDir()
      fs.mkdirSync(dir, { recursive: true })
      const oldPath = path.join(dir, 'upload-old.tmp')
      const freshPath = path.join(dir, 'upload-fresh.tmp')
      fs.writeFileSync(oldPath, 'stale fragment')
      fs.writeFileSync(freshPath, 'in-flight fragment')
      // Backdate the "old" file's mtime well past any reasonable TTL —
      // simulating a fragment left behind by a request that died hours ago.
      const longAgo = new Date(Date.now() - 10 * 60 * 60 * 1000)
      fs.utimesSync(oldPath, longAgo, longAgo)
      return { oldPath, freshPath }
    })

    const removed = await runWithTenant(ctx, () => sweepStaleTmpFiles(6 * 60 * 60 * 1000))

    expect(removed).toBe(1)
    expect(fs.existsSync(oldPath)).toBe(false)
    expect(fs.existsSync(freshPath)).toBe(true)
  })

  it('a tenant whose tmp/ directory does not exist sweeps to zero without throwing', async () => {
    const tenant = createTestTenant('TmpSweepEmpty')
    const ctx = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' as const }
    // ensureMediaRoots() (run by createTestTenant) already created tmp/ —
    // remove it to exercise the "doesn't exist" path explicitly.
    await runWithTenant(ctx, () => fs.rmSync(tenantTmpDir(), { recursive: true, force: true }))

    const removed = await runWithTenant(ctx, () => sweepStaleTmpFiles(1000))
    expect(removed).toBe(0)
  })
})
