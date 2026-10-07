import sharp from 'sharp'
import { describe, it, expect, beforeAll } from 'vitest'
import { createTestTenant, cookieHeader, type TestTenant } from '../helpers/tenancy-fixture'
import { makeRequest, makeParams } from '../helpers/request'
import { runWithTenant } from '@/tenancy/context'
import { writeFileAtomic } from '@/storage/media-store'
import { imports, products, images, templates, batches, creatives } from '@/db/repositories'
import { createDefaultTemplate } from '@/templates/types'
import { __exportConcurrencySnapshot } from '@/render/export-concurrency'
import { GET as downloadGetImpl } from '@/app/api/creatives/download/route'

const downloadGet = downloadGetImpl as unknown as (...args: unknown[]) => Promise<Response>

/**
 * Proves the ZIP route's `ReadableStream.cancel()` path — which fires when a
 * client disconnects mid-download — actually releases every export
 * concurrency slot it acquired, rather than leaking them (which would slowly
 * starve every other tenant's exports, since `withExportSlot`'s limiters are
 * process-wide). Uses enough creatives, each requiring a REAL format
 * conversion (forcing actual sharp work, not a passthrough no-op), that
 * cancelling right after the first streamed chunk reliably lands while most
 * of the batch is still unconverted.
 */
describe('bulk ZIP download: client disconnect releases concurrency slots', () => {
  let tenant: TestTenant
  let batchId: string
  const CREATIVE_COUNT = 50

  beforeAll(async () => {
    tenant = createTestTenant('ZipDisconnect')
    const ctx = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' as const }

    const photo = await sharp({ create: { width: 120, height: 150, channels: 3, background: '#405060' } })
      .jpeg()
      .toBuffer()

    await runWithTenant(ctx, async () => {
      const imp = imports.create({ name: 'Disconnect' })
      const template = templates.create({ name: 'T', document: createDefaultTemplate('4:5') })
      const batch = batches.create('disconnect-batch')
      batchId = batch.id

      for (let i = 0; i < CREATIVE_COUNT; i++) {
        const hash = `disco-hash-${i}-` + 'z'.repeat(10)
        const product = products.upsert({
          importId: imp.id,
          name: `Look ${i}`,
          slug: `look-${i}`,
          folderPath: `Disconnect/look-${i}`,
          category: null,
        })
        const image = images.create({
          productId: product.id,
          importId: imp.id,
          sourceHash: hash,
          storageKey: `dd/dd/${hash}.jpg`,
          fileName: `photo-${i}.jpg`,
          relativePath: `Disconnect/look-${i}/photo-${i}.jpg`,
          mimeType: 'image/jpeg',
          byteSize: photo.byteLength,
          width: 120,
          height: 150,
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
          width: 120,
          height: 150,
          byteSize: photo.byteLength,
          framing: null,
          renderMs: 1,
        })
      }
    })
  })

  it('stops converting and releases every acquired slot once the client disconnects', async () => {
    // format=png forces every entry through a REAL sharp conversion — a
    // plain download would short-circuit as a byte-identical passthrough,
    // which runs fast enough that there would be nothing left in flight to
    // cancel.
    const request = makeRequest(
      `http://localhost:3000/api/creatives/download?batchId=${batchId}&format=png`,
      { cookie: cookieHeader(tenant.sessionToken) }
    )
    const response = await downloadGet(request, makeParams({}))
    expect(response.status).toBe(200)
    expect(response.body).not.toBeNull()

    const reader = response.body!.getReader()
    // Read exactly one chunk — proof the archive has started streaming,
    // i.e. at least one (but, given 50 entries, almost certainly not all)
    // conversions have started — then disconnect, exactly like a client
    // closing the tab mid-download.
    await reader.read()
    await reader.cancel()

    // Give any conversions that were already in flight at the moment of
    // cancellation a chance to finish (and release) — `aborted` only stops
    // NEW ones from starting, it can't interrupt one already running.
    await new Promise(resolve => setTimeout(resolve, 300))

    const snapshot = __exportConcurrencySnapshot(tenant.tenantId)
    expect(snapshot.global).toBe(0)
    expect(snapshot.tenant).toBe(0)
  })
})
