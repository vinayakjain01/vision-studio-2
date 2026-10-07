import { describe, it, expect } from 'vitest'
import { createTestTenant } from '../helpers/tenancy-fixture'
import { openTenantDbById, getControlDb, __openTenantHandleCount } from '@/db/client'
import * as queue from '@/jobs/queue'
import { config } from '@/config'

describe('worker process hygiene', () => {
  it('open tenant DB handles stay bounded by the LRU, even across many more tenants than the cap', () => {
    const CAP = 24 // matches MAX_OPEN_TENANT_HANDLES in src/db/client.ts
    const tenantIds: string[] = []
    for (let i = 0; i < CAP + 10; i++) {
      tenantIds.push(createTestTenant(`T${i}`).tenantId)
    }

    for (const id of tenantIds) {
      openTenantDbById(id)
    }

    expect(__openTenantHandleCount()).toBeLessThanOrEqual(CAP)

    // The most recently opened ones are still live (LRU keeps the newest).
    expect(() => openTenantDbById(tenantIds[tenantIds.length - 1])).not.toThrow()
  })

  it('job payloads carry only IDs and hashes — never a filesystem path', () => {
    const t = createTestTenant('T')
    const dataDir = config.paths.dataDir

    const { ids } = queue.enqueue(t.tenantId, [
      { kind: 'vision', payload: { imageId: 'img1', sourceHash: 'abc123', storageKey: 'ab/cd/abc123.jpg' } },
      {
        kind: 'render',
        payload: { imageId: 'img1', productId: 'prd1', templateId: 'tpl1', sourceHash: 'abc123' },
      },
      {
        kind: 'background_fill',
        payload: { imageId: 'img1', productId: 'prd1', templateId: 'tpl1', sourceHash: 'abc123' },
      },
    ])

    const rows = getControlDb()
      .prepare(`SELECT payload FROM jobs WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as { payload: string }[]

    for (const row of rows) {
      // Never the tenant's actual resolved data directory, and never
      // something that LOOKS like an absolute filesystem path — a storage
      // KEY (relative, content-addressed, resolved fresh by media-store.ts
      // from `currentTenant()` at read time) is fine and expected; a literal
      // path baked into the payload is exactly what P3's design note calls
      // out as the hazard payloads must never carry, since a worker
      // resolves everything through its OWN bound tenant context instead.
      expect(row.payload).not.toContain(dataDir)
      expect(row.payload).not.toMatch(/"[A-Za-z]:\\\\/) // Windows absolute path, e.g. "C:\\
      expect(row.payload).not.toMatch(/"\/(home|Users|tmp|var)\//) // POSIX absolute path
    }
  })
})
