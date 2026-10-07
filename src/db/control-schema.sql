-- Control-plane database (data/control.db).
--
-- Identity, sessions, tenancy and cross-tenant bookkeeping. Deliberately
-- separate from any tenant's app.db: this file is small, never holds a
-- photo or a product name, and is the one database every request touches
-- (to resolve who's asking) before it ever opens a tenant's own data.
--
-- The job queue and its scheduler bookkeeping (tenant_queue_state) moved
-- here in P3 — see docs/MULTI_TENANCY.md §3.1/§3.2/§5. Quota SCHEMA has been
-- here since P1; P3 adds enforcement (src/jobs/quota.ts) against it.

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
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'suspended', 'pending_deletion')),
  -- Set when an admin marks the tenant for deletion (P5) — the two-step
  -- confirm-by-typing-the-name purge reads this to show how long it's been
  -- pending; NULL unless status = 'pending_deletion'.
  pending_deletion_at   TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
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

-- ── Global job queue (P3) ───────────────────────────────────────────────────
-- Moved here from each tenant's app.db (see docs/MULTI_TENANCY.md §3.1):
-- SQLite's single-writer guarantee is per FILE, and a worker claiming across
-- every tenant's queue in one transaction needs them all in one file. No FK
-- to `batches` — that table lives in the tenant's own app.db, a separate
-- file; cascade-on-delete is an explicit two-step application operation
-- instead (jobs deleted first, then the batch row — see generation-service.ts).
--
-- `tenant_id` is NEVER taken from job payloads or worker-reported data — it
-- is set once, at enqueue time, from whichever tenant's ambient context (an
-- API route) or claimed-job context (a worker, via runWithTenant) called
-- `enqueue()`. Every other queue operation takes it as an explicit parameter
-- scoped by the caller's own context, same principle as `getDb()`.
CREATE TABLE IF NOT EXISTS jobs (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('vision', 'render', 'background_fill')),
  -- 'interactive' jumps a tenant's own 'bulk' backlog and is ALSO fair-shared
  -- across tenants ahead of bulk (see claim() in src/jobs/queue.ts) — a
  -- single-photo render or template-editor preview, vs. an import's vision
  -- analysis or a larger batch. A 'bulk' job waiting past
  -- BULK_MAX_WAIT_SECONDS is promoted here so bulk work can never starve
  -- (see promoteAgedBulkJobs()).
  priority_class    TEXT NOT NULL DEFAULT 'bulk' CHECK (priority_class IN ('interactive', 'bulk')),
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'claimed', 'running', 'completed', 'failed', 'cancelled')),
  priority          INTEGER NOT NULL DEFAULT 100,   -- lower runs sooner, within one tenant's own queue
  batch_id          TEXT,                           -- no FK — see module doc above
  dedupe_key        TEXT,
  payload           TEXT NOT NULL,                  -- IDs/hashes only, never filesystem paths
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 3,
  worker_id         TEXT,
  claimed_at        TEXT,
  -- Explicit expiry, refreshed on every heartbeat. reclaimStale() compares
  -- against this instead of a fixed "heartbeat age" threshold, so a slower
  -- job kind (background_fill, bound by a remote API) can carry a longer
  -- lease without changing the sweep's own cadence.
  lease_expires_at  TEXT,
  heartbeat_at      TEXT,
  -- NULL means claimable as soon as it's pending. Set to a future timestamp
  -- by queue.defer()/a backoff retry.
  available_at      TEXT,
  error             TEXT,
  result            TEXT,
  created_at        TEXT NOT NULL,
  started_at        TEXT,                           -- set when status first becomes 'running'
  updated_at        TEXT NOT NULL,
  completed_at      TEXT
);

-- Claim path: for one tenant, the oldest eligible job of a given kind/class.
-- Walked once per candidate tenant per claim() call (see its doc comment for
-- why this, not a single cross-tenant scan, is what keeps claim latency flat
-- as the table grows) — covers the WHERE and ORDER BY entirely, so each
-- probe is an index seek, never a scan of the whole table.
CREATE INDEX IF NOT EXISTS idx_jobs_tenant_claim
  ON jobs (tenant_id, kind, status, priority_class, priority, created_at);

CREATE INDEX IF NOT EXISTS idx_jobs_batch     ON jobs (tenant_id, batch_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_heartbeat ON jobs (status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_jobs_pending_age ON jobs (priority_class, status, created_at);

-- P5 admin tenants table: "jobs completed in the last 24h, per tenant"
-- (the jobs/hour throughput column). Measured (scripts/bench-admin-queries.ts)
-- at 100k rows: 79ms with a full scan, 27ms with this index — comfortably
-- under the ~50ms bar without needing an hourly rollup.
CREATE INDEX IF NOT EXISTS idx_jobs_completed_at ON jobs (status, completed_at, tenant_id);

-- Scoped to (tenant_id, dedupe_key), not globally — the P1-era single-tenant
-- version of this index let one tenant's in-flight job suppress another
-- tenant's otherwise-identical request (same photo hash, different
-- catalogs). Partial so completed/failed rows never block a legitimate
-- re-run.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedupe
  ON jobs (tenant_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'claimed', 'running');

-- P5 admin tenants table: queue-wait p50/p95 (started_at - created_at).
-- Computing this over a raw 24h window of `jobs` measured at ~100ms per
-- call at 100k rows (scripts/bench-admin-queries.ts) — over the ~50ms bar,
-- and an index didn't help (the result set is a large fraction of the
-- table, so a full scan beats an index-seek-plus-row-lookup for most of
-- it). One row per (tenant, hour) instead: computed from that hour's own
-- jobs only — a small, bounded slice regardless of total table size — by
-- the maintenance sweep (see src/jobs/queue-wait-rollup.ts), so reading
-- "last 24h" means reading at most 24 small rows per tenant, not scanning
-- the jobs table at all. The admin page approximates a 24h percentile as a
-- sample-count-weighted average across these hourly values — not
-- mathematically a true percentile-of-percentiles, but accurate enough for
-- an operational dashboard, and exact for any single hour.
CREATE TABLE IF NOT EXISTS queue_wait_hourly_rollups (
  tenant_id     TEXT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- 'YYYY-MM-DDTHH', UTC.
  hour_bucket   TEXT NOT NULL,
  sample_count  INTEGER NOT NULL,
  p50_ms        REAL NOT NULL,
  p95_ms        REAL NOT NULL,
  computed_at   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, hour_bucket)
);

CREATE INDEX IF NOT EXISTS idx_queue_wait_rollups_bucket ON queue_wait_hourly_rollups (hour_bucket);

-- Denormalized fair-share bookkeeping (§3.2/§5) — `running_jobs` is
-- maintained transactionally by claim()/complete()/fail()/reclaimStale()
-- rather than computed live, so the claim query never does a GROUP BY scan
-- over `jobs`. `weight` starts as a copy of `quotas.weight` (admin-editable
-- scheduler share) at tenant-creation time; the two are intentionally two
-- columns rather than one; see control-repositories.ts's `tenants.create`.
CREATE TABLE IF NOT EXISTS tenant_queue_state (
  tenant_id     TEXT PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  weight        REAL NOT NULL DEFAULT 1.0,
  running_jobs  INTEGER NOT NULL DEFAULT 0
);

-- ── AI Extend dispatcher state (P3) ─────────────────────────────────────────
-- Cloudinary credentials are one shared, global account (§3.4) called from
-- several separate `background_fill` WORKER PROCESSES at once — an in-memory
-- JS semaphore in one process cannot coordinate with the others, so the
-- dispatcher's global concurrency slot and token-bucket rate limiter live
-- here instead, claimed the same conditional-UPDATE way a job is. Single row
-- (id=1), never more.
CREATE TABLE IF NOT EXISTS ai_extend_global_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  in_flight       INTEGER NOT NULL DEFAULT 0,
  tokens          REAL NOT NULL DEFAULT 0,
  last_refill_at  TEXT NOT NULL
);

-- Per-tenant concurrency cap on AI Extend calls specifically — separate from
-- `tenant_queue_state.running_jobs` (the general scheduler's count across
-- every job kind) because this one gates a paid, rate-limited remote API,
-- not local compute.
CREATE TABLE IF NOT EXISTS ai_extend_tenant_state (
  tenant_id   TEXT PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  in_flight   INTEGER NOT NULL DEFAULT 0
);

-- Same bookkeeping pattern as the tenant schema's own table — lets the
-- lazy per-tenant-DB migration scheme and control.db's migration share one
-- `migrate()` implementation (see src/db/migrate.ts).
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TEXT NOT NULL
);
