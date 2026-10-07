import Database from 'better-sqlite3'
import { describe, it, expect } from 'vitest'
import { migrateTenantJobs } from '../../scripts/lib/legacy-migration-jobs'
import { createTestTenant } from '../helpers/tenancy-fixture'
import { getControlDb } from '@/db/client'

/** A minimal in-memory DB shaped like a pre-P3 tenant app.db's `jobs` table. */
function makeLegacyTenantDb(rows: Record<string, unknown>[]): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY, kind TEXT, status TEXT, priority INTEGER, batch_id TEXT,
      dedupe_key TEXT, payload TEXT, attempts INTEGER, max_attempts INTEGER, worker_id TEXT,
      claimed_at TEXT, heartbeat_at TEXT, available_at TEXT, error TEXT, result TEXT,
      created_at TEXT, updated_at TEXT, completed_at TEXT
    )
  `)
  const insert = db.prepare(
    `INSERT INTO jobs (id, kind, status, priority, batch_id, dedupe_key, payload, attempts, max_attempts,
                        worker_id, claimed_at, heartbeat_at, available_at, error, result, created_at,
                        updated_at, completed_at)
     VALUES (@id, @kind, @status, @priority, @batch_id, @dedupe_key, @payload, @attempts, @max_attempts,
             @worker_id, @claimed_at, @heartbeat_at, @available_at, @error, @result, @created_at,
             @updated_at, @completed_at)`
  )
  for (const row of rows) insert.run(row as any)
  return db
}

const BASE_ROW = {
  dedupe_key: null,
  worker_id: null,
  claimed_at: null,
  heartbeat_at: null,
  available_at: null,
  error: null,
  result: null,
  batch_id: null,
  completed_at: null,
}

describe('legacy migration: tenant jobs copy', () => {
  it('copies completed/failed/cancelled rows unchanged, and resets live rows to pending', () => {
    const t = createTestTenant('T')
    const legacyDb = makeLegacyTenantDb([
      { ...BASE_ROW, id: 'job_done', kind: 'vision', status: 'completed', priority: 10, attempts: 1, max_attempts: 3, payload: '{}', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:05Z', completed_at: '2025-01-01T00:00:05Z' },
      { ...BASE_ROW, id: 'job_failed', kind: 'vision', status: 'failed', priority: 10, attempts: 3, max_attempts: 3, payload: '{}', error: 'boom', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:05Z', completed_at: '2025-01-01T00:00:05Z' },
      { ...BASE_ROW, id: 'job_pending', kind: 'vision', status: 'pending', priority: 10, attempts: 0, max_attempts: 3, payload: '{}', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' },
      { ...BASE_ROW, id: 'job_running', kind: 'render', status: 'running', priority: 50, attempts: 1, max_attempts: 3, payload: '{}', worker_id: 'old-worker', claimed_at: '2025-01-01T00:00:01Z', heartbeat_at: '2025-01-01T00:00:02Z', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:02Z' },
    ])

    const result = migrateTenantJobs(t.tenantId, legacyDb, getControlDb())
    expect(result).toEqual({ copied: 4, legacyCount: 4 })

    const rows = getControlDb()
      .prepare('SELECT * FROM jobs WHERE tenant_id = ? ORDER BY id')
      .all(t.tenantId) as any[]
    const byId = Object.fromEntries(rows.map(r => [r.id, r]))

    expect(byId.job_done.status).toBe('completed')
    expect(byId.job_done.completed_at).toBe('2025-01-01T00:00:05Z')

    expect(byId.job_failed.status).toBe('failed')
    expect(byId.job_failed.error).toBe('boom')

    // Live rows reset to pending, worker/lease fields cleared.
    expect(byId.job_pending.status).toBe('pending')
    expect(byId.job_running.status).toBe('pending')
    expect(byId.job_running.worker_id).toBeNull()
    expect(byId.job_running.claimed_at).toBeNull()
    expect(byId.job_running.heartbeat_at).toBeNull()
    expect(byId.job_running.lease_expires_at).toBeNull()
  })

  it('infers priority_class from the legacy numeric priority', () => {
    const t = createTestTenant('T')
    const legacyDb = makeLegacyTenantDb([
      { ...BASE_ROW, id: 'job_adhoc', kind: 'render', status: 'pending', priority: 0, attempts: 0, max_attempts: 3, payload: '{}', created_at: 'x', updated_at: 'x' },
      { ...BASE_ROW, id: 'job_bulk', kind: 'vision', status: 'pending', priority: 10, attempts: 0, max_attempts: 3, payload: '{}', created_at: 'x', updated_at: 'x' },
    ])

    migrateTenantJobs(t.tenantId, legacyDb, getControlDb())

    const rows = getControlDb()
      .prepare('SELECT id, priority_class FROM jobs WHERE tenant_id = ? ORDER BY id')
      .all(t.tenantId) as any[]
    const byId = Object.fromEntries(rows.map(r => [r.id, r.priority_class]))
    expect(byId.job_adhoc).toBe('interactive')
    expect(byId.job_bulk).toBe('bulk')
  })

  it('is idempotent — running it twice never double-inserts', () => {
    const t = createTestTenant('T')
    const legacyDb = makeLegacyTenantDb([
      { ...BASE_ROW, id: 'job_x', kind: 'vision', status: 'completed', priority: 10, attempts: 1, max_attempts: 3, payload: '{}', created_at: 'x', updated_at: 'x', completed_at: 'x' },
    ])

    const first = migrateTenantJobs(t.tenantId, legacyDb, getControlDb())
    const second = migrateTenantJobs(t.tenantId, legacyDb, getControlDb())
    expect(first.copied).toBe(1)
    expect(second.copied).toBe(0) // INSERT OR IGNORE — already there

    const count = (
      getControlDb().prepare('SELECT COUNT(*) AS n FROM jobs WHERE tenant_id = ?').get(t.tenantId) as { n: number }
    ).n
    expect(count).toBe(1)
  })

  it('is a no-op when the tenant app.db has no legacy jobs table at all', () => {
    const t = createTestTenant('T')
    const emptyDb = new Database(':memory:')
    const result = migrateTenantJobs(t.tenantId, emptyDb, getControlDb())
    expect(result).toEqual({ copied: 0, legacyCount: 0 })
  })
})
