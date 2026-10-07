/**
 * Benchmark: web-process peak RSS during a bulk ZIP download and a file
 * upload, against the process's own idle baseline — the concrete number P4's
 * streaming rewrite (busboy upload parsing, archiver + bounded concurrency
 * for ZIP) was done to make "roughly flat, not growing with batch size"
 * rather than just asserted.
 *
 * Each workload runs at two sizes 10x apart (30 vs 300 images; 10 vs 100
 * upload files) — a single absolute number can't show flatness on its own,
 * but if the RSS delta at 10x the batch size is nowhere near 10x the delta,
 * that's direct evidence peak memory is bounded by concurrency, not by batch
 * size.
 *
 *   npx tsx scripts/bench-memory.ts
 *   node --expose-gc -r tsx/cjs scripts/bench-memory.ts   # more stable baseline
 *
 * Runs both workloads IN-PROCESS (no real HTTP server) by calling the route
 * handlers directly — this is exactly the code path a real request runs
 * (same busboy parse, same archiver instance, same `withExportSlot`
 * conversions), just invoked without a socket in between. RSS is sampled on
 * an interval for the duration of each workload and the peak is reported
 * against an idle-baseline sample taken immediately before it starts.
 *
 * Never touches the real data/ directory — everything lives under a fresh
 * `fs.mkdtempSync` temp dir, removed at the end.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

process.env.VISION_STUDIO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-membench-'))
process.env.ADMIN_EMAIL = 'bench@test.local'
process.env.ADMIN_PASSWORD = 'bench-password'
process.env.ALLOW_MULTI_TENANT_PREVIEW = '1'

/** Samples process.memoryUsage().rss on an interval until `stop()` is called; returns the peak seen. */
function sampleRss(intervalMs = 25): { stop: () => number } {
  let peak = process.memoryUsage().rss
  const timer = setInterval(() => {
    const rss = process.memoryUsage().rss
    if (rss > peak) peak = rss
  }, intervalMs)
  timer.unref?.()
  return {
    stop: () => {
      clearInterval(timer)
      return peak
    },
  }
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1)
}

async function readWholeStream(body: ReadableStream<Uint8Array> | null): Promise<number> {
  if (!body) return 0
  const reader = body.getReader()
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
  }
  return total
}

function multipartBody(files: { name: string; bytes: Buffer; relativePath: string; mimeType: string }[]): {
  body: Buffer
  contentType: string
} {
  const boundary = '----visionStudioBenchBoundary' + crypto.randomBytes(8).toString('hex')
  const parts: Buffer[] = []
  for (const f of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: ${f.mimeType}\r\n\r\n`
      ),
      f.bytes,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="paths"\r\n\r\n${f.relativePath}\r\n`)
    )
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

async function main() {
  const sharp = (await import('sharp')).default
  const { getControlDb } = await import('../src/db/client')
  const { migrateControl, migrate } = await import('../src/db/migrate')
  const { tenants, memberships, users } = await import('../src/db/control-repositories')
  const { createSession } = await import('../src/auth/session')
  const { ensureMediaRoots, writeFileAtomic } = await import('../src/storage/media-store')
  const { openTenantDbById } = await import('../src/db/client')
  const { runWithTenant } = await import('../src/tenancy/context')
  const { imports, products, images, templates, batches, creatives } = await import('../src/db/repositories')
  const { createDefaultTemplate } = await import('../src/templates/types')
  const { config } = await import('../src/config')
  const { NextRequest } = await import('next/server')

  migrateControl(getControlDb())

  /**
   * A real, non-trivially-compressible JPEG — a solid-color `sharp({create})`
   * image (as other fixtures in this codebase use) packs down to ~1KB
   * regardless of dimensions, which understates real memory pressure. Random
   * pixel noise forces an honest, "real photo"-sized JPEG instead.
   */
  async function noisyJpeg(width: number, height: number): Promise<Buffer> {
    const raw = crypto.randomBytes(width * height * 3)
    return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 85 }).toBuffer()
  }

  console.log('Vision Studio — web-process memory benchmark')
  console.log(`  data dir  ${process.env.VISION_STUDIO_DATA_DIR}`)
  console.log(`  node      ${process.version}  (--expose-gc: ${typeof global.gc === 'function' ? 'yes' : 'no'})\n`)

  function makeTenant(name: string) {
    const tenant = tenants.create(name)
    ensureMediaRoots(tenant.id)
    const db = openTenantDbById(tenant.id)
    migrate(db)
    const user = users.create({ email: `${tenant.id}@bench.local`, passwordHash: 'unused' })
    memberships.create(user.id, tenant.id, 'owner')
    const { token } = createSession(user.id)
    return { tenantId: tenant.id, userId: user.id, token }
  }

  // ── Workload 1: bulk ZIP download, at two batch sizes ───────────────────
  // Run at 30 AND 300 images (a 10x spread) — the point isn't one absolute
  // number, it's whether the delta at 300 is anywhere near 10x the delta at
  // 30. If streaming + bounded concurrency is doing its job, it shouldn't be.
  async function runZipWorkload(creativeCount: number): Promise<{ deltaMB: number }> {
    const tenant = makeTenant(`bench-zip-${creativeCount}`)
    const photo = await noisyJpeg(400, 500)
    console.log(
      `Seeding ${creativeCount} creatives (~${mb(photo.byteLength * creativeCount)} MB of source JPEGs)...`
    )

    let batchId = ''
    await runWithTenant({ tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }, async () => {
      const imp = imports.create({ name: 'bench' })
      const template = templates.create({ name: 'T', document: createDefaultTemplate('4:5') })
      const batch = batches.create('bench-batch')
      batchId = batch.id
      for (let i = 0; i < creativeCount; i++) {
        const hash = `bench-hash-${i}-` + 'z'.repeat(10)
        const product = products.upsert({
          importId: imp.id,
          name: `Look ${i}`,
          slug: `look-${i}`,
          folderPath: `bench/look-${i}`,
          category: null,
        })
        const image = images.create({
          productId: product.id,
          importId: imp.id,
          sourceHash: hash,
          storageKey: `bb/bb/${hash}.jpg`,
          fileName: `photo-${i}.jpg`,
          relativePath: `bench/look-${i}/photo-${i}.jpg`,
          mimeType: 'image/jpeg',
          byteSize: photo.byteLength,
          width: 400,
          height: 500,
          exifOrientation: null,
          hasAlpha: false,
          colorSpace: 'srgb',
          capturedAt: null,
          cameraMake: null,
          cameraModel: null,
          position: 0,
          isPrimary: true,
        })
        await writeFileAtomic('creatives', `${batch.id}/${i}.jpg`, photo)
        creatives.put({
          productId: product.id,
          imageId: image.id,
          templateId: template.id,
          batchId: batch.id,
          sourceHash: hash,
          visionId: null,
          storageKey: `${batch.id}/${i}.jpg`,
          mimeType: 'image/jpeg',
          width: 400,
          height: 500,
          byteSize: photo.byteLength,
          framing: null,
          renderMs: 1,
        })
      }
    })

    const { GET: downloadGet } = await import('../src/app/api/creatives/download/route')

    global.gc?.()
    await new Promise(r => setTimeout(r, 50))
    const baseline = process.memoryUsage().rss
    const sampler = sampleRss()

    const request = new NextRequest(`http://localhost:3000/api/creatives/download?batchId=${batchId}`, {
      headers: { cookie: `${config.auth.sessionCookieName}=${tenant.token}` },
    })
    const start = Date.now()
    const response = (await (downloadGet as any)(request, { params: Promise.resolve({}) })) as Response
    const totalBytes = await readWholeStream(response.body)
    const elapsedMs = Date.now() - start

    const peak = sampler.stop()
    const deltaMB = (peak - baseline) / 1024 / 1024
    console.log(`${creativeCount}-image bulk ZIP download:`)
    console.log(`  status           ${response.status}`)
    console.log(`  output bytes     ${mb(totalBytes)} MB`)
    console.log(`  elapsed          ${elapsedMs}ms`)
    console.log(`  baseline RSS     ${mb(baseline)} MB`)
    console.log(`  peak RSS         ${mb(peak)} MB`)
    console.log(`  delta            ${deltaMB.toFixed(1)} MB\n`)
    return { deltaMB }
  }

  const zipSmall = await runZipWorkload(30)
  const zipLarge = await runZipWorkload(300)
  const zipGrowth = zipLarge.deltaMB / Math.max(zipSmall.deltaMB, 0.1)
  console.log(
    `ZIP memory growth 30→300 images (10x batch size): ${zipGrowth.toFixed(2)}x RSS delta ` +
      `(${zipGrowth < 3 ? 'roughly flat ✓' : 'growing with batch size ✗'})\n`
  )

  // ── Workload 2: upload, at two batch sizes ──────────────────────────────
  async function runUploadWorkload(fileCount: number): Promise<{ deltaMB: number }> {
    const tenant = makeTenant(`bench-upload-${fileCount}`)
    const photo = await noisyJpeg(300, 400)

    let importId = ''
    await runWithTenant({ tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }, async () => {
      importId = imports.create({ name: 'bench-upload' }).id
    })

    console.log(`Building a ${fileCount}-file multipart body (~${mb(photo.byteLength * fileCount)} MB)...`)
    const files = Array.from({ length: fileCount }, (_, i) => ({
      name: `photo-${i}.jpg`,
      bytes: photo,
      relativePath: `product-${i}/photo-${i}.jpg`,
      mimeType: 'image/jpeg',
    }))
    const { body, contentType } = multipartBody(files)

    const { POST: uploadPost } = await import('../src/app/api/imports/[importId]/files/route')

    global.gc?.()
    await new Promise(r => setTimeout(r, 50))
    const baseline = process.memoryUsage().rss
    const sampler = sampleRss()

    const request = new NextRequest(`http://localhost:3000/api/imports/${importId}/files`, {
      method: 'POST',
      headers: { cookie: `${config.auth.sessionCookieName}=${tenant.token}`, 'content-type': contentType },
      body: new Uint8Array(body),
    })
    const start = Date.now()
    const response = (await (uploadPost as any)(request, { params: Promise.resolve({ importId }) })) as Response
    const result = await response.json()
    const elapsedMs = Date.now() - start

    const peak = sampler.stop()
    const deltaMB = (peak - baseline) / 1024 / 1024
    console.log(`${fileCount}-file upload:`)
    console.log(`  status           ${response.status}`)
    console.log(`  summary          ${JSON.stringify(result.summary)}`)
    console.log(`  elapsed          ${elapsedMs}ms`)
    console.log(`  baseline RSS     ${mb(baseline)} MB`)
    console.log(`  peak RSS         ${mb(peak)} MB`)
    console.log(`  delta            ${deltaMB.toFixed(1)} MB\n`)
    return { deltaMB }
  }

  const uploadSmall = await runUploadWorkload(10)
  const uploadLarge = await runUploadWorkload(100)
  const uploadGrowth = uploadLarge.deltaMB / Math.max(uploadSmall.deltaMB, 0.1)
  console.log(
    `Upload memory growth 10→100 files (10x batch size): ${uploadGrowth.toFixed(2)}x RSS delta ` +
      `(${uploadGrowth < 3 ? 'roughly flat ✓' : 'growing with batch size ✗'})\n`
  )

  // The upload workload's `ingestFiles` call enqueues vision jobs, which
  // wakes the (singleton, web-process) worker pool — real child processes
  // that hold their own file handles. Both must be torn down before the temp
  // dir can be removed on Windows, where an open handle makes `unlink` fail.
  const { getPool } = await import('../src/jobs/pool')
  const { closeDb } = await import('../src/db/client')
  await getPool().stop()
  closeDb()

  fs.rmSync(process.env.VISION_STUDIO_DATA_DIR!, { recursive: true, force: true })
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
