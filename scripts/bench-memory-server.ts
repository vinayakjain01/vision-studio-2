/**
 * Upload-memory benchmark — SERVER half.
 *
 * Runs the real upload route handler behind a plain `http.Server`, in its
 * OWN OS process — the previous version of this benchmark
 * (`scripts/bench-memory.ts`) called the route handler directly from the
 * same script that also built the multipart request bodies, so the
 * "baseline"/"peak" RSS numbers it reported included the load generator's
 * own buffers (the in-memory multipart body, the fixture JPEGs) alongside
 * the server's. This version has no such contamination: the client
 * (`bench-memory-client.ts`) is a SEPARATE process that only ever talks to
 * this one over a real HTTP socket.
 *
 * Must run with `--expose-gc` so `/mem/settled` can force a real collection
 * before reporting — see package.json's `bench:memory` script.
 *
 *   node --expose-gc -r tsx/cjs scripts/bench-memory-server.ts
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { Readable } from 'stream'

process.env.VISION_STUDIO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-upload-bench-'))
process.env.ADMIN_EMAIL = 'bench@test.local'
process.env.ADMIN_PASSWORD = 'bench-password'
process.env.ALLOW_MULTI_TENANT_PREVIEW = '1'

const PORT = Number(process.env.BENCH_PORT ?? 4851)

async function main() {
  const { getControlDb, closeDb } = await import('../src/db/client')
  const { migrateControl, migrate } = await import('../src/db/migrate')
  const { tenants, memberships, users } = await import('../src/db/control-repositories')
  const { createSession } = await import('../src/auth/session')
  const { ensureMediaRoots } = await import('../src/storage/media-store')
  const { openTenantDbById } = await import('../src/db/client')
  const { runWithTenant } = await import('../src/tenancy/context')
  const { imports } = await import('../src/db/repositories')
  const { NextRequest } = await import('next/server')
  const { POST: uploadPost } = await import('../src/app/api/imports/[importId]/files/route')

  migrateControl(getControlDb())

  const tenant = tenants.create('upload-bench')
  ensureMediaRoots(tenant.id)
  const db = openTenantDbById(tenant.id)
  migrate(db)
  const user = users.create({ email: 'bench-upload@test.local', passwordHash: 'unused' })
  memberships.create(user.id, tenant.id, 'owner')
  const { token } = createSession(user.id)

  const importId = await runWithTenant(
    { tenantId: tenant.id, userId: user.id, role: 'owner' },
    async () => imports.create({ name: 'bench-upload' }).id
  )

  if (typeof global.gc !== 'function') {
    console.error('FATAL: this server must run with --expose-gc (see package.json bench:memory script)')
    process.exit(1)
  }

  let peakRss = process.memoryUsage().rss
  setInterval(() => {
    const rss = process.memoryUsage().rss
    if (rss > peakRss) peakRss = rss
  }, 10).unref()

  const uploadPath = `/api/imports/${importId}/files`

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/setup-info' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ importId, token, tenantId: tenant.id }))
        return
      }

      if (req.url === '/mem/reset-peak' && req.method === 'POST') {
        peakRss = process.memoryUsage().rss
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }

      if (req.url === '/mem/peak' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ peakRss }))
        return
      }

      if (req.url?.startsWith('/mem/settled') && req.method === 'GET') {
        const wantGc = new URL(req.url, 'http://x').searchParams.get('gc') === '1'
        if (wantGc) {
          // One pass can leave a second generation uncollected right after a
          // burst of allocation; two passes back to back gives V8's GC a
          // realistic chance to fully settle before this reads memory.
          global.gc!()
          await new Promise(r => setTimeout(r, 50))
          global.gc!()
          await new Promise(r => setTimeout(r, 50))
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(process.memoryUsage()))
        return
      }

      if (req.url === '/mem/heap-snapshot' && req.method === 'POST') {
        const v8 = await import('v8')
        const label = new URL(req.url, 'http://x').searchParams.get('label') ?? 'snapshot'
        const snapshotPath = path.join(process.env.VISION_STUDIO_DATA_DIR!, `${label}.heapsnapshot`)
        await new Promise<void>((resolve, reject) => {
          const stream = v8.getHeapSnapshot()
          const out = fs.createWriteStream(snapshotPath)
          stream.pipe(out)
          out.on('finish', () => resolve())
          out.on('error', reject)
        })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ path: snapshotPath }))
        return
      }

      if (req.url === uploadPath && req.method === 'POST') {
        const webBody = Readable.toWeb(req) as ReadableStream<Uint8Array>
        const headers = new Headers()
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers.set(key, value)
          else if (Array.isArray(value)) headers.set(key, value.join(', '))
        }
        const nextReq = new NextRequest(`http://127.0.0.1:${PORT}${uploadPath}`, {
          method: 'POST',
          headers,
          body: webBody,
          duplex: 'half',
        } as any)

        const response = await (uploadPost as any)(nextReq, { params: Promise.resolve({ importId }) })
        const buf = Buffer.from(await response.arrayBuffer())
        const outHeaders: Record<string, string> = {}
        response.headers.forEach((v: string, k: string) => {
          outHeaders[k] = v
        })
        res.writeHead(response.status, outHeaders)
        res.end(buf)
        return
      }

      res.writeHead(404)
      res.end()
    } catch (err) {
      console.error('[bench-server] request failed:', err)
      res.writeHead(500)
      res.end(String(err))
    }
  })

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`BENCH_SERVER_READY port=${PORT} dataDir=${process.env.VISION_STUDIO_DATA_DIR}`)
  })

  const shutdown = async () => {
    server.close()
    const { getPool } = await import('../src/jobs/pool')
    await getPool().stop()
    closeDb()
    fs.rmSync(process.env.VISION_STUDIO_DATA_DIR!, { recursive: true, force: true })
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
