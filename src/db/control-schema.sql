-- Control-plane database (data/control.db).
--
-- Identity, sessions, tenancy and cross-tenant bookkeeping. Deliberately
-- separate from any tenant's app.db: this file is small, never holds a
-- photo or a product name, and is the one database every request touches
-- (to resolve who's asking) before it ever opens a tenant's own data.
--
-- The job queue and its scheduler bookkeeping (tenant_queue_state) are NOT
-- here yet — that's P3 (scheduler) scope. P1 only needs identity, sessions,
-- tenancy, quota SCHEMA (enforcement is also P3), and an audit trail.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id                     TEXT PRIMARY KEY,
  email                  TEXT NOT NULL,
  -- Case-insensitive uniqueness without a generated column: emails are
  -- normalised to lowercase before every insert/lookup (see control-
  -- repositories.ts), so a plain UNIQUE on the stored value is sufficient
  -- and avoids relying on SQLite's COLLATE NOCASE for a column that also
  -- needs exact storage of what the user typed.
  email_lower            TEXT NOT NULL UNIQUE,
  password_hash          TEXT NOT NULL,
  is_platform_admin      INTEGER NOT NULL DEFAULT 0,
  -- Set by an admin-initiated reset; forces a password change on next
  -- login rather than handing back a password over an insecure channel.
  must_change_password   INTEGER NOT NULL DEFAULT 0,
  disabled_at            TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenants (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Users and tenants are separate now even though v1 creates exactly one
-- personal tenant per signed-up user — this table is what makes adding a
-- second member to a tenant later a data change, not a schema change.
CREATE TABLE IF NOT EXISTS memberships (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at  TEXT NOT NULL,
  UNIQUE (user_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_user   ON memberships (user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_tenant ON memberships (tenant_id);

-- The cookie carries only a random 256-bit token; this table stores its
-- SHA-256 hash, never the token itself, so a read of this database (a
-- backup, a leaked file) cannot be used to forge a session.
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE,
  created_at      TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  revoked_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- Login rate limiting. `identifier` is either `ip:<addr>` or
-- `email:<lowercased>` — one table, two namespaces, so a single query can
-- check both the per-IP and per-account window.
CREATE TABLE IF NOT EXISTS login_attempts (
  id             TEXT PRIMARY KEY,
  identifier     TEXT NOT NULL,
  attempted_at   TEXT NOT NULL,
  succeeded      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_identifier ON login_attempts (identifier, attempted_at);

-- Schema only in P1 — enforced by the scheduler/dispatcher in P3. Created
-- now (with a sane default row per tenant, see control-repositories.ts)
-- so the admin page and dispatcher have something to read and edit from
-- day one of P3 rather than needing their own migration.
CREATE TABLE IF NOT EXISTS quotas (
  tenant_id                 TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  max_queued_jobs           INTEGER NOT NULL DEFAULT 500,
  max_images_per_batch      INTEGER NOT NULL DEFAULT 1000,
  max_concurrent_uploads    INTEGER NOT NULL DEFAULT 2,
  max_storage_bytes         INTEGER NOT NULL DEFAULT 10737418240,
  max_ai_extend_per_month   INTEGER NOT NULL DEFAULT 500,
  -- Scheduler weight (§3.2 of docs/MULTI_TENANCY.md) — admin-editable,
  -- defaults to equal share.
  weight                    REAL NOT NULL DEFAULT 1.0
);

-- Monthly usage, metered so AI Extend cost can be attributed per tenant.
-- `period` is 'YYYY-MM' in UTC. Incremented by the dispatcher in P3;
-- `storage_bytes` is a point-in-time gauge (overwritten, not accumulated),
-- the rest are counters.
CREATE TABLE IF NOT EXISTS usage_counters (
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period            TEXT NOT NULL,
  ai_extend_calls   INTEGER NOT NULL DEFAULT 0,
  storage_bytes     INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (tenant_id, period)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id              TEXT PRIMARY KEY,
  actor_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  tenant_id       TEXT REFERENCES tenants(id) ON DELETE SET NULL,
  action          TEXT NOT NULL,
  detail          TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_tenant  ON audit_log (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor   ON audit_log (actor_user_id, created_at DESC);

-- Same bookkeeping pattern as the tenant schema's own table — lets the
-- lazy per-tenant-DB migration scheme and control.db's migration share one
-- `migrate()` implementation (see src/db/migrate.ts).
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TEXT NOT NULL
);
