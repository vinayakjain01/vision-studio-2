/**
 * Schema application.
 *
 * `schema.sql` is the idempotent baseline — every statement is CREATE ... IF NOT
 * EXISTS, so applying it to an existing database is a no-op. Changes that cannot
 * be expressed that way (column drops, type changes, backfills) go in
 * `src/db/migrations/NNN-name.sql` and are applied once each, in filename order,
 * recorded in `schema_migrations`.
 */

import fs from 'fs'
import path from 'path'
import { nowIso, type Db } from './client'

const SCHEMA_FILE = path.join(process.cwd(), 'src', 'db', 'schema.sql')
const MIGRATIONS_DIR = path.join(process.cwd(), 'src', 'db', 'migrations')

const CONTROL_SCHEMA_FILE = path.join(process.cwd(), 'src', 'db', 'control-schema.sql')
const CONTROL_MIGRATIONS_DIR = path.join(process.cwd(), 'src', 'db', 'control-migrations')

export interface MigrateResult {
  baselineApplied: boolean
  applied: string[]
  skipped: string[]
}

/**
 * Apply a schema (baseline + versioned migrations) to one open handle.
 *
 * Takes the handle explicitly rather than defaulting to the global
 * singleton `getDb()` used to provide — that singleton no longer exists:
 * `getDb()` is tenant-context-dependent now (see `client.ts`), and this
 * function runs against tenant handles, the control-plane handle, and
 * handles opened directly by maintenance scripts outside any request
 * context. Every call site must now say which handle and which schema.
 */
export function migrate(
  db: Db,
  options?: { schemaFile?: string; migrationsDir?: string }
): MigrateResult {
  const schemaFile = options?.schemaFile ?? SCHEMA_FILE
  const migrationsDir = options?.migrationsDir ?? MIGRATIONS_DIR

  const schema = fs.readFileSync(schemaFile, 'utf8')
  db.exec(schema)

  const result: MigrateResult = { baselineApplied: true, applied: [], skipped: [] }

  if (!fs.existsSync(migrationsDir)) return result

  const files = fs
    .readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort()

  const isApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?')
  const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')

  for (const file of files) {
    if (isApplied.get(file)) {
      result.skipped.push(file)
      continue
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
    // Each migration is atomic: either the whole file applies and is recorded,
    // or nothing changes and the error propagates.
    db.transaction(() => {
      db.exec(sql)
      record.run(file, nowIso())
    })()
    result.applied.push(file)
  }

  return result
}

/** `migrate()` against the control-plane schema instead of a tenant's. */
export function migrateControl(db: Db): MigrateResult {
  return migrate(db, { schemaFile: CONTROL_SCHEMA_FILE, migrationsDir: CONTROL_MIGRATIONS_DIR })
}

/**
 * Drop every application table in a TENANT database. Used by `npm run
 * db:reset`. Media on disk is NOT touched — originals are the source of
 * truth and re-importing them rebuilds everything else. Never call this
 * against the control-plane handle — it does not have these tables.
 */
export function dropAll(db: Db): void {
  const tables = [
    'creatives',
    'jobs',
    'batches',
    'rules',
    'templates',
    'derived_assets',
    'vision_analyses',
    'images',
    'products',
    'imports',
    'schema_migrations',
  ]
  db.pragma('foreign_keys = OFF')
  db.transaction(() => {
    for (const table of tables) db.exec(`DROP TABLE IF EXISTS ${table}`)
  })()
  db.pragma('foreign_keys = ON')
}
