/**
 * Folder-import classification rules.
 *
 * Dependency-free on purpose: these exact predicates run in the BROWSER while
 * scanning the picked directory, and again on the SERVER while validating what
 * arrived. If the two ever diverge, the client offers files the API will reject
 * and the operator sees unexplained failures — so every rule lives here and
 * both sides import it, rather than each keeping its own copy.
 *
 * Isomorphic. No Node built-ins, no DOM.
 */

export const SUPPORTED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'tif', 'tiff'] as const

export const SUPPORTED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/tiff',
] as const

/** `accept` attribute for the directory picker. */
export const ACCEPT_ATTRIBUTE = SUPPORTED_MIME_TYPES.join(',')

/**
 * Per-request upload ceiling.
 *
 * Files go up in batches; this bounds one request, not one file. Originals are
 * never downscaled or re-encoded on the way in — the vision engine's precision
 * depends on full-resolution pixels, and a re-encode would also change the
 * content hash, defeating deduplication.
 */
export const MAX_REQUEST_BYTES = 48 * 1024 * 1024

/** Largest single file accepted. Beyond this a studio TIFF is likely a mistake. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024

export function fileExtension(name: string): string {
  const match = /\.([^./\\]+)$/.exec(name)
  return match ? match[1].toLowerCase() : ''
}

export function baseName(pathLike: string): string {
  const segments = pathLike.split(/[/\\]/)
  return segments[segments.length - 1] || pathLike
}

export function stripExtension(name: string): string {
  return name.replace(/\.[^./\\]+$/, '')
}

/** Normalise a path to forward slashes with no leading or trailing separator. */
export function normalizePath(pathLike: string): string {
  return pathLike.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * OS bookkeeping and editor scratch that appears inside real catalog folders.
 * Matched on ANY path segment — a nested `shirts/.DS_Store` is as unwanted as a
 * top-level one.
 */
export function isSystemPath(relativePath: string): boolean {
  const segments = normalizePath(relativePath).split('/').filter(Boolean)

  return segments.some(segment => {
    if (segment.startsWith('.')) return true // .DS_Store, .git, dotfolders
    if (segment.startsWith('~$')) return true // Office lock files
    if (segment.startsWith('._')) return true // macOS resource forks

    const lower = segment.toLowerCase()
    return (
      lower === '__macosx' ||
      lower === 'thumbs.db' ||
      lower === 'desktop.ini' ||
      lower === 'ehthumbs.db' ||
      lower === 'node_modules' ||
      lower === '.picasaoriginals'
    )
  })
}

/**
 * Is this a product image?
 *
 * Extension is the primary signal, MIME the secondary one. Directory uploads on
 * Linux and some Windows builds report an empty `File.type`, so a MIME-only
 * check silently drops valid images. When a MIME IS present and clearly says
 * non-image, that wins regardless of the name.
 */
export function isSupportedImage(name: string, mimeType?: string): boolean {
  const extensionOk = (SUPPORTED_EXTENSIONS as readonly string[]).includes(fileExtension(name))

  if (!mimeType) return extensionOk

  const mime = mimeType.toLowerCase()
  if (!mime.startsWith('image/')) return false
  if ((SUPPORTED_MIME_TYPES as readonly string[]).includes(mime)) return true

  return extensionOk
}

export type SkipReason = 'system_file' | 'unsupported_type' | 'too_large' | 'empty'

export function classifyFile(input: {
  relativePath: string
  name: string
  mimeType?: string
  size: number
}): { accepted: boolean; reason?: SkipReason } {
  if (isSystemPath(input.relativePath)) return { accepted: false, reason: 'system_file' }
  if (input.size <= 0) return { accepted: false, reason: 'empty' }
  if (input.size > MAX_FILE_BYTES) return { accepted: false, reason: 'too_large' }
  if (!isSupportedImage(input.name, input.mimeType)) {
    return { accepted: false, reason: 'unsupported_type' }
  }
  return { accepted: true }
}

// ─── Product grouping ────────────────────────────────────────────────────────

/**
 * Turn a filename into a display name: drop the extension, collapse the
 * separator soup real catalog exports contain, tidy whitespace.
 *
 * "  RED-DRESS_front__01.jpg " → "RED-DRESS front 01"
 */
export function toDisplayName(fileName: string): string {
  return stripExtension(baseName(fileName))
    .replace(/[_]+/g, ' ')
    .replace(/-{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'item'
  )
}

export interface GroupedFile {
  relativePath: string
  name: string
  /** Folder containing the file, relative to the import root. '' at the root. */
  folderPath: string
  /** Product this file belongs to. */
  productName: string
  productSlug: string
  /** Last folder segment, or null at the root. */
  category: string | null
  /** Ordering within the product. */
  position: number
}

/**
 * Group files into products.
 *
 * The rule follows how fashion catalogs are actually laid out on disk: a folder
 * per product, several shots inside it. So `AW25/dresses/red-midi/{01,02,03}.jpg`
 * becomes ONE product with three images, not three products with one image
 * each — which is what a per-file rule produces and is almost never what the
 * operator wants.
 *
 * Files sitting directly in the root have no folder to group by, so each
 * becomes its own product, named from the file.
 *
 * Within a product, files are ordered by natural filename sort, so `2.jpg`
 * precedes `10.jpg` rather than following it. The first is the primary image.
 */
export function groupIntoProducts(
  files: { relativePath: string; name: string }[]
): GroupedFile[] {
  const byFolder = new Map<string, { relativePath: string; name: string }[]>()

  for (const file of files) {
    const normalized = normalizePath(file.relativePath)
    const segments = normalized.split('/').filter(Boolean)
    // Drop the filename; what remains is the folder path.
    const folderPath = segments.slice(0, -1).join('/')
    const list = byFolder.get(folderPath)
    if (list) list.push(file)
    else byFolder.set(folderPath, [file])
  }

  const out: GroupedFile[] = []

  for (const [folderPath, folderFiles] of byFolder) {
    const sorted = [...folderFiles].sort((a, b) => naturalCompare(a.name, b.name))
    const segments = folderPath.split('/').filter(Boolean)

    if (segments.length === 0) {
      // Root-level files: one product each.
      sorted.forEach(file => {
        const productName = toDisplayName(file.name)
        out.push({
          relativePath: normalizePath(file.relativePath),
          name: file.name,
          folderPath: '',
          productName,
          productSlug: slugify(productName),
          category: null,
          position: 0,
        })
      })
      continue
    }

    const productName = toDisplayName(segments[segments.length - 1])
    const productSlug = slugify(productName)
    // The folder ABOVE the product folder is the natural category, matching the
    // common `category/product/shot.jpg` layout.
    const category = segments.length >= 2 ? toDisplayName(segments[segments.length - 2]) : null

    sorted.forEach((file, index) => {
      out.push({
        relativePath: normalizePath(file.relativePath),
        name: file.name,
        folderPath,
        productName,
        productSlug,
        category,
        position: index,
      })
    })
  }

  return out
}

/**
 * Compare names so embedded numbers sort numerically.
 *
 * Plain lexicographic order puts `look-10.jpg` before `look-2.jpg`, which
 * silently makes the wrong shot the product's primary image.
 */
export function naturalCompare(a: string, b: string): number {
  const chunk = /(\d+)|(\D+)/g
  const aParts = a.toLowerCase().match(chunk) ?? []
  const bParts = b.toLowerCase().match(chunk) ?? []

  const length = Math.min(aParts.length, bParts.length)
  for (let i = 0; i < length; i++) {
    const ap = aParts[i]
    const bp = bParts[i]
    const aNum = /^\d/.test(ap)
    const bNum = /^\d/.test(bp)

    if (aNum && bNum) {
      const diff = Number.parseInt(ap, 10) - Number.parseInt(bp, 10)
      if (diff !== 0) return diff
    } else if (ap !== bp) {
      return ap < bp ? -1 : 1
    }
  }

  return aParts.length - bParts.length
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
