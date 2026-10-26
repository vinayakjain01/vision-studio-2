import { describe, it, expect, beforeAll } from 'vitest'
import JSZip from 'jszip'
import { createTestTenant, cookieHeader, type TestTenant } from '../helpers/tenancy-fixture'
import { makeRequest, makeParams } from '../helpers/request'
import { runWithTenant } from '@/tenancy/context'
import { writeFileAtomic } from '@/storage/media-store'
import { imports, products, images, templates, batches, creatives } from '@/db/repositories'
import { createDefaultTemplate } from '@/templates/types'
import { GET as listGetImpl } from '@/app/api/creatives/route'
import { GET as downloadGetImpl } from '@/app/api/creatives/download/route'

const listGet = listGetImpl as unknown as (...args: unknown[]) => Promise<Response>
const downloadGet = downloadGetImpl as unknown as (...args: unknown[]) => Promise<Response>

/**
 * User request (2026-10-26): the Downloads page should group generated
 * images by master folder/sub-folder, with a dropdown to pick a master
 * folder, and download it as master-folder/sub-folder/original-file-name —
 * matching the structure the Products page already uses, not a flat
 * "download everything" button. `creatives.listByImport` (the join through
 * products this needs — creatives has no import_id of its own) is the new
 * piece; `?importId=` on both the list and download routes is the surface.
 */
describe('creatives scoped to one master folder (?importId=)', () => {
  let tenant: TestTenant
  let importAId: string
  let importAName: string
  let importBId: string
  let creativeA1Bytes: Buffer
  let creativeA2Bytes: Buffer
  let creativeBBytes: Buffer

  beforeAll(async () => {
    tenant = createTestTenant('ImportScopedCreatives')
    const ctx = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' as const }

    await runWithTenant(ctx, async () => {
      importAName = 'Men Catalogue'
      const impA = imports.create({ name: importAName })
      const impB = imports.create({ name: 'Other Catalogue' })
      importAId = impA.id
      importBId = impB.id

      const productA1 = products.upsert({
        importId: impA.id,
        name: 'Red Midi',
        slug: 'red-midi',
        folderPath: 'dresses/red-midi',
        category: 'dresses',
      })
      const productA2 = products.upsert({
        importId: impA.id,
        name: 'Blue Midi',
        slug: 'blue-midi',
        folderPath: 'dresses/blue-midi',
        category: 'dresses',
      })
      const productB = products.upsert({
        importId: impB.id,
        name: 'Other Look',
        slug: 'other-look',
        folderPath: 'other-look',
        category: null,
      })

      const template = templates.create({ name: 'T', document: createDefaultTemplate('4:5') })

      const makeImageAndCreative = async (
        product: typeof productA1,
        importId: string,
        hash: string,
        batchId: string | null
      ): Promise<Buffer> => {
        const image = images.create({
          productId: product.id,
          importId,
          sourceHash: hash,
          storageKey: `${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.jpg`,
          fileName: 'look-1.jpg',
          relativePath: `${product.folderPath}/look-1.jpg`,
          mimeType: 'image/jpeg',
          byteSize: 100,
          width: 100,
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
        const bytes = Buffer.from(`${hash}-bytes-` + 'x'.repeat(40))
        const storageKey = `${batchId ?? 'adhoc'}/${hash}.jpg`
        await writeFileAtomic('creatives', storageKey, bytes)
        creatives.put({
          productId: product.id,
          imageId: image.id,
          templateId: template.id,
          batchId,
          sourceHash: hash,
          visionId: null,
          storageKey,
          mimeType: 'image/jpeg',
          width: 1080,
          height: 1350,
          byteSize: bytes.byteLength,
          framing: null,
          renderMs: 10,
        })
        return bytes
      }

      const batch = batches.create('some-batch')
      // Two creatives in import A, deliberately in DIFFERENT batches (one in
      // a real batch, one ad hoc/no batch) — proves listByImport is NOT
      // batch-scoped, unlike listByBatch.
      creativeA1Bytes = await makeImageAndCreative(productA1, impA.id, 'a'.repeat(32), batch.id)
      creativeA2Bytes = await makeImageAndCreative(productA2, impA.id, 'b'.repeat(32), null)
      // One creative in a DIFFERENT import — must never appear when scoped to A.
      creativeBBytes = await makeImageAndCreative(productB, impB.id, 'c'.repeat(32), null)
    })
  })

  function list(importId: string): Promise<Response> {
    const request = makeRequest(`http://localhost:3000/api/creatives?importId=${importId}`, {
      cookie: cookieHeader(tenant.sessionToken),
    })
    return listGet(request, makeParams({}))
  }

  function download(importId: string): Promise<Response> {
    const request = makeRequest(`http://localhost:3000/api/creatives/download?importId=${importId}`, {
      cookie: cookieHeader(tenant.sessionToken),
    })
    return downloadGet(request, makeParams({}))
  }

  it('the list route returns only this import\'s creatives, across different batches, with folderPath', async () => {
    const res = await list(importAId)
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.total).toBe(2)
    const folders = body.creatives.map((c: { folderPath: string }) => c.folderPath).sort()
    expect(folders).toEqual(['dresses/blue-midi', 'dresses/red-midi'])
    expect(body.creatives.every((c: { id: string }) => c.id)).toBe(true)
  })

  it('the list route never leaks a different import\'s creative', async () => {
    const res = await list(importAId)
    const body = await res.json()
    expect(body.creatives.some((c: { productName: string }) => c.productName === 'Other Look')).toBe(false)
  })

  it('downloading by importId needs no explicit ?layout=catalog — it is always the catalog layout', async () => {
    const res = await download(importAId)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain(`${importAName}.zip`)

    const buffer = Buffer.from(await res.arrayBuffer())
    const zip = await JSZip.loadAsync(buffer)
    const names = Object.keys(zip.files).sort()
    expect(names).toEqual(['dresses/blue-midi/look-1.jpg', 'dresses/red-midi/look-1.jpg'])

    const redBytes = await zip.file('dresses/red-midi/look-1.jpg')!.async('nodebuffer')
    expect(redBytes.equals(creativeA1Bytes)).toBe(true)
    const blueBytes = await zip.file('dresses/blue-midi/look-1.jpg')!.async('nodebuffer')
    expect(blueBytes.equals(creativeA2Bytes)).toBe(true)
  })

  it('downloading by importId includes a creative with NO batch at all (not batch-scoped)', async () => {
    // creativeA2 above was created with batchId: null — its presence in the
    // previous test's zip already proves this, but assert it explicitly so
    // a future refactor that accidentally reintroduces batch-scoping fails
    // here directly rather than via an unrelated byte-comparison.
    const res = await download(importAId)
    const buffer = Buffer.from(await res.arrayBuffer())
    const zip = await JSZip.loadAsync(buffer)
    expect(zip.file('dresses/blue-midi/look-1.jpg')).not.toBeNull()
  })

  it('downloading by importId never includes a different import\'s creative', async () => {
    const res = await download(importAId)
    const buffer = Buffer.from(await res.arrayBuffer())
    const zip = await JSZip.loadAsync(buffer)
    expect(Object.keys(zip.files)).not.toContain('other-look/look-1.jpg')

    for (const entryName of Object.keys(zip.files)) {
      const bytes = await zip.file(entryName)!.async('nodebuffer')
      expect(bytes.equals(creativeBBytes)).toBe(false)
    }
  })

  it('the second import downloads its own single creative independently', async () => {
    const res = await download(importBId)
    expect(res.headers.get('content-disposition')).toContain('Other Catalogue.zip')
    const buffer = Buffer.from(await res.arrayBuffer())
    const zip = await JSZip.loadAsync(buffer)
    expect(Object.keys(zip.files)).toEqual(['other-look/look-1.jpg'])
  })
})
