-- ════════════════════════════════════════════════════════════════════════════
-- Vision Studio — schema
--
-- Applied by `npm run db:migrate` (scripts/migrate.ts). The file is executed as
-- a single idempotent script: every statement is CREATE ... IF NOT EXISTS, so
-- re-running it is safe. Schema evolution beyond this baseline goes through
-- numbered files in src/db/migrations/.
--
-- Design notes
--  * All ids are text UUIDs generated in application code (nanoid), never
--    autoincrement — ids appear in file paths and URLs.
--  * Timestamps are ISO-8601 UTC strings. SQLite has no date type, and ISO
--    strings sort correctly as text.
--  * Anything derived from pixels is keyed by `source_hash` (sha256 of the
--    original bytes), NOT by image id. Two products that share identical bytes
--    share one vision analysis and one set of derived assets.
-- ════════════════════════════════════════════════════════════════════════════

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── Imports ──────────────────────────────────────────────────────────────────
-- One row per folder-upload session. Groups products for the rules engine
-- ("everything from the AW25 drop uses this template") and for batch reporting.

CREATE TABLE IF NOT EXISTS imports (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,             -- root folder name as picked by the user
  root_path         TEXT,                      -- client-reported directory path, informational
  status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'importing', 'completed', 'failed', 'cancelled')),
  total_files       INTEGER NOT NULL DEFAULT 0,
  imported_files    INTEGER NOT NULL DEFAULT 0,
  skipped_files     INTEGER NOT NULL DEFAULT 0,
  failed_files      INTEGER NOT NULL DEFAULT 0,
  duplicate_files   INTEGER NOT NULL DEFAULT 0,
  error             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  completed_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_imports_created ON imports (created_at DESC);

-- ── Products ─────────────────────────────────────────────────────────────────
-- A product is a grouping of images. For folder uploads the grouping key is the
-- containing folder path, so `AW25/dresses/red-midi/{01,02,03}.jpg` becomes one
-- product with three images rather than three products.

CREATE TABLE IF NOT EXISTS products (
  id                TEXT PRIMARY KEY,
  import_id         TEXT REFERENCES imports (id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  slug              TEXT NOT NULL,
  -- Forward-slash normalised path of the folder this product came from,
  -- relative to the import root. '' for files at the root. This is the primary
  -- key the rules engine matches folder patterns against.
  folder_path       TEXT NOT NULL DEFAULT '',
  -- Last path segment of folder_path — the natural "category" for a catalog
  -- laid out as category/product/*.jpg.
  category          TEXT,
  image_count       INTEGER NOT NULL DEFAULT 0,
  primary_image_id  TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (import_id, folder_path, slug)
);

CREATE INDEX IF NOT EXISTS idx_products_import   ON products (import_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products (category);
CREATE INDEX IF NOT EXISTS idx_products_folder   ON products (folder_path);
CREATE INDEX IF NOT EXISTS idx_products_created  ON products (created_at DESC);

-- ── Images ───────────────────────────────────────────────────────────────────
-- `source_hash` is sha256 of the original file bytes and is the join key to
-- vision_analyses. `storage_key` is the path under data/media/originals.

CREATE TABLE IF NOT EXISTS images (
  id                TEXT PRIMARY KEY,
  product_id        TEXT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  import_id         TEXT REFERENCES imports (id) ON DELETE SET NULL,
  source_hash       TEXT NOT NULL,
  storage_key       TEXT NOT NULL,
  file_name         TEXT NOT NULL,
  relative_path     TEXT NOT NULL,             -- path within the picked folder tree
  mime_type         TEXT NOT NULL,
  byte_size         INTEGER NOT NULL,
  width             INTEGER NOT NULL,
  height            INTEGER NOT NULL,
  -- Extracted metadata (Phase 1). EXIF orientation is applied to width/height
  -- above, so those are always display dimensions.
  exif_orientation  INTEGER,
  has_alpha         INTEGER NOT NULL DEFAULT 0,
  color_space       TEXT,
  captured_at       TEXT,
  camera_make       TEXT,
  camera_model      TEXT,
  position          INTEGER NOT NULL DEFAULT 0,
  is_primary        INTEGER NOT NULL DEFAULT 0,
  -- Denormalised mirror of the analysis lifecycle for cheap list queries.
  vision_status     TEXT NOT NULL DEFAULT 'pending'
                      CHECK (vision_status IN ('pending', 'processing', 'ready', 'failed', 'unavailable')),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_images_product ON images (product_id, position);
CREATE INDEX IF NOT EXISTS idx_images_hash    ON images (source_hash);
CREATE INDEX IF NOT EXISTS idx_images_status  ON images (vision_status);
CREATE INDEX IF NOT EXISTS idx_images_import  ON images (import_id);

-- Same bytes must not be imported twice into the same product.
CREATE UNIQUE INDEX IF NOT EXISTS idx_images_product_hash ON images (product_id, source_hash);

-- ── Vision analyses ──────────────────────────────────────────────────────────
-- The reusable output of the Vision Engine. Keyed by (source_hash,
-- engine_version) so a model upgrade produces a new row instead of destroying
-- the old one — creatives generated against the previous version stay
-- reproducible and the debug panel can diff versions.
--
-- `payload` is the full VisionMetadata JSON document (see src/vision/types.ts).
-- The scalar columns beside it are denormalised extracts used for filtering and
-- list rendering; the payload is authoritative.

CREATE TABLE IF NOT EXISTS vision_analyses (
  id                  TEXT PRIMARY KEY,
  source_hash         TEXT NOT NULL,
  engine_version      TEXT NOT NULL,
  schema_version      INTEGER NOT NULL,
  provider            TEXT NOT NULL,
  status              TEXT NOT NULL
                        CHECK (status IN ('ready', 'failed', 'unavailable')),
  image_width         INTEGER NOT NULL,
  image_height        INTEGER NOT NULL,
  person_count        INTEGER NOT NULL DEFAULT 0,
  face_count          INTEGER NOT NULL DEFAULT 0,
  shot_type           TEXT,
  garment_type        TEXT,
  overall_confidence  REAL NOT NULL DEFAULT 0,
  payload             TEXT NOT NULL,           -- VisionMetadata JSON
  model_versions      TEXT NOT NULL,           -- {modelId: version} JSON
  duration_ms         INTEGER NOT NULL DEFAULT 0,
  error               TEXT,
  created_at          TEXT NOT NULL,
  UNIQUE (source_hash, engine_version)
);

CREATE INDEX IF NOT EXISTS idx_vision_hash      ON vision_analyses (source_hash);
CREATE INDEX IF NOT EXISTS idx_vision_shot_type ON vision_analyses (shot_type);
CREATE INDEX IF NOT EXISTS idx_vision_status    ON vision_analyses (status);

-- ── Derived assets ───────────────────────────────────────────────────────────
-- Masks, cutouts and previews the Vision Engine wrote to disk. Separate from
-- the payload so large binaries stay out of the JSON and can be garbage
-- collected independently.

CREATE TABLE IF NOT EXISTS derived_assets (
  id            TEXT PRIMARY KEY,
  source_hash   TEXT NOT NULL,
  kind          TEXT NOT NULL
                  CHECK (kind IN ('person_mask', 'garment_mask', 'cutout', 'preview', 'debug_overlay')),
  storage_key   TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  width         INTEGER NOT NULL,
  height        INTEGER NOT NULL,
  byte_size     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  UNIQUE (source_hash, kind)
);

CREATE INDEX IF NOT EXISTS idx_derived_hash ON derived_assets (source_hash);

-- ── Templates ────────────────────────────────────────────────────────────────
-- `document` is the TemplateDocument JSON (canvas + layers + framing spec).
-- See src/framing/types.ts and src/templates/types.ts.

CREATE TABLE IF NOT EXISTS templates (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  category      TEXT,
  document      TEXT NOT NULL,
  thumbnail_key TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_templates_active ON templates (is_active, updated_at DESC);

-- ── Rules ────────────────────────────────────────────────────────────────────
-- Maps products to templates. Evaluated most-specific-first with a deterministic
-- tie-break (see src/rules/resolver.ts) — priority DESC, then specificity DESC,
-- then created_at ASC, so ordering never depends on storage order.

CREATE TABLE IF NOT EXISTS rules (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  match_type    TEXT NOT NULL
                  CHECK (match_type IN ('folder', 'category', 'import', 'shot_type', 'garment_type', 'name', 'default')),
  operator      TEXT NOT NULL
                  CHECK (operator IN ('equals', 'contains', 'starts_with', 'ends_with', 'matches', 'any')),
  value         TEXT NOT NULL DEFAULT '',
  template_id   TEXT NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
  priority      INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rules_active ON rules (is_active, priority DESC, created_at ASC);

-- ── Generation batches ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS batches (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  total_jobs      INTEGER NOT NULL DEFAULT 0,
  completed_jobs  INTEGER NOT NULL DEFAULT 0,
  failed_jobs     INTEGER NOT NULL DEFAULT 0,
  cancelled_jobs  INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  started_at      TEXT,
  completed_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_batches_created ON batches (created_at DESC);

-- ── Jobs — REMOVED from this schema in P3, moved to control.db ─────────────
-- The queue is now global (one table across every tenant, so a worker can
-- claim fairly across all of them in one transaction — see
-- docs/MULTI_TENANCY.md §3.1 and src/db/control-schema.sql). This baseline
-- deliberately no longer creates a `jobs` table: new tenant databases never
-- get one.
--
-- A tenant database created before this change still HAS its own `jobs`
-- table from when this file used to include it — untouched, on purpose, for
-- rollback (see the P3 phase report and scripts/tenants-migrate-legacy.ts's
-- job-migration step, which copies its rows into control.db once and leaves
-- the original table in place rather than dropping it).

-- ── Creatives ────────────────────────────────────────────────────────────────
-- Rendered output. `framing` stores the exact resolved crop box and anchor
-- targets used, so a creative can be explained (Vision Debug) and reproduced
-- byte-for-byte long after the template has been edited.

CREATE TABLE IF NOT EXISTS creatives (
  id              TEXT PRIMARY KEY,
  product_id      TEXT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  image_id        TEXT NOT NULL REFERENCES images (id) ON DELETE CASCADE,
  template_id     TEXT NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
  batch_id        TEXT REFERENCES batches (id) ON DELETE SET NULL,
  source_hash     TEXT NOT NULL,
  vision_id       TEXT REFERENCES vision_analyses (id) ON DELETE SET NULL,
  storage_key     TEXT NOT NULL,
  mime_type       TEXT NOT NULL DEFAULT 'image/jpeg',
  width           INTEGER NOT NULL,
  height          INTEGER NOT NULL,
  byte_size       INTEGER NOT NULL DEFAULT 0,
  framing         TEXT,                            -- resolved FramingResult JSON
  render_ms       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  UNIQUE (image_id, template_id)
);

CREATE INDEX IF NOT EXISTS idx_creatives_product ON creatives (product_id);
CREATE INDEX IF NOT EXISTS idx_creatives_batch   ON creatives (batch_id);
CREATE INDEX IF NOT EXISTS idx_creatives_created ON creatives (created_at DESC);

-- ── Schema bookkeeping ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TEXT NOT NULL
);
