import JSZip from 'jszip'
import { describe, it, expect, beforeAll } from 'vitest'
import { createTestTenant, cookieHeader, type TestTenant } from '../helpers/tenancy-fixture'
import { makeRequest, makeParams } from '../helpers/request'
import { runWithTenant } from '@/tenancy/context'
import { writeFileAtomic } from '@/storage/media-store'
import { imports, products, images, templates, batches, creatives } from '@/db/repositories'
import { createDefaultTemplate } from '@/templates/types'
import { GET as downloadGetImpl } from '@/app/api/creatives/download/route'

const downloadGet = downloadGetImpl as unknown as (...args: unknown[]) => Promise<Response>

/**
 * Proves the real-streaming rewrite (archiver, bounded concurrency) produces
 * the exact same archive a caller cares about — same entry names, same
 * bytes, same folder structure — as the old buffer-everything JSZip
 * version it replaced. Entry BYTES are checked directly against the
 * creative's own stored bytes (no export options = passthrough, so they
 * must be byte-identical); entry NAMES are checked against the documented
 * naming rules (catalogPath/safeName/safeSegment/dedupe), which were copied
 * unchanged from the old implementation into the new one.
 */
async function readZip(response: Response): Promise<JSZip> {
  expect(response.status).toBe(200)
  const buffer = Buffer.from(await response.arrayBuffer())
  return JSZip.loadAsync(buffer)
}

describe('bulk ZIP download: streaming rewrite regression', () => {
  let tenant: TestTenant
  let importName: string
  let productAHash: string
  let productBHash: string
  let batchId: string
  let creativeABytes: Buffer
  let creativeBBytes: Buffer

  beforeAll(async () => {
    tenant = createTestTenant('ZipRegression')
    const ctx = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' as const }

    await runWithTenant(ctx, async () => {
      importName = 'Men Catalogue'
      const imp = imports.create({ name: importName })

      const productA = products.upsert({
        importId: imp.id,
        name: 'Red Midi',
        slug: 'red-midi',
        folderPath: `${importName}/dresses/red-midi`,
        category: 'dresses',
      })
      const productB = products.upsert({
        importId: imp.id,
        name: 'Blue Midi',
        slug: 'blue-midi',
        folderPath: `${importName}/dresses/blue-midi`,
        category: 'dresses',
      })

      productAHash = 'hash-a-' + 'a'.repeat(10)
      productBHash = 'hash-b-' + 'b'.repeat(10)

      const imageA = images.create({
        productId: productA.id,
        importId: imp.id,
        sourceHash: productAHash,
        storageKey: `aa/aa/${productAHash}.jpg`,
        fileName: 'look-1.jpg',
        relativePath: `${importName}/dresses/red-midi/look-1.jpg`,
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
      const imageB = images.create({
        productId: productB.id,
        importId: imp.id,
        sourceHash: productBHash,
        storageKey: `bb/bb/${productBHash}.jpg`,
        fileName: 'look-1.jpg',
        relativePath: `${importName}/dresses/blue-midi/look-1.jpg`,
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

      const template = templates.create({ name: 'T', document: createDefaultTemplate('4:5') })
      const batch = batches.create('regression-batch')
      batchId = batch.id

      creativeABytes = Buffer.from('creative-A-bytes-' + 'x'.repeat(50))
      creativeBBytes = Buffer.from('creative-B-bytes-' + 'y'.repeat(50))

      await writeFileAtomic('creatives', `${batch.id}/a.jpg`, creativeABytes)
      await writeFileAtomic('creatives', `${batch.id}/b.jpg`, creativeBBytes)

      creatives.put({
        productId: productA.id,
        imageId: imageA.id,
        templateId: template.id,
        batchId: batch.id,
        sourceHash: productAHash,
        visionId: null,
        storageKey: `${batch.id}/a.jpg`,
        mimeType: 'image/jpeg',
        width: 1080,
        height: 1350,
        byteSize: creativeABytes.byteLength,
        framing: null,
        renderMs: 10,
      })
      creatives.put({
        productId: productB.id,
        imageId: imageB.id,
        templateId: template.id,
        batchId: batch.id,
        sourceHash: productBHash,
        visionId: null,
        storageKey: `${batch.id}/b.jpg`,
        mimeType: 'image/jpeg',
        width: 1080,
        height: 1350,
        byteSize: creativeBBytes.byteLength,
        framing: null,
        renderMs: 10,
      })
    })
  })

  async function download(query: string): Promise<Response> {
    const request = makeRequest(`http://localhost:3000/api/creatives/download?${query}`, {
      cookie: cookieHeader(tenant.sessionToken),
    })
    return downloadGet(request, makeParams({}))
  }

  it('default (template-grouped) layout: <template>/<product>.jpg, byte-identical content', async () => {
    const res = await download(`batchId=${batchId}`)
    expect(res.headers.get('content-type')).toBe('application/zip')
    expect(res.headers.get('content-disposition')).toContain('vision-studio-regression-batch.zip')

    const zip = await readZip(res)
    const names = Object.keys(zip.files).sort()
    // safeName() replaces spaces (and several other characters) with
    // hyphens — "Red Midi" -> "Red-Midi" is the documented, correct
    // behavior for this layout, not a bug.
    expect(names).toEqual(['T/Red-Midi.jpg', 'T/Blue-Midi.jpg'].sort())

    const bytesA = await zip.file('T/Red-Midi.jpg')!.async('nodebuffer')
    const bytesB = await zip.file('T/Blue-Midi.jpg')!.async('nodebuffer')
    expect(bytesA.equals(creativeABytes)).toBe(true)
    expect(bytesB.equals(creativeBBytes)).toBe(true)
  })

  it('catalog layout: <product folder>/<original filename>, import name stripped from internal paths and used as the zip filename', async () => {
    const res = await download(`batchId=${batchId}&layout=catalog`)
    expect(res.headers.get('content-disposition')).toContain(`${importName}.zip`)

    const zip = await readZip(res)
    const names = Object.keys(zip.files).sort()
    expect(names).toEqual(
      ['dresses/red-midi/look-1.jpg', 'dresses/blue-midi/look-1.jpg'].sort()
    )
  })

  it('product-scoped layout: flat, original filename, zip named after the product', async () => {
    const productId = (
      await runWithTenant({ tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }, () =>
        Promise.resolve(creatives.list(100, 0).find(c => c.sourceHash === productAHash))
      )
    )!.productId

    const res = await download(`productId=${productId}`)
    expect(res.headers.get('content-disposition')).toContain('Red Midi.zip')

    const zip = await readZip(res)
    expect(Object.keys(zip.files)).toEqual(['look-1.jpg'])
    const bytes = await zip.file('look-1.jpg')!.async('nodebuffer')
    expect(bytes.equals(creativeABytes)).toBe(true)
  })

  it('an export option (format conversion) still produces correctly-named, converted entries', async () => {
    // Real conversion means sharp must actually decode these bytes — unlike
    // the passthrough tests above, plain text fixtures won't do here.
    const sharp = (await import('sharp')).default
    const realJpeg = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#80a0c0' } })
      .jpeg()
      .toBuffer()

    const realTenant = createTestTenant('ZipFormatConvert')
    let realBatchId = ''
    await runWithTenant({ tenantId: realTenant.tenantId, userId: realTenant.userId, role: 'owner' }, async () => {
      const imp = imports.create({ name: 'fmt' })
      const product = products.upsert({ importId: imp.id, name: 'Only Look', slug: 'p', folderPath: 'p', category: null })
      const image = images.create({
        productId: product.id,
        importId: imp.id,
        sourceHash: 'fmthash',
        storageKey: 'ff/ff/fmthash.jpg',
        fileName: 'photo.jpg',
        relativePath: 'p/photo.jpg',
        mimeType: 'image/jpeg',
        byteSize: realJpeg.byteLength,
        width: 20,
        height: 20,
        exifOrientation: null,
        hasAlpha: false,
        colorSpace: 'srgb',
        capturedAt: null,
        cameraMake: null,
        cameraModel: null,
        position: 0,
        isPrimary: true,
      })
      const template = templates.create({ name: 'T2', document: createDefaultTemplate('4:5') })
      const batch = batches.create('fmt-batch')
      realBatchId = batch.id
      await writeFileAtomic('creatives', `${batch.id}/only.jpg`, realJpeg)
      creatives.put({
        productId: product.id,
        imageId: image.id,
        templateId: template.id,
        batchId: batch.id,
        sourceHash: 'fmthash',
        visionId: null,
        storageKey: `${batch.id}/only.jpg`,
        mimeType: 'image/jpeg',
        width: 20,
        height: 20,
        byteSize: realJpeg.byteLength,
        framing: null,
        renderMs: 1,
      })
    })

    const request = makeRequest(`http://localhost:3000/api/creatives/download?batchId=${realBatchId}&format=png`, {
      cookie: cookieHeader(realTenant.sessionToken),
    })
    const res = await downloadGet(request, makeParams({}))
    const zip = await readZip(res)
    const names = Object.keys(zip.files)
    // Extension reflects the requested format even though the stored
    // creative is a .jpg — exactly the naming-pass logic that infers the
    // extension from exportOptions without needing to convert first.
    expect(names).toEqual(['T2/Only-Look.png'])

    const pngBytes = await zip.file('T2/Only-Look.png')!.async('nodebuffer')
    expect(pngBytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a') // PNG magic bytes
  })

  it('rejects with 400 before streaming starts when every creative file is missing from disk', async () => {
    const ghostTenant = createTestTenant('ZipGhost')
    await runWithTenant(
      { tenantId: ghostTenant.tenantId, userId: ghostTenant.userId, role: 'owner' },
      async () => {
        const imp = imports.create({ name: 'ghost' })
        const product = products.upsert({ importId: imp.id, name: 'p', slug: 'p', folderPath: 'p', category: null })
        const image = images.create({
          productId: product.id,
          importId: imp.id,
          sourceHash: 'ghosthash',
          storageKey: 'gg/gg/ghosthash.jpg',
          fileName: 'photo.jpg',
          relativePath: 'p/photo.jpg',
          mimeType: 'image/jpeg',
          byteSize: 10,
          width: 10,
          height: 10,
          exifOrientation: null,
          hasAlpha: false,
          colorSpace: 'srgb',
          capturedAt: null,
          cameraMake: null,
          cameraModel: null,
          position: 0,
          isPrimary: true,
        })
        const template = templates.create({ name: 'T', document: createDefaultTemplate('4:5') })
        // Row exists, but no file was ever written for it — the gap this
        // test exercises.
        creatives.put({
          productId: product.id,
          imageId: image.id,
          templateId: template.id,
          batchId: null,
          sourceHash: 'ghosthash',
          visionId: null,
          storageKey: 'nonexistent/ghost.jpg',
          mimeType: 'image/jpeg',
          width: 10,
          height: 10,
          byteSize: 0,
          framing: null,
          renderMs: 0,
        })
      }
    )

    const request = makeRequest('http://localhost:3000/api/creatives/download', {
      cookie: cookieHeader(ghostTenant.sessionToken),
    })
    const res = await downloadGet(request, makeParams({}))
    expect(res.status).toBe(400)
  })
})
