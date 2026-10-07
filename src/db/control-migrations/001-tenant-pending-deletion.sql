-- P5: tenant deletion is two-step (mark pending, then purge after typing the
-- tenant name to confirm) — adds the 'pending_deletion' status value and a
-- timestamp for "how long has this been pending" in the admin UI.
--
-- SQLite can't ALTER a CHECK constraint in place, so this rebuilds the table
-- under a temporary name and swaps it back — other tables' `REFERENCES
-- tenants(id)` clauses resolve by name at constraint-check time, not by a
-- stored table reference, so they keep working once a table named `tenants`
-- exists again with the same id values, no FK-specific handling needed.

CREATE TABLE tenants_new (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'suspended', 'pending_deletion')),
  pending_deletion_at   TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

INSERT INTO tenants_new (id, name, status, created_at, updated_at)
  SELECT id, name, status, created_at, updated_at FROM tenants;

DROP TABLE tenants;
ALTER TABLE tenants_new RENAME TO tenants;
