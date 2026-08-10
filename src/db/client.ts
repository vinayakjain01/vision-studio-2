/**
 * SQLite connection — one handle per process.
 *
 * Vision Studio runs a Next.js server plus a pool of worker threads that all
 * talk to the same database file. WAL mode makes that safe: readers never block
 * the writer, and the single writer is serialised by SQLite itself. `busy_timeout`
 * absorbs the brief contention when several render workers finish at once
 * instead of surfacing SQLITE_BUSY to callers.
 *
 * Server-only (including worker threads). Never import from a client component.
 */

import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import { config } from '@/config'

export type Db = Database.Database

declare global {
  // Next.js dev server hot-reloads modules; without a global cache we would
  // leak a file handle on every edit.
  var __visionStudioDb: Db | undefined
}

function open(): Db {
  fs.mkdirSync(path.dirname(config.paths.database), { recursive: true })

  const db = new Database(config.paths.database)

  // WAL: concurrent readers + one writer. Required for the worker pool.
  db.pragma('journal_mode = WAL')
  // NORMAL is the correct durability level under WAL — a crash can lose the
  // last transaction but never corrupts the file. Everything we write is
  // reproducible from the originals on disk, so fsync-per-commit is not worth
  // the throughput cost during bulk generation.
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 10000')
  // Keep the temp store in memory — mask/landmark JSON sorts and joins are
  // small but frequent.
  db.pragma('temp_store = MEMORY')
  db.pragma('cache_size = -32000') // ~32 MB page cache

  return db
}

export function getDb(): Db {
  if (!global.__visionStudioDb) {
    global.__visionStudioDb = open()
  }
  return global.__visionStudioDb
}

export function closeDb(): void {
  if (global.__visionStudioDb) {
    global.__visionStudioDb.close()
    global.__visionStudioDb = undefined
  }
}

/** ISO-8601 UTC timestamp — the only time format stored in this database. */
export function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Run `fn` inside an IMMEDIATE transaction.
 *
 * IMMEDIATE (rather than better-sqlite3's default DEFERRED) takes the write
 * lock up front. Job claiming does read-then-write; under DEFERRED two workers
 * can both pass the read and one then fails to upgrade, which surfaces as
 * SQLITE_BUSY rather than a clean "someone else claimed it".
 */
export function transaction<T>(fn: (db: Db) => T): T {
  const db = getDb()
  const wrapped = db.transaction(fn as (db: Db) => T)
  return wrapped.immediate(db)
}

/** SQLite stores booleans as 0/1. */
export const bool = (v: unknown): boolean => v === 1 || v === true
export const toInt = (v: boolean): number => (v ? 1 : 0)

/** Parse a JSON column, returning `fallback` when null/empty/corrupt. */
export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
