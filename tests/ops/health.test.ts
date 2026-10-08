import '../helpers/tenant-env'

import fs from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'
import { makeRequest } from '../helpers/request'
import { config } from '@/config'
import { GET as healthGet } from '@/app/api/health/route'

const health = healthGet as unknown as (...args: unknown[]) => Promise<Response>

describe('GET /api/health', () => {
  it('returns {status: "ok"} with no counts or detail when the control.db and data dir are writable', async () => {
    const res = await health(makeRequest('http://localhost:3000/api/health'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ status: 'ok' })
  })

  it('returns 503 {status: "error"} when the data directory is not writable', async () => {
    // A FILE where the data dir is expected to be a directory is a
    // reliable, cross-platform (including Windows) way to make writes to
    // it fail with ENOTDIR — simulating a read-only/broken mount without
    // needing real filesystem permission changes.
    const brokenDataDir = path.join(config.paths.dataDir, '..', `broken-data-dir-as-file-${process.pid}`)
    fs.writeFileSync(brokenDataDir, 'not a directory')
    const original = config.paths.dataDir
    ;(config.paths as any).dataDir = brokenDataDir

    try {
      const res = await health(makeRequest('http://localhost:3000/api/health'))
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body).toEqual({ status: 'error' })
    } finally {
      ;(config.paths as any).dataDir = original
      fs.rmSync(brokenDataDir, { force: true })
    }
  })
})
