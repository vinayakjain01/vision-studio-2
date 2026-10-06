/**
 * Content-addressed media store.
 *
 * Every original image is written once, at a path derived from the sha256 of
 * its bytes. Consequences worth relying on:
 *
 *  * Re-importing the same photo is free and cannot duplicate storage.
 *  * A storage key is immutable — the bytes behind it can never change, so
 *    HTTP responses are cached with `immutable` (see next.config.ts).
 *  * Vision output keyed by the same hash is automatically shared across every
 *    product that happens to contain that photo.
 *
 * Layout:
 *   originals/<ab>/<cd>/<hash>.<ext>        source bytes, never modified
 *   derived/<ab>/<cd>/<hash>/<kind>.<ext>   masks, cutouts, previews
 *   creatives/<batchId>/<creativeId>.<ext>  rendered output
 *   assets/<id>.<ext>                       template logos/overlays/thumbnails
 *
 * The two-level `<ab>/<cd>` fan-out keeps directory sizes sane: a 100k-image
 * catalog spreads over 65,536 leaf directories instead of one.
 *
 * Server-only.
 */

import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { tenantPaths } from '@/config'
import { currentTenant } from '@/tenancy/context'

export type MediaRoot = 'originals' | 'derived' | 'creatives' | 'assets'

/**
 * Resolved fresh on every call from `currentTenant()`, not cached at module
 * load — the single biggest change this file makes for multi-tenancy. It
 * used to be a module-level constant computed once from one global
 * `dataDir`; a photo's root now depends on who's asking, which can only be
 * known per-call. `currentTenant()` itself throws with no context set, so
 * this inherits that fail-closed behaviour rather than needing its own
 * check.
 */
function roots(): Record<MediaRoot, string> {
  const paths = tenantPaths(currentTenant().tenantId)
  return {
    originals: paths.originals,
    derived: paths.derived,
    creatives: paths.creatives,
    assets: paths.assets,
  }
}

/** sha256 of a buffer, lowercase hex. */
export function hashBytes(bytes: Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/tiff': 'tiff',
}

export function extensionForMime(mime: string): string {
  return EXT_BY_MIME[mime.toLowerCase()] ?? 'bin'
}

/**
 * Reject any key that could escape its root. Keys are constructed internally,
 * but the media HTTP route accepts them from the client, so this is enforced at
 * the store rather than at each call site.
 */
function assertSafeKey(key: string): void {
  if (
    key.length === 0 ||
    key.includes('\0') ||
    path.isAbsolute(key) ||
    key.split(/[/\\]/).some(segment => segment === '..')
  ) {
    throw new Error(`unsafe storage key: ${JSON.stringify(key)}`)
  }
}

/**
 * Resolves symlinks for the containment check below. For a path that
 * doesn't exist yet (the common case for a write), walks up to the nearest
 * EXISTING ancestor, resolves that ancestor's real path, and reattaches the
 * not-yet-created segments — so a brand-new file is still checked against
 * where its parent directory actually lives on disk, symlinks and all, not
 * just its literal textual path.
 */
function resolveRealContainment(p: string): string {
  let current = p
  const pending: string[] = []
  while (true) {
    if (fs.existsSync(current)) {
      const real = fs.realpathSync(current)
      return pending.length > 0 ? path.join(real, ...pending) : real
    }
    const parent = path.dirname(current)
    if (parent === current) return p // hit the filesystem root with nothing existing — give up, caller still has the lexical check
    pending.unshift(path.basename(current))
    current = parent
  }
}

/**
 * Absolute filesystem path for a key under a root. Validates the key.
 *
 * Two independent containment checks, not one: the lexical check (`path
 * .relative` on the literal, unresolved path) catches `../` segments and
 * similar; the real-path check below catches the case the lexical one
 * can't — a directory or file SOMEWHERE in the resolved path being a
 * symlink that points outside the root, which `path.resolve`/`path.relative`
 * have no way to see since they never touch the filesystem. Nothing in
 * this app's own code creates symlinks inside a media root, but this is
 * exactly the kind of check that should not depend on that staying true.
 */
export function resolvePath(root: MediaRoot, key: string): string {
  assertSafeKey(key)
  const base = roots()[root]
  fs.mkdirSync(base, { recursive: true })

  const resolved = path.resolve(base, key)
  const rel = path.relative(base, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`storage key escapes root: ${JSON.stringify(key)}`)
  }

  const realBase = fs.realpathSync(base)
  const realResolved = resolveRealContainment(resolved)
  const realRel = path.relative(realBase, realResolved)
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
    throw new Error(`storage key escapes root via a symlink: ${JSON.stringify(key)}`)
  }

  return resolved
}

// ── Storage keys ─────────────────────────────────────────────────────────────

export function originalKey(hash: string, mime: string): string {
  return path.posix.join(
    hash.slice(0, 2),
    hash.slice(2, 4),
    `${hash}.${extensionForMime(mime)}`
  )
}

export function derivedKey(hash: string, kind: string, ext: string): string {
  return path.posix.join(hash.slice(0, 2), hash.slice(2, 4), hash, `${kind}.${ext}`)
}

export function creativeKey(batchId: string, creativeId: string, ext: string): string {
  return path.posix.join(batchId, `${creativeId}.${ext}`)
}

export function assetKey(id: string, ext: string): string {
  return `${id}.${ext}`
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Write bytes atomically: to a temp file in the destination directory, then
 * rename. A crashed or concurrent write can never leave a half-written image
 * that a later reader would mistake for a valid one.
 *
 * Returns `{ written: false }` when the destination already exists — for
 * content-addressed paths identical content is already there, so re-writing
 * would be pure I/O with no observable effect.
 */
export async function writeFileAtomic(
  root: MediaRoot,
  key: string,
  bytes: Buffer | Uint8Array,
  options: { overwrite?: boolean } = {}
): Promise<{ path: string; written: boolean; byteSize: number }> {
  const target = resolvePath(root, key)

  if (!options.overwrite) {
    try {
      const stat = await fsp.stat(target)
      return { path: target, written: false, byteSize: stat.size }
    } catch {
      // Not present — fall through and write.
    }
  }

  await fsp.mkdir(path.dirname(target), { recursive: true })

  const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    await fsp.writeFile(tmp, bytes)
    await fsp.rename(tmp, target)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }

  return { path: target, written: true, byteSize: bytes.byteLength }
}

/**
 * Store an original by content hash. Idempotent: importing the same bytes twice
 * writes once and both callers get the same key.
 */
export async function putOriginal(
  bytes: Buffer,
  mime: string
): Promise<{ hash: string; key: string; path: string; deduplicated: boolean; byteSize: number }> {
  const hash = hashBytes(bytes)
  const key = originalKey(hash, mime)
  const { path: filePath, written, byteSize } = await writeFileAtomic('originals', key, bytes)
  return { hash, key, path: filePath, deduplicated: !written, byteSize }
}

export async function putDerived(
  hash: string,
  kind: string,
  ext: string,
  bytes: Buffer
): Promise<{ key: string; path: string; byteSize: number }> {
  const key = derivedKey(hash, kind, ext)
  // Derived assets are regenerated when the engine version changes, so they
  // overwrite rather than dedupe.
  const { path: filePath, byteSize } = await writeFileAtomic('derived', key, bytes, { overwrite: true })
  return { key, path: filePath, byteSize }
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function readMedia(root: MediaRoot, key: string): Promise<Buffer> {
  return fsp.readFile(resolvePath(root, key))
}

export function readMediaSync(root: MediaRoot, key: string): Buffer {
  return fs.readFileSync(resolvePath(root, key))
}

export async function mediaExists(root: MediaRoot, key: string): Promise<boolean> {
  try {
    await fsp.access(resolvePath(root, key))
    return true
  } catch {
    return false
  }
}

export async function statMedia(root: MediaRoot, key: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const s = await fsp.stat(resolvePath(root, key))
    return { size: s.size, mtimeMs: s.mtimeMs }
  } catch {
    return null
  }
}

export async function deleteMedia(root: MediaRoot, key: string): Promise<void> {
  await fsp.rm(resolvePath(root, key), { force: true })
}

/** Remove every derived asset for one source hash (e.g. before re-analysis). */
export async function deleteDerivedTree(hash: string): Promise<void> {
  const dir = resolvePath('derived', path.posix.join(hash.slice(0, 2), hash.slice(2, 4), hash))
  await fsp.rm(dir, { recursive: true, force: true })
}

/** Remove a whole directory under a root — e.g. one batch's creatives. */
export async function deleteDirectory(root: MediaRoot, key: string): Promise<void> {
  await fsp.rm(resolvePath(root, key), { recursive: true, force: true })
}

/**
 * Every file under a root, as keys relative to it.
 *
 * Used by the orphan sweep to find files with no database row — which accumulate
 * from interrupted imports, crashed renders, or a schema reset that dropped rows
 * while leaving the bytes on disk.
 */
export async function listMediaKeys(root: MediaRoot): Promise<string[]> {
  const base = roots()[root]
  const out: string[] = []

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) {
        // Normalise to the forward-slash keys the rest of the store uses.
        out.push(path.relative(base, full).split(path.sep).join('/'))
      }
    }
  }

  await walk(base)
  return out
}

/** Delete directories that no longer contain any files. */
export async function pruneEmptyDirectories(root: MediaRoot): Promise<number> {
  const base = roots()[root]
  let removed = 0

  async function walk(dir: string): Promise<boolean> {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return false
    }

    let hasFiles = false
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const childHasFiles = await walk(full)
        if (childHasFiles) hasFiles = true
      } else {
        hasFiles = true
      }
    }

    if (!hasFiles && dir !== base) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
      removed++
    }
    return hasFiles
  }

  await walk(base)
  return removed
}

// ── URLs ─────────────────────────────────────────────────────────────────────

/**
 * Browser-facing URL for a stored file. Served by
 * `src/app/api/media/[root]/[...key]/route.ts`.
 */
export function mediaUrl(root: MediaRoot, key: string): string {
  const encoded = key.split('/').map(encodeURIComponent).join('/')
  return `/api/media/${root}/${encoded}`
}

/**
 * Creates every media directory for one tenant. Takes the tenant id
 * explicitly rather than reading `currentTenant()` — this runs during
 * provisioning (tenant creation, legacy migration), before any request for
 * that tenant exists to derive a context from.
 */
export function ensureMediaRoots(tenantId: string): void {
  const paths = tenantPaths(tenantId)
  for (const dir of [paths.originals, paths.derived, paths.creatives, paths.assets, paths.tmp]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}
