#!/bin/sh
# Container entrypoint.
#
# Runs control.db + every EXISTING tenant's app.db migration on every start
# (idempotent — see scripts/migrate.ts's own doc comment) and NEVER runs the
# legacy single-tenant migration automatically: `tenants:migrate-legacy`
# MOVES data/vision-studio.db and data/media/* in place with no backup of
# its own, which is exactly the kind of one-way operation that must be a
# deliberate, manual decision (`npm run tenants:migrate-legacy -- --i-have-a-backup`)
# — see docs/OPERATIONS.md's "first deploy onto a legacy volume" entry.
#
# `exec "$@"` at the end REPLACES this shell process with the command passed
# as CMD, rather than running it as a child — critical for graceful shutdown
# (src/jobs/shutdown.ts): Docker sends SIGTERM to PID 1, and a shell sitting
# as PID 1 running its command as a CHILD does not reliably forward that
# signal on. `exec` makes the actual Node process PID 1 directly, so it
# receives SIGTERM itself.
set -e

echo "[entrypoint] running control.db + tenant migrations..."
npm run db:migrate

echo "[entrypoint] starting: $@"
exec "$@"
