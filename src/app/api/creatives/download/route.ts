/**
 * Download creatives as a ZIP.
 *
 * Four naming behaviours:
 *
 *  - `?productId=` alone (no `batchId`, no `importId`): a single folder's own
 *    download — original filenames, flat, ZIP named after the product
 *    ("KAF 100.zip"). Unconditional, not gated on `?layout=`: there's
 *    exactly one product in play, so there's nothing for a caller to
 *    disambiguate by passing it. What the Products page's per-folder
 *    download link uses.
 *  - `?importId=`: every creative belonging to one master folder (see
 *    `creatives.listByImport`), regardless of which batch or template
 *    produced it. Always the catalog layout below, unconditionally — the
 *    Downloads page's "pick a master folder, get that folder back" view.
 *  - `?layout=catalog` (typically with `?batchId=`, spanning many products)
 *    OR `?importId=` above: `<product folder>/<original filename>.<ext>` -
 *    the source image's own import path with the import's own root folder
 *    stripped off (that name becomes the ZIP FILE's own filename instead,
 *    see below), nesting otherwise preserved. For the Generate page's bulk
 *    batch download and the Downloads page's per-folder download, where the
 *    whole point is handing back a folder structure that matches the
 *    catalog as it was imported, not one that reveals anything about this
 *    app.
 *  - default (none of the above): `<template>/<product>.<ext>` - filenames
 *    built from internal labels, grouped by template. The original
 *    behaviour, unchanged, still what "Download all" (no folder selected)
 *    uses.
 *
 * The catalog layout also names the downloaded ZIP FILE itself after the
 * import it came from ("Men Catalogue.zip"), not a batch label. Both halves
 * matter together: if the import's name were left as a leading folder
 * INSIDE the archive as well as being the file's own name, extracting would
 * double it up - "Men Catalogue/Men Catalogue/MADA-01/...". Stripping it
 * from the internal paths and moving it to the filename is what makes
 * Explorer's "Extract All" (which always wraps in a folder named after the
 * zip) land on the right structure with exactly one level of nesting. The
 * product-scoped case follows the same one-level-of-nesting principle: the
 * ZIP is already named after the folder, so the folder name never also
 * appears as a path prefix inside it.
 *
 * ── Real streaming (P4) ──────────────────────────────────────────────────────
 * A previous version's own comment claimed this was "streamed rather than
 * buffered" — true only of the OUTPUT side. Every input file was fully read,
 * format-converted, and held as a Buffer for every creative in the archive
 * BEFORE any bytes were added to the zip (JSZip's `generateInternalStream`
 * only starts producing output once every `zip.file()` call has already
 * happened). `archiver` instead gets each entry's bytes just before writing
 * it, so entries are read/converted and appended ONE SMALL GROUP AT A TIME —
 * `zipInternalConcurrency` of them in flight at once, each ALSO gated by the
 * same global/per-tenant export-conversion slots a single-file export uses
 * (`withExportSlot`) — while output is already flowing to the client. Peak
 * memory is bounded by that concurrency, not by the archive's total size.
 * Conversions are processed in ORDER (see `processInOrder` below) even
 * though several run concurrently, so the archive's entry order — and the
 * regression test comparing it byte-for-byte against fixed fixtures — stays
 * deterministic.
 *
 * Compression is disabled deliberately: JPEG is already compressed, so deflate
 * costs CPU proportional to the archive size and saves almost nothing.
 */

import { NextRequest, NextResponse } from 'next/server'
import { ZipArchive } from 'archiver'
import { creatives, images, imports, products, templates, batches } from '@/db/repositories'
import { readMedia, statMedia } from '@/storage/media-store'
import { convertForExport, parseExportOptions } from '@/render/export-image'
import { withExportSlot } from '@/render/export-concurrency'
import { currentTenant } from '@/tenancy/context'
import { config } from '@/config'
import { handler, badRequest } from '@/lib/api-handler'
import type { CreativeRecord } from '@/db/types'

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

interface PlannedEntry {
  creative: CreativeRecord
  /** Resolved up front, sequentially — naming must stay deterministic and `used`/`singleImportName` bookkeeping is inherently sequential, unlike the actual file read + conversion below. */
  name: string
}

interface ConvertedEntry {
  name: string
  bytes: Buffer
}

/**
 * Runs `worker` over `items` with up to `concurrency` in flight at once, but
 * YIELDS results strictly in input order — several can finish out of order,
 * but this holds a completed one back until every earlier item has already
 * been yielded. That's what keeps the archive's entry order (and so its
 * exact bytes, for the regression test) identical to a fully sequential run,
 * while still getting the throughput and bounded-memory benefit of
 * processing a few at once.
 */
async function* processInOrder<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): AsyncGenerator<R> {
  if (items.length === 0) return

  const results = new Map<number, R>()
  const inFlight = new Map<number, Promise<void>>()
  let nextToStart = 0
  let nextToYield = 0

  const startOne = () => {
    if (nextToStart >= items.length) return
    const index = nextToStart++
    const promise = worker(items[index], index)
      .then(result => {
        results.set(index, result)
      })
      .finally(() => {
        inFlight.delete(index)
      })
    inFlight.set(index, promise)
  }

  for (let i = 0; i < concurrency; i++) startOne()

  while (nextToYield < items.length) {
    if (results.has(nextToYield)) {
      const result = results.get(nextToYield)!
      results.delete(nextToYield)
      nextToYield++
      startOne()
      yield result
    } else {
      await Promise.race(inFlight.values())
    }
  }
}

export const GET = handler(async (request: NextRequest) => {
  const params = request.nextUrl.searchParams
  const batchId = params.get('batchId')
  const productId = params.get('productId')
  const importId = params.get('importId')
  // `?importId=` always means the catalog layout — the whole reason to scope
  // a download to one master folder is to get back exactly that folder's
  // structure, not something a caller has to additionally remember to ask
  // for. Every creative `listByImport` returns belongs to the SAME import,
  // so the existing `singleImportName`/`sawMultipleImports` bookkeeping
  // below resolves to that one folder's name unchanged — this is a new
  // SOURCE for `list`, not new naming logic.
  const catalogLayout = params.get('layout') === 'catalog' || !!importId
  const exportOptions = parseExportOptions(params)
  const tenantId = currentTenant().tenantId

  // A single folder's own download — always its original filenames, flat,
  // same principle as the catalog layout but scoped to one product rather
  // than a whole import. Checked ahead of `catalogLayout` because this is the
  // one case that should behave this way regardless of whether the caller
  // remembered `?layout=catalog`: there is exactly one product in play, so
  // there's no ambiguity to ask the caller to resolve.
  const productScoped = !!productId && !batchId && !importId

  const list = importId
    ? creatives.listByImport(importId)
    : batchId
      ? creatives.listByBatch(batchId, 100000)
      : productId
        ? creatives.listByProduct(productId)
        : creatives.list(100000, 0)

  if (list.length === 0) return badRequest('there are no creatives to download')

  const templateNames = new Map(templates.list().map(t => [t.id, t.name]))

  // ── Naming pass: sequential, cheap (DB lookups only, no file I/O) ──────────
  // Must run before any conversion starts: `used`/`singleImportName`/
  // `sawMultipleImports` are accumulated in list order, and the ZIP's own
  // filename (built after this loop) depends on having seen every creative.
  const planned: PlannedEntry[] = []
  const used = new Set<string>()
  let singleImportName: string | null = null
  let sawMultipleImports = false

  for (const creative of list) {
    // Extension isn't known until conversion runs — but every existing
    // naming rule only needs it as a SUFFIX, and `convertForExport` only
    // changes the extension when `?format=` was explicitly requested, which
    // is already known from exportOptions before any file is read. The
    // default (no format override) always keeps the creative's own stored
    // extension, so resolving it here — from `creative.mimeType`, same
    // table `convertForExport`'s own default branch reads — reproduces the
    // same name conversion would have picked, without needing to convert
    // first to find out.
    const extension =
      exportOptions.format === 'png'
        ? 'png'
        : exportOptions.format === 'webp'
          ? 'webp'
          : exportOptions.format === 'jpeg'
            ? 'jpg'
            : creative.mimeType === 'image/png'
              ? 'png'
              : creative.mimeType === 'image/webp'
                ? 'webp'
                : 'jpg'

    let name: string

    if (productScoped) {
      // Flat — no folder nesting, since the ZIP IS that one folder already
      // (its own filename is the product's name, set below). Just the
      // original photo's filename with its extension swapped for whatever
      // was actually exported.
      const image = images.get(creative.imageId)
      const original = image?.fileName ?? creative.imageId
      const baseName = original.replace(/\.[^./]+$/, '') || 'untitled'
      name = `${safeSegment(baseName)}.${extension}`
    } else if (catalogLayout) {
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
    planned.push({ creative, name })
  }

  // Named after the import itself when the download is unambiguously one
  // import's worth of photos - "Men Catalogue.zip", no app name, no batch
  // label, no timestamp. Anything else (spans more than one import, or this
  // is the older template-grouped layout) keeps the existing descriptive
  // name; a collision on repeat downloads is the browser's problem to solve
  // (it already does, appending "(1)", "(2)", ...), not this route's.
  const filename = productScoped
    ? `${safeSegment(products.get(productId!)?.name ?? 'product')}.zip`
    : catalogLayout && singleImportName && !sawMultipleImports
      ? `${safeSegment(singleImportName)}.zip`
      : `vision-studio-${
          batchId
            ? safeName(batches.get(batchId)?.name ?? 'batch')
            : productId
              ? safeName(products.get(productId)?.name ?? 'product')
              : 'all-creatives'
        }.zip`

  // A cheap existence check (stat, never a read) BEFORE any response is
  // sent: once streaming starts, the status code and headers are already
  // committed, so "none of these files exist" has to be caught here or not
  // at all — unlike the old buffer-everything-first version, which could
  // inspect the fully-collected result and still choose to return 400.
  // Entries confirmed missing here are dropped from `planned` so
  // `fillArchive` never wastes a `readMedia` attempt it already knows will
  // fail.
  const existence = await Promise.all(
    planned.map(entry => statMedia('creatives', entry.creative.storageKey))
  )
  const existingPlanned = planned.filter((_, i) => existence[i] !== null)
  if (existingPlanned.length === 0) return badRequest('none of the creative files could be read')

  const archive = new ZipArchive({ store: true })
  let aborted = false

  // Runs in the background, writing into `archive` as it goes — the
  // ReadableStream below starts flowing to the client as soon as the FIRST
  // entry is appended, not once every entry is ready.
  const fillArchive = (async () => {
    let addedAny = false

    for await (const converted of processInOrder<PlannedEntry, ConvertedEntry | null>(
      existingPlanned,
      config.render.zipInternalConcurrency,
      async entry => {
        if (aborted) return null
        let bytes: Buffer
        try {
          bytes = await readMedia('creatives', entry.creative.storageKey)
        } catch {
          // A creative whose file is missing should not abort the whole download.
          return null
        }
        if (aborted) return null

        // A no-op when exportOptions is empty — returns `bytes` as-is,
        // reproducing byte-identical output to a plain
        // `/api/creatives/download` with no export params, exactly as
        // before this file existed.
        const exported = await withExportSlot(tenantId, () =>
          convertForExport(bytes, entry.creative.mimeType, entry.creative.width, exportOptions)
        )
        return { name: entry.name, bytes: exported.bytes }
      }
    )) {
      if (aborted) break
      if (!converted) continue
      archive.append(converted.bytes, { name: converted.name })
      addedAny = true
    }

    if (!addedAny) {
      archive.abort()
      return
    }
    void archive.finalize()
  })()

  fillArchive.catch(err => {
    console.error('[creatives/download] archive fill failed:', err)
    archive.destroy(err instanceof Error ? err : new Error(String(err)))
  })

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      archive
        .on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
        .on('warning', (err: Error) => console.warn('[creatives/download] archiver warning:', err.message))
        .on('error', (err: Error) => controller.error(err))
        .on('end', () => controller.close())
    },
    // Fires when the CLIENT disconnects (tab closed, download cancelled) —
    // stop converting more files and let `fillArchive`'s loop unwind, which
    // releases every export-concurrency slot already acquired via
    // `withExportSlot`'s own try/finally. Nothing here can leak a slot by
    // continuing to hold it after this point: a conversion already in
    // flight finishes and releases normally; `aborted` just stops anything
    // new from starting.
    cancel() {
      aborted = true
      archive.destroy()
    },
  })

  // Will be inaccurate once the first creative is actually found missing on
  // disk (same caveat the old implementation had — `used.size` there was
  // also computed from the planning pass, not the final written count).
  // Kept for continuity with existing callers of this header; not load-
  // bearing for anything this route itself does.
  return new NextResponse(body, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
      'x-creative-count': String(existingPlanned.length),
    },
  })
})
