-- Widen `jobs.kind` to accept 'background_fill' (the self-hosted SDXL
-- inpainting job, dispatched to a separate GPU-hosted service — see
-- src/jobs/pool.ts — never to the local vision/render worker pool), and add
-- `available_at` so a job can be deferred to a future time without either
-- blocking a worker on it or burning retry attempts in a hot loop.
--
-- SQLite has no ALTER TABLE for CHECK constraints, so the table is recreated:
-- new table, copy rows, drop old, rename. `batch_id` is the only foreign key
-- involving this table and it points OUT to `batches`, not in, so nothing else
-- references `jobs` by rowid/foreign key and this is safe to do directly.

PRAGMA foreign_keys = OFF;

CREATE TABLE jobs_new (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('vision', 'render', 'background_fill')),
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'claimed', 'running', 'completed', 'failed', 'cancelled')),
  priority        INTEGER NOT NULL DEFAULT 100,
  batch_id        TEXT REFERENCES batches (id) ON DELETE CASCADE,
  dedupe_key      TEXT,
  payload         TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  worker_id       TEXT,
  claimed_at      TEXT,
  heartbeat_at    TEXT,
  available_at    TEXT,
  error           TEXT,
  result          TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  completed_at    TEXT
);

INSERT INTO jobs_new (
  id, kind, status, priority, batch_id, dedupe_key, payload,
  attempts, max_attempts, worker_id, claimed_at, heartbeat_at,
  available_at, error, result, created_at, updated_at, completed_at
)
SELECT
  id, kind, status, priority, batch_id, dedupe_key, payload,
  attempts, max_attempts, worker_id, claimed_at, heartbeat_at,
  NULL, error, result, created_at, updated_at, completed_at
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;

CREATE INDEX IF NOT EXISTS idx_jobs_queue     ON jobs (kind, status, priority ASC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_jobs_batch     ON jobs (batch_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_heartbeat ON jobs (status, heartbeat_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedupe
  ON jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'claimed', 'running');

PRAGMA foreign_keys = ON;
