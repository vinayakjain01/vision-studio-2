-- P5: admin tenants-table support — see control-schema.sql's comments on
-- idx_jobs_completed_at and queue_wait_hourly_rollups for why each exists.

CREATE INDEX IF NOT EXISTS idx_jobs_completed_at ON jobs (status, completed_at, tenant_id);

CREATE TABLE IF NOT EXISTS queue_wait_hourly_rollups (
  tenant_id     TEXT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  hour_bucket   TEXT NOT NULL,
  sample_count  INTEGER NOT NULL,
  p50_ms        REAL NOT NULL,
  p95_ms        REAL NOT NULL,
  computed_at   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, hour_bucket)
);

CREATE INDEX IF NOT EXISTS idx_queue_wait_rollups_bucket ON queue_wait_hourly_rollups (hour_bucket);
