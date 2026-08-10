/**
 * Row shapes as they exist in SQLite, and the domain types repositories return.
 *
 * The `*Row` interfaces mirror the columns exactly (0/1 for booleans, JSON as
 * strings). Repositories map them into the domain types below, which use real
 * booleans and parsed objects. Nothing outside `src/db/` should see a `*Row`.
 */

import type { VisionMetadata, ShotType, GarmentType } from '@/vision/types'
import type { TemplateDocument } from '@/templates/types'
import type { FramingResult } from '@/framing/types'

// ─── Imports ─────────────────────────────────────────────────────────────────

export type ImportStatus = 'open' | 'importing' | 'completed' | 'failed' | 'cancelled'

export interface ImportRecord {
  id: string
  name: string
  rootPath: string | null
  status: ImportStatus
  totalFiles: number
  importedFiles: number
  skippedFiles: number
  failedFiles: number
  duplicateFiles: number
  error: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

// ─── Products ────────────────────────────────────────────────────────────────

export interface ProductRecord {
  id: string
  importId: string | null
  name: string
  slug: string
  folderPath: string
  category: string | null
  imageCount: number
  primaryImageId: string | null
  createdAt: string
  updatedAt: string
}

// ─── Images ──────────────────────────────────────────────────────────────────

export type VisionStatus = 'pending' | 'processing' | 'ready' | 'failed' | 'unavailable'

export interface ImageRecord {
  id: string
  productId: string
  importId: string | null
  sourceHash: string
  storageKey: string
  fileName: string
  relativePath: string
  mimeType: string
  byteSize: number
  width: number
  height: number
  exifOrientation: number | null
  hasAlpha: boolean
  colorSpace: string | null
  capturedAt: string | null
  cameraMake: string | null
  cameraModel: string | null
  position: number
  isPrimary: boolean
  visionStatus: VisionStatus
  createdAt: string
  updatedAt: string
}

// ─── Vision ──────────────────────────────────────────────────────────────────

export interface VisionRecord {
  id: string
  sourceHash: string
  engineVersion: string
  schemaVersion: number
  provider: string
  status: 'ready' | 'failed' | 'unavailable'
  imageWidth: number
  imageHeight: number
  personCount: number
  faceCount: number
  shotType: ShotType | null
  garmentType: GarmentType | null
  overallConfidence: number
  payload: VisionMetadata
  modelVersions: Record<string, string>
  durationMs: number
  error: string | null
  createdAt: string
}

export type DerivedAssetKind =
  | 'person_mask'
  | 'garment_mask'
  | 'cutout'
  | 'preview'
  | 'debug_overlay'

export interface DerivedAssetRecord {
  id: string
  sourceHash: string
  kind: DerivedAssetKind
  storageKey: string
  mimeType: string
  width: number
  height: number
  byteSize: number
  createdAt: string
}

// ─── Templates ───────────────────────────────────────────────────────────────

export interface TemplateRecord {
  id: string
  name: string
  description: string | null
  category: string | null
  document: TemplateDocument
  thumbnailKey: string | null
  isActive: boolean
  createdAt: string
  updatedAt: string
}

// ─── Rules ───────────────────────────────────────────────────────────────────

export type RuleMatchType =
  | 'folder'
  | 'category'
  | 'import'
  | 'shot_type'
  | 'garment_type'
  | 'name'
  | 'default'

export type RuleOperator =
  | 'equals'
  | 'contains'
  | 'starts_with'
  | 'ends_with'
  | 'matches'
  | 'any'

export interface RuleRecord {
  id: string
  name: string
  matchType: RuleMatchType
  operator: RuleOperator
  value: string
  templateId: string
  priority: number
  isActive: boolean
  createdAt: string
  updatedAt: string
}

// ─── Batches & jobs ──────────────────────────────────────────────────────────

export type BatchStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface BatchRecord {
  id: string
  name: string
  status: BatchStatus
  totalJobs: number
  completedJobs: number
  failedJobs: number
  cancelledJobs: number
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
}

export type JobKind = 'vision' | 'render' | 'background_fill'
export type JobStatus = 'pending' | 'claimed' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface VisionJobPayload {
  imageId: string
  sourceHash: string
  storageKey: string
  /** Re-run even when a cached analysis for this engine version exists. */
  force?: boolean
}

export interface RenderJobPayload {
  imageId: string
  productId: string
  templateId: string
  sourceHash: string
}

/**
 * Same shape as a render job, deliberately: it needs the same lookups (image,
 * template, vision metadata) to solve the framing and know how much padding
 * actually needs generating. Kept as a distinct type rather than a type alias
 * so the two are free to diverge later without one silently typing the other.
 */
export interface BackgroundFillJobPayload {
  imageId: string
  productId: string
  templateId: string
  sourceHash: string
}

export type JobPayload = VisionJobPayload | RenderJobPayload | BackgroundFillJobPayload

export interface JobRecord<P = JobPayload> {
  id: string
  kind: JobKind
  status: JobStatus
  priority: number
  batchId: string | null
  dedupeKey: string | null
  payload: P
  attempts: number
  maxAttempts: number
  workerId: string | null
  claimedAt: string | null
  heartbeatAt: string | null
  /** Claimable again once this passes. Null means claimable immediately. */
  availableAt: string | null
  error: string | null
  result: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

// ─── Creatives ───────────────────────────────────────────────────────────────

export interface CreativeRecord {
  id: string
  productId: string
  imageId: string
  templateId: string
  batchId: string | null
  sourceHash: string
  visionId: string | null
  storageKey: string
  mimeType: string
  width: number
  height: number
  byteSize: number
  framing: FramingResult | null
  renderMs: number
  createdAt: string
}
