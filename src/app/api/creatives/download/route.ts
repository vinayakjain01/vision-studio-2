/**
 * Download creatives as a ZIP.
 *
 * Two layouts, chosen by `?layout=`:
 *
 *  - default: `<template>/<product>.<ext>` - filenames built from internal
 *    labels, grouped by template. The original behaviour, unchanged, still
 *    what "Downloads" and the per-product/per-batch links use.
 *  - `catalog`: `<product folder>/<original filename>.<ext>` - the source
 *    image's own import path with the import's own root folder stripped
 *    off (that name becomes the ZIP FILE's own filename instead, see
 *    below), nesting otherwise preserved, extension swapped for whatever
 *    the render actually produced. For the Products page's bulk
 *    generate-then-download flow, where the whole point is handing back a
 *    folder structure that matches the catalog as it was imported, not one
 *    that reveals anything about this app.
 *
 * The catalog layout also names the downloaded ZIP FILE itself after the
 * import it came from ("Men Catalogue.zip"), not a batch label. Both halves
 * matter together: if the import's name were left as a leading folder
 * INSIDE the archive as well as being the file's own name, extracting would
 * double it up - "Men Catalogue/Men Catalogue/MADA-01/...". Stripping it
 * from the internal paths and moving it to the filename is what makes
 * Explorer's "Extract All" (which always wraps in a folder named after the
 * zip) land on the right structure with exactly one level of nesting.
 *
 * Streamed rather than buffered. A catalog's worth of 2048px JPEGs is hundreds of
 * megabytes, and holding that in memory to set a Content-Length would risk the
 * server for no benefit.
 *
 * Compression is disabled deliberately: JPEG is already compressed, so deflate
 * costs CPU proportional to the archive size and saves almost nothing.
 */

import { NextRequest, NextResponse } from 'next/server'
import JSZip from 'jszip'
import { creatives, images, imports, products, templates, batches } from '@/db/repositories'
import { readMedia } from '@/storage/media-store'
import { handler, badRequest } from '@/lib/api'

export const dynamic = 'force-dynamic'
export const maxDuration = 600

/** Make a string safe for a filename on Windows, macOS and Linux alike. */
function safeName(value: string): string {
  return (
    value
      .replace(/[<>:"/\\|?* -]/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 80) || 'untitled'
  )
}

/**
 * Sanitize one path segment (or a whole filename) for the catalog layout -
 * deliberately gentler than safeName() above. That one kebab-cases
 * everything (spaces become hyphens), which is fine for a name built out of
 * internal labels but wrong here: the whole point of the catalog layout is
 * that names match the import exactly - "Men Catalogue", not
 * "Men-Catalogue". Only characters actually illegal in a path segment on
 * Windows, macOS or Linux get replaced; space, hyphen, case and punctuation
 * all pass through.
 */
function safeSegment(value: string): string {
  const illegal = ['<', '>', ':', '"', '/', '\\', '|', '?', '*']
  let out = value
  for (const ch of illegal) out = out.split(ch).join('_')
  out = out.replace(/^[\s.]+|[\s.]+$/g, '')
  return out || 'untitled'
}

/**
 * The catalog-layout path for one creative, WITHOUT the import's own root
 * folder - that name becomes the zip file's own filename instead (built
 * further down), so repeating it inside the archive would double-nest on
 * extraction. relativePath is exactly what was uploaded - "Men Catalogue/
 * MADA-01/look-1.jpg" - captured once at import time (see
 * groupIntoProducts in src/import/file-rules.ts) and never rewritten; this
 * strips only the leading segment that matches the import's own name and
 * keeps everything after it, nesting included.
 */
function catalogPath(relativePath: string, extension: string, importName: string | null): string {
  let segments = relativePath.split('/').filter(Boolean)
  if (importName && segments[0] === importName) segments = segments.slice(1)
  if (segments.length === 0) return `untitled.${extension}`
  const baseName = segments[segments.length - 1].replace(/\.[^./]+$/, '') || 'untitled'
  const dirs = segments.slice(0, -1).map(safeSegment)
  return [...dirs, `${safeSegment(baseName)}.${extension}`].join('/')
}

/**
 * Append -2, -3, etc. to a path already taken inside this archive - several
 * creatives can legitimately want the same name (two templates rendered
 * against the same source photo, most commonly).
 */
function dedupe(name: string, extension: string, used: Set<string>): string {
  if (!used.has(name)) return name
  const base = name.slice(0, -(extension.length + 1))
  let n = 2
  while (used.has(`${base}-${n}.${extension}`)) n++
  return `${base}-${n}.${extension}`
}

export const GET = handler(async (request: NextRequest) => {
  const params = request.nextUrl.searchParams
  const batchId = params.get('batchId')
  const productId = params.get('productId')
  const catalogLayout = params.get('layout') === 'catalog'

  const list = batchId
    ? creatives.listByBatch(batchId, 100000)
    : productId
      ? creatives.listByProduct(productId)
      : creatives.list(100000, 0)

  if (list.length === 0) return badRequest('there are no creatives to download')

  const templateNames = new Map(templates.list().map(t => [t.id, t.name]))
  const zip = new JSZip()
  const used = new Set<string>()

  // Tracked only for the catalog layout: which import(s) the creatives in
  // this download actually came from, so the zip's own filename can be that
  // import's name when there is exactly one - and so that same name can be
  // stripped from every internal path (see catalogPath above) instead of
  // being duplicated both as the filename and as the archive's own top
  // folder.
  let singleImportName: string | null = null
  let sawMultipleImports = false

  for (const creative of list) {
    let bytes: Buffer
    try {
      bytes = await readMedia('creatives', creative.storageKey)
    } catch {
      // A creative whose file is missing should not abort the whole download.
      continue
    }

    const extension = creative.mimeType === 'image/png' ? 'png' : 'jpg'
    let name: string

    if (catalogLayout) {
      const image = images.get(creative.imageId)
      const product = products.get(creative.productId)
      const importRecord = product?.importId ? imports.get(product.importId) : null
      const importName = importRecord?.name ?? null

      if (importName) {
        if (singleImportName === null) singleImportName = importName
        else if (singleImportName !== importName) sawMultipleImports = true
      }

      name = catalogPath(image?.relativePath ?? creative.imageId, extension, importName)
    } else {
      const product = products.get(creative.productId)
      const template = safeName(templateNames.get(creative.templateId) ?? 'template')
      // Group by template so a multi-template run unzips into tidy folders.
      name = `${template}/${safeName(product?.name ?? 'product')}.${extension}`
    }

    name = dedupe(name, extension, used)
    used.add(name)

    zip.file(name, bytes)
  }

  if (used.size === 0) return badRequest('none of the creative files could be read')

  // Named after the import itself when the download is unambiguously one
  // import's worth of photos - "Men Catalogue.zip", no app name, no batch
  // label, no timestamp. Anything else (spans more than one import, or this
  // is the older template-grouped layout) keeps the existing descriptive
  // name; a collision on repeat downloads is the browser's problem to solve
  // (it already does, appending "(1)", "(2)", ...), not this route's.
  const filename =
    catalogLayout && singleImportName && !sawMultipleImports
      ? `${safeSegment(singleImportName)}.zip`
      : `vision-studio-${
          batchId
            ? safeName(batches.get(batchId)?.name ?? 'batch')
            : productId
              ? safeName(products.get(productId)?.name ?? 'product')
              : 'all-creatives'
        }.zip`

  const stream = zip.generateInternalStream({
    type: 'uint8array',
    streamFiles: true,
    compression: 'STORE',
  })

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream
        .on('data', (chunk: Uint8Array) => controller.enqueue(chunk))
        .on('error', (err: Error) => controller.error(err))
        .on('end', () => controller.close())
        .resume()
    },
  })

  return new NextResponse(body, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
      'x-creative-count': String(used.size),
    },
  })
})
