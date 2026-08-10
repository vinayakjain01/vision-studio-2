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
import { getDb, nowIso, type Db } from './client'

const SCHEMA_FILE = path.join(process.cwd(), 'src', 'db', 'schema.sql')
const MIGRATIONS_DIR = path.join(process.cwd(), 'src', 'db', 'migrations')

export interface MigrateResult {
  baselineApplied: boolean
  applied: string[]
  skipped: string[]
}

export function migrate(db: Db = getDb()): MigrateResult {
  const schema = fs.readFileSync(SCHEMA_FILE, 'utf8')
  db.exec(schema)

  const result: MigrateResult = { baselineApplied: true, applied: [], skipped: [] }

  if (!fs.existsSync(MIGRATIONS_DIR)) return result

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()

  const isApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?')
  const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')

  for (const file of files) {
    if (isApplied.get(file)) {
      result.skipped.push(file)
      continue
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
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

/**
 * Drop every application table. Used by `npm run db:reset`. Media on disk is
 * NOT touched — originals are the source of truth and re-importing them
 * rebuilds everything else.
 */
export function dropAll(db: Db = getDb()): void {
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
