/**
 * Data access.
 *
 * Every SQL statement in the application lives here. Callers work with the
 * domain types from `./types`; the row↔domain mapping (0/1 booleans, JSON
 * columns) is confined to this file.
 *
 * Statements are prepared lazily and cached by better-sqlite3 on the connection,
 * so the repeated `db.prepare(...)` calls below compile once each.
 *
 * Server-only (including worker threads).
 */

import { nanoid } from 'nanoid'
import { getDb, nowIso, transaction, bool, toInt, parseJson, type Db } from './client'
import type {
  BatchRecord,
  BatchStatus,
  CreativeRecord,
  DerivedAssetKind,
  DerivedAssetRecord,
  ImageRecord,
  ImportRecord,
  ImportStatus,
  ProductRecord,
  RuleRecord,
  TemplateRecord,
  VisionRecord,
  VisionStatus,
} from './types'
import type { VisionMetadata } from '@/vision/types'
import type { TemplateDocument } from '@/templates/types'
import type { FramingResult } from '@/framing/types'

export function newId(prefix: string): string {
  return `${prefix}_${nanoid(16)}`
}

// ════════════════════════════════════════════════════════════════════════════
// Imports
// ════════════════════════════════════════════════════════════════════════════

function toImport(row: any): ImportRecord {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    status: row.status,
    totalFiles: row.total_files,
    importedFiles: row.imported_files,
    skippedFiles: row.skipped_files,
    failedFiles: row.failed_files,
    duplicateFiles: row.duplicate_files,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

export const imports = {
  create(input: { name: string; rootPath?: string | null; totalFiles?: number }): ImportRecord {
    const db = getDb()
    const id = newId('imp')
    const ts = nowIso()
    db.prepare(
      `INSERT INTO imports (id, name, root_path, status, total_files, created_at, updated_at)
       VALUES (?, ?, ?, 'open', ?, ?, ?)`
    ).run(id, input.name, input.rootPath ?? null, input.totalFiles ?? 0, ts, ts)
    return this.get(id)!
  },

  get(id: string): ImportRecord | null {
    const row = getDb().prepare('SELECT * FROM imports WHERE id = ?').get(id)
    return row ? toImport(row) : null
  },

  list(limit = 50): ImportRecord[] {
    return getDb()
      .prepare('SELECT * FROM imports ORDER BY created_at DESC LIMIT ?')
      .all(limit)
      .map(toImport)
  },

  /**
   * Apply signed deltas to the counters and optionally move the status.
   *
   * Deltas rather than absolute values because uploads arrive concurrently —
   * several requests increment `imported_files` at once, and reading then
   * writing a total would lose increments.
   */
  bump(
    id: string,
    deltas: Partial<Record<'imported' | 'skipped' | 'failed' | 'duplicate' | 'total', number>>,
    status?: ImportStatus
  ): void {
    const sets: string[] = []
    const params: any[] = []

    const map: Record<string, string> = {
      imported: 'imported_files',
      skipped: 'skipped_files',
      failed: 'failed_files',
      duplicate: 'duplicate_files',
      total: 'total_files',
    }
    for (const [key, column] of Object.entries(map)) {
      const delta = deltas[key as keyof typeof deltas]
      if (delta) {
        sets.push(`${column} = ${column} + ?`)
        params.push(delta)
      }
    }

    if (status) {
      sets.push('status = ?')
      params.push(status)
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        sets.push('completed_at = ?')
        params.push(nowIso())
      }
    }

    if (sets.length === 0) return

    sets.push('updated_at = ?')
    params.push(nowIso(), id)

    getDb().prepare(`UPDATE imports SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  },

  fail(id: string, error: string): void {
    getDb()
      .prepare(
        `UPDATE imports SET status = 'failed', error = ?, completed_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(error, nowIso(), nowIso(), id)
  },

  remove(id: string): void {
    getDb().prepare('DELETE FROM imports WHERE id = ?').run(id)
  },
}

// ════════════════════════════════════════════════════════════════════════════
// Products
// ════════════════════════════════════════════════════════════════════════════

function toProduct(row: any): ProductRecord {
  return {
    id: row.id,
    importId: row.import_id,
    name: row.name,
    slug: row.slug,
    folderPath: row.folder_path,
    category: row.category,
    imageCount: row.image_count,
    primaryImageId: row.primary_image_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface ProductFilter {
  importId?: string
  category?: string
  folderPrefix?: string
  search?: string
  limit?: number
  offset?: number
}

export const products = {
  /**
   * Find an existing product for this folder+slug within the import, or create
   * one. Folder uploads group images by directory, so the second image in a
   * folder must attach to the product the first one created.
   */
  upsert(input: {
    importId: string | null
    name: string
    slug: string
    folderPath: string
    category: string | null
  }): ProductRecord {
    const db = getDb()
    const existing = db
      .prepare(
        `SELECT * FROM products
         WHERE import_id IS ? AND folder_path = ? AND slug = ?`
      )
      .get(input.importId, input.folderPath, input.slug)

    if (existing) return toProduct(existing)

    const id = newId('prd')
    const ts = nowIso()
    db.prepare(
      `INSERT INTO products (id, import_id, name, slug, folder_path, category, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, input.importId, input.name, input.slug, input.folderPath, input.category, ts, ts)
    return this.get(id)!
  },

  get(id: string): ProductRecord | null {
    const row = getDb().prepare('SELECT * FROM products WHERE id = ?').get(id)
    return row ? toProduct(row) : null
  },

  list(filter: ProductFilter = {}): ProductRecord[] {
    const where: string[] = []
    const params: any[] = []

    if (filter.importId) {
      where.push('import_id = ?')
      params.push(filter.importId)
    }
    if (filter.category) {
      where.push('category = ?')
      params.push(filter.category)
    }
    if (filter.folderPrefix) {
      where.push('folder_path LIKE ?')
      params.push(`${filter.folderPrefix}%`)
    }
    if (filter.search) {
      where.push('(name LIKE ? OR folder_path LIKE ?)')
      params.push(`%${filter.search}%`, `%${filter.search}%`)
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    params.push(filter.limit ?? 100, filter.offset ?? 0)

    return getDb()
      .prepare(`SELECT * FROM products ${clause} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`)
      .all(...params)
      .map(toProduct)
  },

  count(filter: ProductFilter = {}): number {
    const where: string[] = []
    const params: any[] = []
    if (filter.importId) {
      where.push('import_id = ?')
      params.push(filter.importId)
    }
    if (filter.category) {
      where.push('category = ?')
      params.push(filter.category)
    }
    if (filter.search) {
      where.push('(name LIKE ? OR folder_path LIKE ?)')
      params.push(`%${filter.search}%`, `%${filter.search}%`)
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const row = getDb().prepare(`SELECT COUNT(*) AS n FROM products ${clause}`).get(...params) as any
    return row?.n ?? 0
  },

  categories(): { category: string; count: number }[] {
    return getDb()
      .prepare(
        `SELECT category, COUNT(*) AS count FROM products
         WHERE category IS NOT NULL AND category != ''
         GROUP BY category ORDER BY count DESC, category ASC`
      )
      .all() as any[]
  },

  folders(): { folderPath: string; count: number }[] {
    return (
      getDb()
        .prepare(
          `SELECT folder_path AS folderPath, COUNT(*) AS count FROM products
           GROUP BY folder_path ORDER BY folder_path ASC`
        )
        .all() as any[]
    )
  },

  /** Recompute denormalised image counters after images are added or removed. */
  refreshCounters(productId: string): void {
    getDb()
      .prepare(
        `UPDATE products SET
           image_count = (SELECT COUNT(*) FROM images WHERE product_id = ?),
           primary_image_id = (
             SELECT id FROM images WHERE product_id = ?
             ORDER BY is_primary DESC, position ASC, created_at ASC LIMIT 1
           ),
           updated_at = ?
         WHERE id = ?`
      )
      .run(productId, productId, nowIso(), productId)
  },

  remove(id: string): void {
    getDb().prepare('DELETE FROM products WHERE id = ?').run(id)
  },
}

// ════════════════════════════════════════════════════════════════════════════
// Images
// ════════════════════════════════════════════════════════════════════════════

function toImage(row: any): ImageRecord {
  return {
    id: row.id,
    productId: row.product_id,
    importId: row.import_id,
    sourceHash: row.source_hash,
    storageKey: row.storage_key,
    fileName: row.file_name,
    relativePath: row.relative_path,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height,
    exifOrientation: row.exif_orientation,
    hasAlpha: bool(row.has_alpha),
    colorSpace: row.color_space,
    capturedAt: row.captured_at,
    cameraMake: row.camera_make,
    cameraModel: row.camera_model,
    position: row.position,
    isPrimary: bool(row.is_primary),
    visionStatus: row.vision_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const images = {
  create(input: Omit<ImageRecord, 'id' | 'createdAt' | 'updatedAt' | 'visionStatus'>): ImageRecord {
    const db = getDb()
    const id = newId('img')
    const ts = nowIso()
    db.prepare(
      `INSERT INTO images (
         id, product_id, import_id, source_hash, storage_key, file_name, relative_path,
         mime_type, byte_size, width, height, exif_orientation, has_alpha, color_space,
         captured_at, camera_make, camera_model, position, is_primary, vision_status,
         created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`
    ).run(
      id,
      input.productId,
      input.importId,
      input.sourceHash,
      input.storageKey,
      input.fileName,
      input.relativePath,
      input.mimeType,
      input.byteSize,
      input.width,
      input.height,
      input.exifOrientation,
      toInt(input.hasAlpha),
      input.colorSpace,
      input.capturedAt,
      input.cameraMake,
      input.cameraModel,
      input.position,
      toInt(input.isPrimary),
      ts,
      ts
    )
    return this.get(id)!
  },

  get(id: string): ImageRecord | null {
    const row = getDb().prepare('SELECT * FROM images WHERE id = ?').get(id)
    return row ? toImage(row) : null
  },

  findByProductAndHash(productId: string, sourceHash: string): ImageRecord | null {
    const row = getDb()
      .prepare('SELECT * FROM images WHERE product_id = ? AND source_hash = ?')
      .get(productId, sourceHash)
    return row ? toImage(row) : null
  },

  listByProduct(productId: string): ImageRecord[] {
    return getDb()
      .prepare('SELECT * FROM images WHERE product_id = ? ORDER BY position ASC, created_at ASC')
      .all(productId)
      .map(toImage)
  },

  listByStatus(status: VisionStatus, limit = 500): ImageRecord[] {
    return getDb()
      .prepare('SELECT * FROM images WHERE vision_status = ? ORDER BY created_at ASC LIMIT ?')
      .all(status, limit)
      .map(toImage)
  },

  listByImport(importId: string, limit = 1000): ImageRecord[] {
    return getDb()
      .prepare('SELECT * FROM images WHERE import_id = ? ORDER BY created_at ASC LIMIT ?')
      .all(importId, limit)
      .map(toImage)
  },

  setVisionStatus(id: string, status: VisionStatus): void {
    getDb()
      .prepare('UPDATE images SET vision_status = ?, updated_at = ? WHERE id = ?')
      .run(status, nowIso(), id)
  },

  /**
   * Mark every image sharing a source hash. Analysis is content-addressed, so
   * one run resolves the status of all duplicates at once.
   */
  setVisionStatusByHash(sourceHash: string, status: VisionStatus): void {
    getDb()
      .prepare('UPDATE images SET vision_status = ?, updated_at = ? WHERE source_hash = ?')
      .run(status, nowIso(), sourceHash)
  },

  /**
   * How many images still reference a set of bytes.
   *
   * Media is content-addressed, so an original can be shared by several products.
   * Deletion must check this before removing a file — otherwise deleting one
   * product silently breaks another that happened to contain the same photo.
   */
  countByHash(sourceHash: string): number {
    const row = getDb()
      .prepare('SELECT COUNT(*) AS n FROM images WHERE source_hash = ?')
      .get(sourceHash) as any
    return row?.n ?? 0
  },

  /** Every (hash, key) pair under a product — captured before a cascade delete. */
  hashesForProduct(productId: string): { sourceHash: string; storageKey: string }[] {
    return getDb()
      .prepare('SELECT source_hash AS sourceHash, storage_key AS storageKey FROM images WHERE product_id = ?')
      .all(productId) as any[]
  },

  /** Every (hash, key) pair under an import — captured before a cascade delete. */
  hashesForImport(importId: string): { sourceHash: string; storageKey: string }[] {
    return getDb()
      .prepare('SELECT source_hash AS sourceHash, storage_key AS storageKey FROM images WHERE import_id = ?')
      .all(importId) as any[]
  },

  /** Every image row. Used by the orphan sweep to build its reference set. */
  listByStatusAll(): ImageRecord[] {
    return getDb().prepare('SELECT * FROM images').all().map(toImage)
  },

  statusCounts(): Record<VisionStatus, number> {
    const rows = getDb()
      .prepare('SELECT vision_status AS status, COUNT(*) AS n FROM images GROUP BY vision_status')
      .all() as any[]
    const out: Record<VisionStatus, number> = {
      pending: 0,
      processing: 0,
      ready: 0,
      failed: 0,
      unavailable: 0,
    }
    for (const row of rows) out[row.status as VisionStatus] = row.n
    return out
  },

  total(): number {
    const row = getDb().prepare('SELECT COUNT(*) AS n FROM images').get() as any
    return row?.n ?? 0
  },

  remove(id: string): void {
    getDb().prepare('DELETE FROM images WHERE id = ?').run(id)
  },
}

// ════════════════════════════════════════════════════════════════════════════
// Vision analyses
// ════════════════════════════════════════════════════════════════════════════

function toVision(row: any): VisionRecord {
  return {
    id: row.id,
    sourceHash: row.source_hash,
    engineVersion: row.engine_version,
    schemaVersion: row.schema_version,
    provider: row.provider,
    status: row.status,
    imageWidth: row.image_width,
    imageHeight: row.image_height,
    personCount: row.person_count,
    faceCount: row.face_count,
    shotType: row.shot_type,
    garmentType: row.garment_type,
    overallConfidence: row.overall_confidence,
    payload: parseJson(row.payload, {} as VisionMetadata),
    modelVersions: parseJson(row.model_versions, {}),
    durationMs: row.duration_ms,
    error: row.error,
    createdAt: row.created_at,
  }
}

export const visionAnalyses = {
  /** Store an analysis, replacing any previous row for the same hash+version. */
  put(metadata: VisionMetadata): VisionRecord {
    const db = getDb()
    const id = newId('vis')
    db.prepare(
      `INSERT INTO vision_analyses (
         id, source_hash, engine_version, schema_version, provider, status,
         image_width, image_height, person_count, face_count, shot_type, garment_type,
         overall_confidence, payload, model_versions, duration_ms, error, created_at
       ) VALUES (?,?,?,?,?,'ready',?,?,?,?,?,?,?,?,?,?,NULL,?)
       ON CONFLICT (source_hash, engine_version) DO UPDATE SET
         id = excluded.id,
         schema_version = excluded.schema_version,
         provider = excluded.provider,
         status = 'ready',
         image_width = excluded.image_width,
         image_height = excluded.image_height,
         person_count = excluded.person_count,
         face_count = excluded.face_count,
         shot_type = excluded.shot_type,
         garment_type = excluded.garment_type,
         overall_confidence = excluded.overall_confidence,
         payload = excluded.payload,
         model_versions = excluded.model_versions,
         duration_ms = excluded.duration_ms,
         error = NULL,
         created_at = excluded.created_at`
    ).run(
      id,
      metadata.sourceHash,
      metadata.engineVersion,
      metadata.schemaVersion,
      metadata.provider,
      metadata.image.width,
      metadata.image.height,
      metadata.persons.length,
      metadata.faces.length,
      metadata.shot.type,
      metadata.garment.type,
      metadata.quality.overall,
      JSON.stringify(metadata),
      JSON.stringify(metadata.modelVersions),
      metadata.durationMs,
      metadata.createdAt
    )
    return this.find(metadata.sourceHash, metadata.engineVersion)!
  },

  putFailure(input: {
    sourceHash: string
    engineVersion: string
    schemaVersion: number
    provider: string
    status: 'failed' | 'unavailable'
    error: string
  }): void {
    getDb()
      .prepare(
        `INSERT INTO vision_analyses (
           id, source_hash, engine_version, schema_version, provider, status,
           image_width, image_height, payload, model_versions, error, created_at
         ) VALUES (?,?,?,?,?,?,0,0,'{}','{}',?,?)
         ON CONFLICT (source_hash, engine_version) DO UPDATE SET
           status = excluded.status, error = excluded.error, created_at = excluded.created_at`
      )
      .run(
        newId('vis'),
        input.sourceHash,
        input.engineVersion,
        input.schemaVersion,
        input.provider,
        input.status,
        input.error,
        nowIso()
      )
  },

  find(sourceHash: string, engineVersion: string): VisionRecord | null {
    const row = getDb()
      .prepare('SELECT * FROM vision_analyses WHERE source_hash = ? AND engine_version = ?')
      .get(sourceHash, engineVersion)
    return row ? toVision(row) : null
  },

  /** Most recent analysis for a hash, whatever engine version produced it. */
  latest(sourceHash: string): VisionRecord | null {
    const row = getDb()
      .prepare(
        `SELECT * FROM vision_analyses WHERE source_hash = ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(sourceHash)
    return row ? toVision(row) : null
  },

  listVersions(sourceHash: string): VisionRecord[] {
    return getDb()
      .prepare('SELECT * FROM vision_analyses WHERE source_hash = ? ORDER BY created_at DESC')
      .all(sourceHash)
      .map(toVision)
  },

  removeForHash(sourceHash: string): void {
    getDb().prepare('DELETE FROM vision_analyses WHERE source_hash = ?').run(sourceHash)
  },

  shotTypeCounts(): { shotType: string; count: number }[] {
    return getDb()
      .prepare(
        `SELECT shot_type AS shotType, COUNT(*) AS count FROM vision_analyses
         WHERE status = 'ready' AND shot_type IS NOT NULL
         GROUP BY shot_type ORDER BY count DESC`
      )
      .all() as any[]
  },
}

// ════════════════════════════════════════════════════════════════════════════
// Derived assets
// ════════════════════════════════════════════════════════════════════════════

function toDerived(row: any): DerivedAssetRecord {
  return {
    id: row.id,
    sourceHash: row.source_hash,
    kind: row.kind,
    storageKey: row.storage_key,
    mimeType: row.mime_type,
    width: row.width,
    height: row.height,
    byteSize: row.byte_size,
    createdAt: row.created_at,
  }
}

export const derivedAssets = {
  put(input: Omit<DerivedAssetRecord, 'id' | 'createdAt'>): DerivedAssetRecord {
    const db = getDb()
    db.prepare(
      `INSERT INTO derived_assets (id, source_hash, kind, storage_key, mime_type, width, height, byte_size, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT (source_hash, kind) DO UPDATE SET
         storage_key = excluded.storage_key,
         mime_type = excluded.mime_type,
         width = excluded.width,
         height = excluded.height,
         byte_size = excluded.byte_size,
         created_at = excluded.created_at`
    ).run(
      newId('drv'),
      input.sourceHash,
      input.kind,
      input.storageKey,
      input.mimeType,
      input.width,
      input.height,
      input.byteSize,
      nowIso()
    )
    return this.find(input.sourceHash, input.kind)!
  },

  removeForHash(sourceHash: string): void {
    getDb().prepare('DELETE FROM derived_assets WHERE source_hash = ?').run(sourceHash)
  },

  find(sourceHash: string, kind: DerivedAssetKind): DerivedAssetRecord | null {
    const row = getDb()
      .prepare('SELECT * FROM derived_assets WHERE source_hash = ? AND kind = ?')
      .get(sourceHash, kind)
    return row ? toDerived(row) : null
  },

  listForHash(sourceHash: string): DerivedAssetRecord[] {
    return getDb()
      .prepare('SELECT * FROM derived_assets WHERE source_hash = ? ORDER BY kind')
      .all(sourceHash)
      .map(toDerived)
  },
}

// ════════════════════════════════════════════════════════════════════════════
// Templates
// ════════════════════════════════════════════════════════════════════════════

function toTemplate(row: any): TemplateRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    document: parseJson(row.document, {} as TemplateDocument),
    thumbnailKey: row.thumbnail_key,
    isActive: bool(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const templates = {
  create(input: {
    name: string
    description?: string | null
    category?: string | null
    document: TemplateDocument
  }): TemplateRecord {
    const db = getDb()
    const id = newId('tpl')
    const ts = nowIso()
    db.prepare(
      `INSERT INTO templates (id, name, description, category, document, is_active, created_at, updated_at)
       VALUES (?,?,?,?,?,1,?,?)`
    ).run(
      id,
      input.name,
      input.description ?? null,
      input.category ?? null,
      JSON.stringify(input.document),
      ts,
      ts
    )
    return this.get(id)!
  },

  /**
   * Update with an explicit allow-list. Spreading a request body into the SET
   * clause is how a template edit endpoint becomes a way to rewrite `id` or
   * `created_at`; the fields are enumerated deliberately.
   */
  update(
    id: string,
    patch: Partial<Pick<TemplateRecord, 'name' | 'description' | 'category' | 'isActive'>> & {
      document?: TemplateDocument
      thumbnailKey?: string | null
    }
  ): TemplateRecord | null {
    const sets: string[] = []
    const params: any[] = []

    if (patch.name !== undefined) {
      sets.push('name = ?')
      params.push(patch.name)
    }
    if (patch.description !== undefined) {
      sets.push('description = ?')
      params.push(patch.description)
    }
    if (patch.category !== undefined) {
      sets.push('category = ?')
      params.push(patch.category)
    }
    if (patch.isActive !== undefined) {
      sets.push('is_active = ?')
      params.push(toInt(patch.isActive))
    }
    if (patch.document !== undefined) {
      sets.push('document = ?')
      params.push(JSON.stringify(patch.document))
    }
    if (patch.thumbnailKey !== undefined) {
      sets.push('thumbnail_key = ?')
      params.push(patch.thumbnailKey)
    }

    if (sets.length === 0) return this.get(id)

    sets.push('updated_at = ?')
    params.push(nowIso(), id)

    getDb().prepare(`UPDATE templates SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    return this.get(id)
  },

  get(id: string): TemplateRecord | null {
    const row = getDb().prepare('SELECT * FROM templates WHERE id = ?').get(id)
    return row ? toTemplate(row) : null
  },

  list(options: { activeOnly?: boolean } = {}): TemplateRecord[] {
    const clause = options.activeOnly ? 'WHERE is_active = 1' : ''
    return getDb()
      .prepare(`SELECT * FROM templates ${clause} ORDER BY updated_at DESC`)
      .all()
      .map(toTemplate)
  },

  remove(id: string): void {
    getDb().prepare('DELETE FROM templates WHERE id = ?').run(id)
  },
}

// ════════════════════════════════════════════════════════════════════════════
// Rules
// ════════════════════════════════════════════════════════════════════════════

function toRule(row: any): RuleRecord {
  return {
    id: row.id,
    name: row.name,
    matchType: row.match_type,
    operator: row.operator,
    value: row.value,
    templateId: row.template_id,
    priority: row.priority,
    isActive: bool(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const rules = {
  create(input: Omit<RuleRecord, 'id' | 'createdAt' | 'updatedAt'>): RuleRecord {
    const db = getDb()
    const id = newId('rul')
    const ts = nowIso()
    db.prepare(
      `INSERT INTO rules (id, name, match_type, operator, value, template_id, priority, is_active, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      input.name,
      input.matchType,
      input.operator,
      input.value,
      input.templateId,
      input.priority,
      toInt(input.isActive),
      ts,
      ts
    )
    return this.get(id)!
  },

  update(
    id: string,
    patch: Partial<Omit<RuleRecord, 'id' | 'createdAt' | 'updatedAt'>>
  ): RuleRecord | null {
    const columns: Record<string, string> = {
      name: 'name',
      matchType: 'match_type',
      operator: 'operator',
      value: 'value',
      templateId: 'template_id',
      priority: 'priority',
      isActive: 'is_active',
    }

    const sets: string[] = []
    const params: any[] = []
    for (const [key, column] of Object.entries(columns)) {
      const value = (patch as any)[key]
      if (value === undefined) continue
      sets.push(`${column} = ?`)
      params.push(key === 'isActive' ? toInt(value) : value)
    }
    if (sets.length === 0) return this.get(id)

    sets.push('updated_at = ?')
    params.push(nowIso(), id)
    getDb().prepare(`UPDATE rules SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    return this.get(id)
  },

  get(id: string): RuleRecord | null {
    const row = getDb().prepare('SELECT * FROM rules WHERE id = ?').get(id)
    return row ? toRule(row) : null
  },

  /**
   * Rules in evaluation order.
   *
   * The ORDER BY is the resolver's tie-break, materialised in SQL so both the
   * UI listing and the matcher see the same sequence: priority first, then
   * creation time. Anything left to storage order would make matching depend on
   * row layout.
   */
  list(options: { activeOnly?: boolean } = {}): RuleRecord[] {
    const clause = options.activeOnly ? 'WHERE is_active = 1' : ''
    return getDb()
      .prepare(`SELECT * FROM rules ${clause} ORDER BY priority DESC, created_at ASC, id ASC`)
      .all()
      .map(toRule)
  },

  remove(id: string): void {
    getDb().prepare('DELETE FROM rules WHERE id = ?').run(id)
  },
}

// ════════════════════════════════════════════════════════════════════════════
// Batches
// ════════════════════════════════════════════════════════════════════════════

function toBatch(row: any): BatchRecord {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    totalJobs: row.total_jobs,
    completedJobs: row.completed_jobs,
    failedJobs: row.failed_jobs,
    cancelledJobs: row.cancelled_jobs,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }
}

export const batches = {
  create(name: string): BatchRecord {
    const db = getDb()
    const id = newId('bat')
    const ts = nowIso()
    db.prepare(
      `INSERT INTO batches (id, name, status, created_at, updated_at) VALUES (?,?,'queued',?,?)`
    ).run(id, name, ts, ts)
    return this.get(id)!
  },

  get(id: string): BatchRecord | null {
    const row = getDb().prepare('SELECT * FROM batches WHERE id = ?').get(id)
    return row ? toBatch(row) : null
  },

  list(limit = 50): BatchRecord[] {
    return getDb()
      .prepare('SELECT * FROM batches ORDER BY created_at DESC LIMIT ?')
      .all(limit)
      .map(toBatch)
  },

  setTotal(id: string, total: number): void {
    getDb()
      .prepare('UPDATE batches SET total_jobs = ?, updated_at = ? WHERE id = ?')
      .run(total, nowIso(), id)
  },

  setStatus(id: string, status: BatchStatus): void {
    const ts = nowIso()
    const extra =
      status === 'running'
        ? ', started_at = COALESCE(started_at, ?)'
        : status === 'completed' || status === 'failed' || status === 'cancelled'
          ? ', completed_at = ?'
          : ''
    const params: any[] = [status, ts]
    if (extra) params.push(ts)
    params.push(id)
    getDb()
      .prepare(`UPDATE batches SET status = ?, updated_at = ?${extra} WHERE id = ?`)
      .run(...params)
  },

  /**
   * Recompute progress counters from the jobs table and settle the batch status.
   *
   * Derived rather than incremented: a worker crash between "job completed" and
   * "counter incremented" would otherwise leave a batch permanently short of
   * its total and stuck at `running`.
   */
  refresh(id: string): BatchRecord | null {
    return transaction(db => {
      const row = db
        .prepare(
          `SELECT
             COUNT(*) AS total,
             SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
             SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
             SUM(CASE WHEN status IN ('pending','claimed','running') THEN 1 ELSE 0 END) AS active
           FROM jobs WHERE batch_id = ?`
        )
        .get(id) as any

      const total = row?.total ?? 0
      const completed = row?.completed ?? 0
      const failed = row?.failed ?? 0
      const cancelled = row?.cancelled ?? 0
      const active = row?.active ?? 0

      const current = db.prepare('SELECT status FROM batches WHERE id = ?').get(id) as any
      let status: BatchStatus = current?.status ?? 'queued'

      if (status !== 'cancelled') {
        if (active > 0) status = 'running'
        else if (total === 0) status = 'queued'
        else if (failed > 0 && completed === 0) status = 'failed'
        else status = 'completed'
      }

      const ts = nowIso()
      const terminal = status === 'completed' || status === 'failed' || status === 'cancelled'
      db.prepare(
        `UPDATE batches SET
           total_jobs = ?, completed_jobs = ?, failed_jobs = ?, cancelled_jobs = ?,
           status = ?, updated_at = ?,
           started_at = CASE WHEN started_at IS NULL AND ? > 0 THEN ? ELSE started_at END,
           completed_at = CASE WHEN ? THEN COALESCE(completed_at, ?) ELSE NULL END
         WHERE id = ?`
      ).run(
        total,
        completed,
        failed,
        cancelled,
        status,
        ts,
        completed + failed + active,
        ts,
        terminal ? 1 : 0,
        ts,
        id
      )

      const updated = db.prepare('SELECT * FROM batches WHERE id = ?').get(id)
      return updated ? toBatch(updated) : null
    })
  },

  remove(id: string): void {
    getDb().prepare('DELETE FROM batches WHERE id = ?').run(id)
  },
}

// ════════════════════════════════════════════════════════════════════════════
// Creatives
// ════════════════════════════════════════════════════════════════════════════

function toCreative(row: any): CreativeRecord {
  return {
    id: row.id,
    productId: row.product_id,
    imageId: row.image_id,
    templateId: row.template_id,
    batchId: row.batch_id,
    sourceHash: row.source_hash,
    visionId: row.vision_id,
    storageKey: row.storage_key,
    mimeType: row.mime_type,
    width: row.width,
    height: row.height,
    byteSize: row.byte_size,
    framing: parseJson<FramingResult | null>(row.framing, null),
    renderMs: row.render_ms,
    createdAt: row.created_at,
  }
}

export const creatives = {
  put(input: Omit<CreativeRecord, 'id' | 'createdAt'>): CreativeRecord {
    const db = getDb()
    db.prepare(
      `INSERT INTO creatives (
         id, product_id, image_id, template_id, batch_id, source_hash, vision_id,
         storage_key, mime_type, width, height, byte_size, framing, render_ms, created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (image_id, template_id) DO UPDATE SET
         batch_id = excluded.batch_id,
         vision_id = excluded.vision_id,
         storage_key = excluded.storage_key,
         mime_type = excluded.mime_type,
         width = excluded.width,
         height = excluded.height,
         byte_size = excluded.byte_size,
         framing = excluded.framing,
         render_ms = excluded.render_ms,
         created_at = excluded.created_at`
    ).run(
      newId('crt'),
      input.productId,
      input.imageId,
      input.templateId,
      input.batchId,
      input.sourceHash,
      input.visionId,
      input.storageKey,
      input.mimeType,
      input.width,
      input.height,
      input.byteSize,
      input.framing ? JSON.stringify(input.framing) : null,
      input.renderMs,
      nowIso()
    )
    return this.findByImageAndTemplate(input.imageId, input.templateId)!
  },

  findByImageAndTemplate(imageId: string, templateId: string): CreativeRecord | null {
    const row = getDb()
      .prepare('SELECT * FROM creatives WHERE image_id = ? AND template_id = ?')
      .get(imageId, templateId)
    return row ? toCreative(row) : null
  },

  get(id: string): CreativeRecord | null {
    const row = getDb().prepare('SELECT * FROM creatives WHERE id = ?').get(id)
    return row ? toCreative(row) : null
  },

  listByProduct(productId: string): CreativeRecord[] {
    return getDb()
      .prepare('SELECT * FROM creatives WHERE product_id = ? ORDER BY created_at DESC')
      .all(productId)
      .map(toCreative)
  },

  listByBatch(batchId: string, limit = 500): CreativeRecord[] {
    return getDb()
      .prepare('SELECT * FROM creatives WHERE batch_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(batchId, limit)
      .map(toCreative)
  },

  list(limit = 100, offset = 0): CreativeRecord[] {
    return getDb()
      .prepare('SELECT * FROM creatives ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset)
      .map(toCreative)
  },

  count(): number {
    const row = getDb().prepare('SELECT COUNT(*) AS n FROM creatives').get() as any
    return row?.n ?? 0
  },

  remove(id: string): void {
    getDb().prepare('DELETE FROM creatives WHERE id = ?').run(id)
  },

  removeForBatch(batchId: string): number {
    return getDb().prepare('DELETE FROM creatives WHERE batch_id = ?').run(batchId).changes
  },

  /** Storage keys for a batch's creatives — captured before deleting the rows. */
  keysForBatch(batchId: string): string[] {
    return (
      getDb()
        .prepare('SELECT storage_key AS k FROM creatives WHERE batch_id = ?')
        .all(batchId) as any[]
    ).map(r => r.k)
  },

  keysForProduct(productId: string): string[] {
    return (
      getDb()
        .prepare('SELECT storage_key AS k FROM creatives WHERE product_id = ?')
        .all(productId) as any[]
    ).map(r => r.k)
  },

  keysForImport(importId: string): string[] {
    return (
      getDb()
        .prepare(
          `SELECT c.storage_key AS k FROM creatives c
           JOIN images i ON i.id = c.image_id
           WHERE i.import_id = ?`
        )
        .all(importId) as any[]
    ).map(r => r.k)
  },
}

export { getDb, transaction, nowIso, type Db }
