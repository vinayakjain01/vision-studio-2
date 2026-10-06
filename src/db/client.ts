/**
 * SQLite connections.
 *
 * Two kinds of handle, deliberately different lifecycles:
 *
 *  - The CONTROL-PLANE handle (`getControlDb()`) is a true one-per-process
 *    singleton, same pattern this file always used — there is only ever one
 *    control.db.
 *  - TENANT handles (`getDb()`) are opened lazily, one per tenant, kept in a
 *    bounded LRU map. `getDb()` resolves which tenant from the ambient
 *    `TenantContext` (`src/tenancy/context.ts`) and throws if none is set —
 *    there is no default tenant and no fallback. This is the fail-closed
 *    half of tenant isolation: a code path that forgot to establish context
 *    cannot accidentally read or write ANY tenant's data, including the
 *    first/only one.
 *
 * WAL mode makes concurrent access safe within one file: readers never block
 * the writer, and the single writer is serialised by SQLite itself.
 * `busy_timeout` absorbs brief contention when several workers finish at
 * once instead of surfacing SQLITE_BUSY to callers.
 *
 * Server-only (including worker processes). Never import from a client
 * component.
 */

import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import { config, tenantPaths } from '@/config'
import { tryCurrentTenant } from '@/tenancy/context'

export type Db = Database.Database

/** Open tenant handles kept alive; the LRU evicts past this. */
const MAX_OPEN_TENANT_HANDLES = 24

declare global {
  // Next.js dev server hot-reloads modules; without globals we'd leak a
  // file handle (or N of them) on every edit.
  var __visionStudioControlDb: Db | undefined
  var __visionStudioTenantDbs: Map<string, Db> | undefined
}

function applyPragmas(db: Db): void {
  db.pragma('journal_mode = WAL')
  // NORMAL is the correct durability level under WAL — a crash can lose the
  // last transaction but never corrupts the file. Everything we write is
  // reproducible from the originals on disk, so fsync-per-commit is not
  // worth the throughput cost during bulk generation.
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 10000')
  db.pragma('temp_store = MEMORY')
  db.pragma('cache_size = -32000') // ~32 MB page cache per handle
}

function openControlDb(): Db {
  fs.mkdirSync(path.dirname(config.paths.controlDatabase), { recursive: true })
  const db = new Database(config.paths.controlDatabase)
  applyPragmas(db)
  return db
}

export function getControlDb(): Db {
  if (!global.__visionStudioControlDb) {
    global.__visionStudioControlDb = openControlDb()
  }
  return global.__visionStudioControlDb
}

export function closeControlDb(): void {
  if (global.__visionStudioControlDb) {
    global.__visionStudioControlDb.close()
    global.__visionStudioControlDb = undefined
  }
}

function tenantHandles(): Map<string, Db> {
  if (!global.__visionStudioTenantDbs) {
    global.__visionStudioTenantDbs = new Map()
  }
  return global.__visionStudioTenantDbs
}

function openTenantDb(tenantId: string): Db {
  const paths = tenantPaths(tenantId)
  fs.mkdirSync(path.dirname(paths.database), { recursive: true })
  const db = new Database(paths.database)
  applyPragmas(db)
  return db
}

/**
 * Open (or reuse) a tenant's handle directly, by ID, with NO dependency on
 * `TenantContext`.
 *
 * This is the one deliberate, explicit exception to "every tenant DB access
 * goes through the ambient context" — for maintenance code that is not
 * serving a request and has no session to derive a tenant from at all:
 * `scripts/migrate.ts` iterating every tenant, `scripts/tenants-migrate-
 * legacy.ts` creating the first one, and the worker pool's current
 * single-default-tenant bridge (see `src/jobs/pool.ts` — full per-job
 * tenant binding is P3 scope). Application code serving a live request must
 * use `getDb()` instead, never this — a lint rule enforces that boundary
 * (P2).
 *
 * Same LRU as `getDb()` — both read and write the same `tenantHandles()`
 * map, so a tenant opened one way is reused the other.
 */
type TenantDbOpenListener = (tenantId: string) => void
let tenantDbOpenListeners: TenantDbOpenListener[] = []

/**
 * Test-only hook: registers a callback fired with the tenant ID every time
 * `openTenantDbById` is asked for a handle (cache hit or miss). Lets the
 * isolation test suite prove a given request/session only ever touches its
 * own tenant's database file, instead of relying on code review alone to
 * believe it. Not used by application code. Returns an unsubscribe function.
 */
export function __onTenantDbOpen(listener: TenantDbOpenListener): () => void {
  tenantDbOpenListeners.push(listener)
  return () => {
    tenantDbOpenListeners = tenantDbOpenListeners.filter(l => l !== listener)
  }
}

export function openTenantDbById(tenantId: string): Db {
  for (const listener of tenantDbOpenListeners) listener(tenantId)

  const handles = tenantHandles()
  const existing = handles.get(tenantId)
  if (existing) {
    // Re-insertion moves it to the end — Map iteration order is insertion
    // order, which `evictIfNeeded` relies on as the LRU order.
    handles.delete(tenantId)
    handles.set(tenantId, existing)
    return existing
  }

  const db = openTenantDb(tenantId)
  handles.set(tenantId, db)
  evictIfNeeded(handles)
  return db
}

function evictIfNeeded(handles: Map<string, Db>): void {
  while (handles.size > MAX_OPEN_TENANT_HANDLES) {
    const oldestKey = handles.keys().next().value
    if (oldestKey === undefined) return
    const oldest = handles.get(oldestKey)
    handles.delete(oldestKey)
    try {
      oldest?.close()
    } catch {
      // Already closed or mid-transaction elsewhere; nothing more to do.
    }
  }
}

/**
 * The tenant handle for whichever tenant `TenantContext` says this call is
 * running as. Throws if no context is set — see the module doc and
 * `src/tenancy/context.ts`.
 */
export function getDb(): Db {
  const ctx = tryCurrentTenant()
  if (!ctx) {
    throw new Error(
      'getDb() called with no tenant context set — every request path must establish one ' +
        '(see src/lib/api.ts for routes, src/tenancy/page-context.ts for pages) before ' +
        'touching tenant data. Maintenance scripts and workers must use openTenantDbById() ' +
        'instead, explicitly.'
    )
  }
  return openTenantDbById(ctx.tenantId)
}

/** Closes every open handle — control-plane and every cached tenant. */
export function closeDb(): void {
  closeControlDb()
  const handles = tenantHandles()
  for (const db of handles.values()) {
    try {
      db.close()
    } catch {
      // Ignore — we're shutting down anyway.
    }
  }
  handles.clear()
}

/** ISO-8601 UTC timestamp — the only time format stored in this database. */
export function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Run `fn` inside an IMMEDIATE transaction, against whichever tenant handle
 * `getDb()` currently resolves to.
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

/** Same as `transaction()`, against an explicit handle — for control-plane code and scripts that don't have (or want) an ambient tenant context. */
export function transactionOn<T>(db: Db, fn: (db: Db) => T): T {
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
