import fs from 'fs'
import crypto from 'crypto'
import sharp from 'sharp'
import { NextRequest } from 'next/server'
import { describe, it, expect } from 'vitest'
import { createTestTenant, cookieHeader, type TestTenant } from '../helpers/tenancy-fixture'
import { makeParams } from '../helpers/request'
import { runWithTenant } from '@/tenancy/context'
import { tenantTmpDir } from '@/storage/media-store'
import { imports } from '@/db/repositories'
import { POST as uploadPostImpl } from '@/app/api/imports/[importId]/files/route'

const uploadPost = uploadPostImpl as unknown as (...args: unknown[]) => Promise<Response>

/**
 * A hand-built multipart/form-data body, byte for byte, rather than letting
 * `new Request({ body: FormData })` auto-encode one — NextRequest's own
 * encoder in this test environment produced a stream busboy read as
 * truncated ("Unexpected end of form") every time, so the boundary and part
 * framing are constructed explicitly here instead, exactly matching what
 * `import-client.tsx`'s real browser request puts on the wire: one `files`
 * part immediately followed by its `paths` part, per file.
 */
function multipartRequest(
  cookie: string,
  files: { name: string; bytes: Buffer; relativePath: string; mimeType?: string }[]
): NextRequest {
  const boundary = '----visionStudioTestBoundary' + crypto.randomBytes(8).toString('hex')
  const parts: Buffer[] = []
  for (const f of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: ${f.mimeType ?? 'application/octet-stream'}\r\n\r\n`
      ),
      f.bytes,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="paths"\r\n\r\n${f.relativePath}\r\n`)
    )
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  const body = Buffer.concat(parts)

  return new NextRequest('http://localhost:3000/api/imports/x/files', {
    method: 'POST',
    headers: {
      cookie,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    body: new Uint8Array(body),
  })
}

async function setup(label: string): Promise<{ tenant: TestTenant; importId: string }> {
  const tenant = createTestTenant(label)
  const importId = await runWithTenant(
    { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' },
    async () => imports.create({ name: label }).id
  )
  return { tenant, importId }
}

function tmpDirFileCount(tenant: TestTenant): number {
  const dir = runWithTenant({ tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }, () =>
    tenantTmpDir()
  )
  if (!fs.existsSync(dir)) return 0
  return fs.readdirSync(dir).length
}

describe('streaming upload route', () => {
  it('a normal upload streams to temp, hashes while streaming, and ingests successfully', async () => {
    const { tenant, importId } = await setup('UploadOk')
    const photo = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#112233' } })
      .jpeg()
      .toBuffer()

    const request = multipartRequest(cookieHeader(tenant.sessionToken), [
      { name: 'photo.jpg', bytes: photo, relativePath: 'product-a/photo.jpg', mimeType: 'image/jpeg' },
    ])
    const res = await uploadPost(request, makeParams({ importId }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.summary.imported).toBe(1)

    // No leftover temp files — the successful file was moved (renamed) into
    // content-addressed storage, not left behind.
    expect(tmpDirFileCount(tenant)).toBe(0)
  })

  it('an oversized request is rejected and every temp file from it is cleaned up', async () => {
    const { tenant, importId } = await setup('UploadOversized')

    // Two real (small, valid) images whose COMBINED size is forced over
    // MAX_REQUEST_BYTES by padding — the route must destroy the stream
    // mid-parse once the cumulative total crosses the cap, not after
    // buffering everything first.
    const { MAX_REQUEST_BYTES } = await import('@/import/file-rules')
    const chunk = Buffer.alloc(Math.ceil(MAX_REQUEST_BYTES / 2) + 1024, 1)

    const request = multipartRequest(cookieHeader(tenant.sessionToken), [
      { name: 'a.jpg', bytes: chunk, relativePath: 'a.jpg', mimeType: 'image/jpeg' },
      { name: 'b.jpg', bytes: chunk, relativePath: 'b.jpg', mimeType: 'image/jpeg' },
    ])
    const res = await uploadPost(request, makeParams({ importId }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/exceeds.*MB/i)

    // Every temp file this request created (including the one still
    // mid-write when the abort happened) must be gone — never orphaned.
    expect(tmpDirFileCount(tenant)).toBe(0)
  })

  it('a decompression-bomb image is rejected cleanly (not a crash), and its temp file is cleaned up', async () => {
    const { tenant, importId } = await setup('UploadBomb')

    // A real PNG whose declared dimensions exceed MAX_INPUT_PIXELS but whose
    // actual compressed size is tiny — exactly the decompression-bomb shape:
    // sharp must reject this from the HEADER, never attempting to allocate
    // pixels for a 30,000 x 30,000 image.
    const bomb = await sharp({
      create: { width: 1, height: 1, channels: 3, background: '#000000' },
    })
      .png()
      .toBuffer()
    // Patch the PNG IHDR chunk's width/height fields directly to claim an
    // enormous declared size while keeping the actual pixel data (and so the
    // file's real byte size) tiny — IHDR is always the first chunk, at a
    // fixed offset right after the 8-byte PNG signature.
    const rigged = Buffer.from(bomb)
    rigged.writeUInt32BE(30000, 16) // width
    rigged.writeUInt32BE(30000, 20) // height

    const request = multipartRequest(cookieHeader(tenant.sessionToken), [
      { name: 'bomb.png', bytes: rigged, relativePath: 'bomb.png', mimeType: 'image/png' },
    ])
    const res = await uploadPost(request, makeParams({ importId }))
    expect(res.status).toBe(200) // the REQUEST succeeds — this one file just fails to ingest
    const body = await res.json()
    expect(body.summary.failed).toBe(1)
    expect(body.summary.imported).toBe(0)
    expect(body.results[0].outcome.status).toBe('failed')

    expect(tmpDirFileCount(tenant)).toBe(0)
  })
})
