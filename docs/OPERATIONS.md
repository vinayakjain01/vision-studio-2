# Operations runbook

Day-to-day procedures for running a deployed Vision Studio instance.
Architecture and *why* things are built this way live in
`docs/MULTI_TENANCY.md`; environment variables and first-deploy steps live
in `docs/DEPLOY.md`. This document is procedures only.

All `npm run admin:*` / `npm run tenant:*` / `npm run backup`/`restore`
commands below run **on the server**, against the real data directory
(`docker exec -it vision-studio <command>` for a containerized deployment).
None of them are reachable from outside the container.

---

## Create a tenant

Normal path: admin console → Tenants → Create. Generates a one-time temp
password (forced change at next login) and provisions the tenant's `app.db`
+ media directories immediately — a tenant is always fully usable the
instant it's created, never left half-provisioned.

Lockout-recovery path (admin console unreachable):
```sh
npm run admin:create-tenant -- --name "Acme Co" --email owner@acme.test
```
Prints the temp password to the terminal once — it is never logged or
written anywhere else. Requires `ALLOW_MULTI_TENANT_PREVIEW=1` for a second
or further tenant (see `docs/DEPLOY.md`'s section on that flag).

## Suspend / resume a tenant

Admin console → Tenants → (tenant) → Suspend. Equivalent API:
`PATCH /api/admin/tenants/:tenantId` with `{"action": "suspend"}` (or
`"resume"`). Suspending:

- Revokes every existing session for that tenant's users immediately — a
  logged-in browser is kicked out on its next request, not just blocked
  from a fresh login.
- Blocks login with otherwise-correct credentials.
- Leaves the tenant's queued jobs in place (not deleted) — the fair-share
  scheduler's candidate query only considers `status = 'active'` tenants
  (`docs/MULTI_TENANCY.md` §4), so a suspended tenant's jobs simply stop
  being claimed. Resuming makes them claimable again with no other action
  needed.
- Does **not** touch the tenant's data — suspend is reversible and lossless.

## Delete a tenant

Two-step, deliberately: **mark pending deletion** first
(`{"action": "mark_pending_deletion"}`), which is reversible
(`{"action": "cancel_pending_deletion"}`), then **purge**
(`DELETE /api/admin/tenants/:tenantId` with `{"confirmName": "<exact tenant
name>"}`) — the confirmation name match is the guard against a misclick
deleting the wrong tenant from a list. Purge removes the tenant's `app.db`,
every media file under its root, and its control-plane rows
(`tenants`/`memberships`/`quotas`/`usage_counters`/queued-or-running `jobs`
for that tenant). **This is irreversible outside of restoring a backup
taken before the purge** — see "Backup and restore" below; there is no
soft-undo once purge has run.

## Reset a user's password

Admin console → Users → (user) → Reset password. Generates a one-time temp
password, forces a change at next login, and revokes every other existing
session for that user (the session making the reset request, if it's the
user's own, is deliberately not special-cased here — this action is always
an admin acting on someone else's account).

Lockout-recovery path (including the case where the ONLY platform admin is
the one locked out):
```sh
npm run admin:reset-password -- --email someone@example.com
```

## Grant platform-admin access to an existing user, or create a new admin

```sh
npm run admin:promote -- --email someone@example.com
```
Omit `--password` — the script prints a generated one-time temp password
instead. **Do not pass `--password` on the command line in a real
terminal session you don't fully control**: npm echoes the fully-resolved
command line (including every argument) into its own output, which lands in
shell history, terminal scrollback, and potentially a CI/automation log —
exactly the vector that leaked a real admin password during this project's
own development (see the P6 report's "errors and fixes" if you have access
to it). If you must set a specific password non-interactively, set it via
an environment variable the script reads, not a bare CLI argument — or just
accept the generated temp password and let the forced-change flow handle it.

---

## Backup and restore

**Take a backup:**
```sh
npm run backup                              # every tenant
npm run backup -- --tenant <tenantId>       # just one
npm run backup -- --out /path/to/backups    # override BACKUP_DIR
```
Safe to run against a live server — uses better-sqlite3's online backup API
(transactionally consistent, non-blocking), not a file copy. Media is
backed up incrementally: content-addressed files are immutable, so a file
already present in a prior snapshot is never re-copied, only new ones.

**Restore:**
```sh
npm run restore -- --into /path/to/data                                    # latest snapshot
npm run restore -- --into /path/to/data --snapshot 2026-10-08T12-00-00.000Z  # a specific one
npm run restore -- --into /path/to/data --tenant <id>                       # just one tenant
npm run restore -- --into /path/to/data --force                            # allow a non-empty target
```
Refuses a non-empty target without `--force` — this is meant for disaster
recovery onto a fresh volume or a scratch verification directory, not for
silently overwriting a live `data/` dir.

**Verify a backup before trusting it** (do this after every backup
automation change, and periodically regardless):
1. `npm run restore -- --into /tmp/restore-check`
2. Open the restored `control.db` and each tenant `app.db` and run
   `PRAGMA integrity_check` — expect `ok`.
3. Compare row counts in a few key tables (`jobs`, `images`, `products`)
   against the live server.
4. Spot-check a handful of media file hashes against their filenames
   (content-addressed — the hash IS the filename, so a mismatch is
   immediately obvious).
5. Delete the scratch directory.

**Volume snapshots are crash-consistent only.** A filesystem or disk
snapshot of the data volume is equivalent to the server losing power
mid-write — SQLite's WAL recovers safely from that on next open, but it is
a weaker guarantee than the online backup above, which is guaranteed
transactionally consistent at the instant it was taken. Use a volume
snapshot as a coarse, infrastructure-level safety net; use `npm run backup`
as the actual recovery mechanism.

## Move a tenant to another server

```sh
# On the source server:
npm run tenant:export -- --tenant <id> --out /path/to/bundle

# Copy the bundle to the destination server, then:
npm run tenant:import -- --bundle /path/to/bundle
```
The bundle is self-contained (that tenant's `app.db`, its media, and its
control-plane rows as JSON — not a raw SQL dump, so nothing in it is
replayed as executable SQL against the destination). Import refuses if a
tenant with the same ID already exists on the destination. The tenant's
quotas and weight travel with it; its sessions do not (every user needs to
log in again on the new server).

## Rollback to the pre-multi-tenancy version

This reverts the **application code** to the version before multi-tenancy
existed, serving the single legacy `vision-studio.db` + `media/` layout
again. It does **not** reverse the legacy migration's file moves — it
restores the backup/snapshot taken *before* that migration ran, which
already has the pre-migration layout.

1. Stop the running (multi-tenancy) container.
2. Restore the pre-migration backup or volume snapshot — the one taken
   before `tenants:migrate-legacy` was ever run — onto the volume. If no
   such backup exists, rollback is not possible without data loss; this is
   exactly why the pre-deploy checklist in `docs/DEPLOY.md` requires a
   verified backup before that migration runs.
3. Check out the pre-multi-tenancy commit (the commit immediately before
   the `multi-tenancy` branch's first commit) and build/run that version
   against the restored volume.
4. The old code expects `data/vision-studio.db` and `data/media/*` directly
   — exactly what the restored pre-migration backup contains, so no further
   transformation is needed.
5. **Old `jobs` rows in `app.db` are untouched by any of this.** The
   pre-multi-tenancy version used a `jobs` table inside the single
   `vision-studio.db`; P3 moved job tracking to `control.db` going forward,
   but never dropped or modified that old table. Rolling back means the old
   code reads that table again, exactly as it left it — nothing to migrate
   back.

**Rehearse this on a copy before you ever need it for real** — restore the
pre-migration backup into a scratch directory, check out the pre-
multi-tenancy commit into a separate worktree (`git worktree add
<path> <pre-multi-tenancy commit>`), and confirm the old code actually
boots and serves pages against the restored data before trusting the
procedure in an incident.

---

## Tuning

Start from the recommended-settings table in the P6 load-test report for
your hardware class (4 vCPU/8GB vs 8 vCPU/16GB), then adjust from what the
admin global panel shows in practice:

- **Worker concurrency** (`JOB_VISION_CONCURRENCY` / `JOB_RENDER_CONCURRENCY`
  / `VISION_ORT_THREADS`): raise only after confirming real CPU/memory
  headroom — each vision worker holds ~700MB of model weights plus its own
  ONNX session; oversubscribing threads across workers costs more than it
  gains. The admin panel's "workers busy/idle" tells you whether concurrency
  is actually the bottleneck before you raise it.
- **Export concurrency** (`EXPORT_GLOBAL_CONCURRENCY` /
  `EXPORT_PER_TENANT_CONCURRENCY`): raise if single-creative downloads are
  slow to START (queued behind the cap) while the server otherwise has CPU
  to spare; this runs in the WEB process, not a worker, so it directly
  competes with request handling.
- **Quotas** (per-tenant, admin console → Tenants → edit quotas): raise a
  specific tenant's limits individually rather than the global defaults, if
  only that tenant needs more.
- **Tenant weight** (admin console): raise for a tenant that needs a larger
  share of worker time relative to others — this does not increase total
  capacity, only how it's split.
- **`DISK_MIN_FREE_GB`**: tune to your actual alerting lead time — this is
  the last-resort refuse-uploads threshold, not your primary disk-space
  alert; have a separate, higher-threshold disk alert upstream of this.

## Reading the admin metrics panel

`GET /api/admin/global` (admin console → Dashboard):

| Field | What it means |
|---|---|
| `workersBusy` / `workersIdle` / `workersTotal` | Live worker pool state — sustained `workersBusy == workersTotal` with queue depth not draining means you're compute-bound; raise concurrency only with confirmed headroom. |
| `queueDepthTotal` | Pending + claimed + running jobs, across every tenant. A rising trend with workers already saturated is the earliest sign you're under-provisioned. |
| `eventLoopP99Ms` | Web process event-loop delay, p99 over the last logging window. Rising values under load mean something is blocking the event loop (should not happen in steady state — `sharp` and ONNX run off it). |
| `aiExtendGlobalCallsThisMonth` / `aiExtendGlobalCap` | Whole-account Cloudinary usage against `AI_EXTEND_GLOBAL_MONTHLY_CAP` — a warning logs at 80%, calls are refused outright at 100% regardless of any individual tenant's own quota. |
| `freeDiskBytes` | Free space on the data volume — `null` if `statfs` isn't available on the host (the panel shows "unknown" rather than failing). Compare against `DISK_MIN_FREE_GB`. |
| `controlDbSizeBytes` | Size of `control.db` alone — a useful early signal if `JOB_RETENTION_DAYS` pruning isn't keeping up with job volume. |

Per-tenant usage and quota status is on each tenant's own admin detail page,
not the global panel (the global panel is deliberately counts/sizes/timings
only — never tenant-identifying content, see `src/services/admin-service.ts`'s
privacy boundary note).

## Common failure modes

- **A newly created tenant 404s on every page the instant its owner logs
  in** (`no such table: images` or similar). This was a real P5 bug, fixed:
  tenant creation must provision the tenant's `app.db` schema and media
  directories at creation time, not lazily on first use. If this recurs on
  a tenant created some other way than the admin console or
  `admin:create-tenant` (a hand-rolled script, a restored bundle that
  skipped migration), run `npm run db:migrate` — it migrates every existing
  tenant's `app.db` and is safe to re-run.
- **A platform admin with no personal tenant can't change their own forced
  temp password** ("this account has no workspace"). Also a real, fixed P5
  bug — if you see this exact message on `/api/auth/change-password`
  specifically, the fix (that route doing its own lightweight session
  check instead of requiring a tenant) should already be in place; it
  indicates a regression, not a new case to work around.
- **A "clear the queue" script or action does nothing / the queue looks
  empty but jobs still won't claim.** Confirm which generation of the job
  queue you're looking at — as of P3, jobs live in `control.db`, not any
  tenant's `app.db`. A script written against the old per-tenant `jobs`
  table (pre-P3) is querying a table that no longer has queue data in it.
  Use the admin console's queue view or `queue.stats()` directly against
  `control.db`.
- **Login rate-limiting seems to treat every client as the same IP** (one
  bad actor locks out everyone). Check `TRUST_PROXY` — if it's `false`
  behind a real reverse proxy, every request shares the "unknown" bucket by
  design (safer default than trusting a spoofable header). Set
  `TRUST_PROXY=true` and confirm your proxy sets `X-Forwarded-For` to the
  real client IP as the last hop (`docs/DEPLOY.md`'s Caddyfile does this by
  default).
- **Uploads start failing for every tenant at once with a disk-space
  error.** This is `DISK_MIN_FREE_GB` doing its job, not a bug — check
  `freeDiskBytes` on the admin panel, free up space or expand the volume,
  uploads resume automatically once free space is back above the
  threshold. No restart needed.
- **A redeploy seems to have silently dropped an in-flight job.** It
  shouldn't — check the logs for `[shutdown]`/`[pool]` lines around the
  stop. If the container's stop timeout was shorter than
  `SHUTDOWN_GRACE_SECONDS`, `SIGKILL` arrived before the graceful path
  finished and the job's lease simply expires on its own
  (`JOB_STALE_CLAIM_MS`) and gets reclaimed on the next start — it is not
  actually lost, just delayed and it DOES consume a retry attempt in that
  specific case (a hard kill is indistinguishable from a crash) unlike an
  orderly `SIGTERM` shutdown, which explicitly refunds the attempt. Fix the
  stop timeout for next time.
- **`docker run`/`docker rm` report contradictory container state**
  ("name already in use" immediately followed by "no such container").
  Observed during this project's own Docker verification work on a heavily
  loaded Windows/Docker Desktop host — a Docker daemon/CLI consistency lag,
  not an application issue. Re-run `docker ps -a` for an authoritative
  view before retrying, or wait briefly for the daemon to settle after it
  was just started.
