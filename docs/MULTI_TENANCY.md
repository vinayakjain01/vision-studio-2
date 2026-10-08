# Multi-tenancy — architecture

Status: **Implemented through P6.** Everything below describes the system
as it actually runs today, confirmed against the source — not a plan. The
original Phase 0 investigation and the design decisions it produced are kept
at the bottom (Appendix A/B) as the historical record of *why* the
architecture ended up this shape; every decision flagged there has since
been resolved and built exactly as described unless a later section says
otherwise.

For day-to-day operator procedures (create/suspend/delete a tenant, backup/
restore, tuning, reading the admin metrics) see `docs/OPERATIONS.md`. For
environment variables and first-deploy steps see `docs/DEPLOY.md`. This
document is architecture only.

---

## Quick reference

- **Data layout** → §2
- **Request-scoped tenant context** → §3
- **Fair-share job scheduler** → §4
- **Quotas** → §5
- **AI Extend (Cloudinary) dispatcher** → §6
- **Security model** → §7
- **Legacy (single-tenant → multi-tenant) migration** → §8
- **Operational resilience added in P6** → §9
- **Manual two-tenant QA checklist** → §10

---

## 2. Data layout

```
data/
  control.db                         # users, tenants, memberships, sessions,
                                      # jobs (global queue), tenant_queue_state,
                                      # quotas, usage_counters, login_attempts,
                                      # audit_log, ai_extend_global_state
  tenants/
    <tenantId>/
      app.db                         # products, images, vision_analyses,
                                      # templates, rules, batches, creatives
      media/
        originals/ derived/ creatives/ assets/
      tmp/                           # staging uploads, export scratch; TTL-swept
models/                              # UNCHANGED — global, read-only, shared
```

`modelDir` is global and read-only — every tenant's vision analysis runs
through the same shared ONNX weights, never duplicated per tenant.

Every tenant-scoped path is computed on demand by `tenantPaths(tenantId)`
(`src/config.ts`), never cached at module load — this is what makes the data
root a function of *which* tenant is asking rather than a fixed constant.
`tenantId` is validated against `^[A-Za-z0-9_-]+$` (`assertValidTenantId`)
before it is ever joined into a filesystem path, independent of
`media-store.ts`'s own content-hash key validation — this guards the ROOT,
not a key under it, and rejects anything that isn't exactly one of the IDs
`newId()` mints.

`control.db` is the ONLY file ever opened without a tenant in scope — it
holds nothing but control-plane rows (identity, billing/quota state,
scheduling, audit). Every tenant's actual business data (products, photos,
templates, generated creatives) lives in that tenant's own `app.db` and
`media/` tree and is never readable from a connection that doesn't already
know that tenant's ID.

---

## 3. Request-scoped tenant context

```ts
// src/tenancy/context.ts
interface TenantContext {
  tenantId: string
  role: 'owner' | 'member'
  userId: string
}

const storage = new AsyncLocalStorage<TenantContext>()

export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  return storage.run(ctx, fn)
}

export function currentTenant(): TenantContext {
  const ctx = storage.getStore()
  if (!ctx) throw new Error('no tenant context — refusing to guess')
  return ctx
}
```

- Set once per request inside `handler()` (`src/lib/api-handler.ts`), the one
  wrapper every non-public API route funnels through — session is resolved
  from the cookie, the route body runs inside `runWithTenant(resolved.tenant,
  ...)`, and a tenant-less session (a platform admin with no personal
  workspace) is rejected with "this account has no workspace" rather than
  running with no context. `adminHandler()` (`src/lib/admin-handler.ts`) is
  the deliberate exception — admin routes mostly read/write control-plane
  data with no ambient tenant, and the few that touch one specific tenant's
  data name it explicitly via `runWithTenant({tenantId: <that tenant>, ...})`
  rather than relying on an ambient one.
- `src/db/client.ts`'s tenant DB accessor reads `currentTenant().tenantId`,
  opens (or reuses, from a small LRU) that tenant's `app.db` handle, and
  **throws if no context is set** — fail closed, no default tenant, ever.
- `src/storage/media-store.ts`'s media roots are a function of
  `currentTenant()`, not a module-level constant.
- **Workers run in separate OS processes** (`child_process.spawn`), so no
  in-process context — `AsyncLocalStorage` included — reaches them. Every
  job row carries its own `tenant_id`; the worker reads it off the claimed
  job and wraps the handler body in `runWithTenant({tenantId, ...}, () =>
  handle(job))` itself, binding a fresh context per job rather than
  inheriting one from anywhere.
- The vision-analysis engine's ONNX session manager stays one shared
  singleton (pure model weights, safe across tenants) — only its cache and
  mask-sink ports are reconstructed per tenant, which is cheap (closures over
  that tenant's DB handle and media root, not new model instances).

**Lint guard**: `scripts/check-tenancy-boundaries.ts` (run as part of
`npm run lint`, before eslint) greps the whole tree for direct DB/storage-
root access — raw `new Database(...)`, the tenant DB accessor, or a media
root — outside the small allow-list of modules that are supposed to touch
them (`src/db/repositories.ts`, `src/db/control-repositories.ts`,
`src/storage/media-store.ts`, and a handful of named scripts in
`scripts/lib/tenancy-boundaries.ts`'s `ALLOWED` list, each there for a
specific, commented reason — e.g. a backup script needs a raw connection to
run `better-sqlite3`'s online backup API). Fails the build the same way a
type error would. This is the mechanism that keeps "every tenant access goes
through one audited choke point" true over time instead of being a one-time
review finding.

---

## 4. Fair-share job scheduler

```
control.db:
  jobs (id, tenant_id, kind, priority_class, status, attempts, max_attempts,
        worker_id, claimed_at, heartbeat_at, lease_expires_at, available_at,
        dedupe_key UNIQUE(tenant_id, dedupe_key),
        payload, created_at, updated_at, started_at, completed_at, error)
  tenant_queue_state (tenant_id PRIMARY KEY, weight, running_jobs)
```

`claim(kind, workerId)` (`src/jobs/queue.ts`) is the whole scheduler in one
function:

1. Try `claimCandidate(kind, 'interactive')` first; only if nothing
   interactive is queued anywhere, fall back to `claimCandidate(kind,
   'bulk')`. Interactive work from ANY tenant is always tried before bulk
   work from ANY tenant — a steady stream of bulk jobs can never make an
   interactive request (a single-photo generate) wait behind it.
2. Within a priority class, `claimCandidate` lists every `active` tenant
   with at least one queued job, ordered by `running_jobs / weight`
   ascending (ties broken by that tenant's oldest queued job), and probes
   tenants in that order until one has a claimable job. This is the weighted
   fair-share pick — a tenant currently running fewer jobs relative to its
   weight is always preferred over one running more, regardless of how many
   jobs either has *queued*. `weight` defaults to `1.0`; a higher weight (set
   via the admin console) gives a tenant a proportionally larger share of
   worker time without starving anyone else.
3. The claim itself ( `UPDATE jobs SET status='claimed', ... WHERE id = ?
   AND status = 'pending'`) and the `tenant_queue_state.running_jobs`
   increment happen inside one `BEGIN IMMEDIATE` transaction — the whole
   probe-then-update is serialized by SQLite's single-writer guarantee, so
   two workers polling at once can never both claim the same job, and
   `running_jobs` can never drift from "jobs actually claimed-or-running
   right now" because of a race.
4. `running_jobs` is decremented in exactly the same transaction style
   inside `complete()`, `fail()`, `cancelAll()`, `reclaimStale()`, and the
   graceful-shutdown `returnToPending()` path (P6) — every code path that
   can end a job's "counted as running" state touches this counter in the
   same place, so it can never go permanently stale.
5. `tenants.status = 'active'` is part of the candidate query itself (a join,
   not a post-filter) — a suspended or pending-deletion tenant's queued jobs
   are simply invisible to `claim()` without being deleted; resuming the
   tenant makes them claimable again with no other change.
6. `dedupe_key` uniqueness is `(tenant_id, dedupe_key)`, not global — two
   tenants requesting AI Extend on visually-identical stock photography
   (same `sourceHash`) never collide on each other's in-flight dedup key.
7. A `'bulk'` job pending longer than `BULK_MAX_WAIT_SECONDS` (default 900s)
   is promoted to `'interactive'` class by the periodic sweep
   (`promoteAgedBulkJobs`), so a bulk job can never starve indefinitely even
   under constant interactive pressure from every tenant at once — it's a
   backstop, not the common case.
8. `reclaimStale()` requeues any job whose lease (`lease_expires_at`, set at
   claim time to `now + JOB_STALE_CLAIM_MS`, refreshed on every heartbeat)
   has expired — a crashed or killed worker's job comes back to `pending`
   automatically, decrementing `running_jobs` for its tenant in the same
   step.

Two sweep cadences run in `WorkerPool` (`src/jobs/pool.ts`): a **fast** sweep
every 60s doing only cheap indexed SQL (`reclaimStale`,
`reconcileRunningJobs`, `promoteAgedBulkJobs`), and a **slow** sweep every
`JOB_MAINTENANCE_SWEEP_INTERVAL_MS` (default 30 min) doing real disk work
(job-row retention pruning, the per-tenant media orphan sweep, storage-usage
reconciliation).

---

## 5. Quotas

`control.db`'s `quotas` table holds one admin-editable row per tenant
(`maxQueuedJobs`, `maxImagesPerBatch`, `maxConcurrentUploads`,
`maxStorageBytes`, `maxAiExtendPerMonth`). `src/jobs/quota.ts` is the only
place these are enforced, and every check happens **before** work is
accepted, never inside a worker:

| Check | When | Code |
|---|---|---|
| `assertCanEnqueue` | before any jobs are inserted (vision analysis, batch creative generation) | `max_queued_jobs` |
| `assertImagesPerBatch` | before an import ingests files, against the import's *cumulative* total, not just this request | `max_images_per_batch` |
| `assertStorageBudget` | before accepting an upload's bytes, against the tracked storage-usage gauge | `max_storage_bytes` |
| `tryAcquireUploadSlot` / `assertUploadSlotAvailable` | per upload request, in-process counter (not a DB row — an upload is a synchronous HTTP request on this one server process, never a worker) | `max_concurrent_uploads` |

Every violation throws `QuotaExceededError` with a stable `code` plus the
limit and current usage — `mapKnownError()` (`src/lib/api-handler.ts`) turns
that into a 429 with `{error, code, limit, current}`, so the UI renders
"12/20 uploads" instead of pattern-matching a message string. Only
`max_concurrent_uploads` gets a `Retry-After` header — it's the only one of
the four that's genuinely transient (a slot frees up as soon as another
upload finishes); the others need a human to raise the limit or usage to
drop on its own.

Quotas bound one tenant's own usage. They are a separate mechanism from the
fair-share scheduler (§4), which bounds how worker *time* is split across
tenants regardless of any one tenant's quota — a tenant comfortably under
every quota can still wait behind others' running jobs if its weight is low
relative to how much they're running.

---

## 6. AI Extend dispatcher

Cloudinary is **one shared paid account** — `cloudinary.config()` is a
process-global SDK singleton called once; there is no per-tenant credential
swapping. `src/jobs/ai-extend-dispatcher.ts` is a single module-level
dispatcher sitting in front of every `background_fill` job:

- A counting semaphore for `AI_EXTEND_GLOBAL_CONCURRENCY` (max simultaneous
  Cloudinary calls across every worker process combined).
- A token-bucket rate limiter (`AI_EXTEND_RATE_LIMIT_PER_SECOND` /
  `_BURST`).
- A `Map<tenantId, count>` enforcing `AI_EXTEND_PER_TENANT_CONCURRENCY`,
  independent of the global cap.
- A monthly circuit breaker (`AI_EXTEND_GLOBAL_MONTHLY_CAP`) against the
  WHOLE account's usage, independent of any one tenant's own
  `maxAiExtendPerMonth` quota — a warning logs at 80%, the dispatcher
  refuses outright at 100% regardless of whether any individual tenant is
  still under their own limit.

A 429 from Cloudinary feeds the existing `defer()`-with-backoff retry path,
reading `Retry-After` when Cloudinary sends one rather than a fixed cooldown.
Every successful generation increments a `control.db` usage counter, read by
the admin console and checked against quota before the dispatcher even
attempts the call — a tenant over quota fails fast with a clear error
instead of spending a concurrency slot on a call that would be rejected
downstream anyway. Every result is cached as a derived asset keyed by
`(tenant_id, source_hash, canvas, padding, prompt)` — the tenant ID in that
key is what prevents tenant B's identical stock photo from getting a free
ride on tenant A's already-paid-for generation.

---

## 7. Security model

**Authentication.** Argon2id password hashing (`src/auth/password.ts`).
Sessions are opaque random tokens stored hashed (SHA-256) in `control.db`'s
`sessions` table, never the raw token — a dump of that table cannot be
replayed into a valid cookie. Sliding expiry (`SESSION_TTL_MS`, refreshed on
every authenticated request, not a fixed login duration). `attemptLogin`
(`src/auth/login.ts`) hashes against a fixed dummy Argon2id hash on an
unknown email so a login attempt costs the same ~50-100ms whether or not the
account exists — response-time alone can't be used to enumerate accounts.

**Login rate limiting.** Independent per-account and per-IP buckets
(`login_attempts`, windowed by `LOGIN_WINDOW_MS`): `LOGIN_MAX_ATTEMPTS`
failures per account, `4×` that per IP (a shared office/NAT IP genuinely has
several people failing their own passwords; ten failures against one
specific account from anywhere never is). The IP identity comes from
`clientIp()` (`src/auth/client-ip.ts`), which **ignores `X-Forwarded-For`
entirely unless `TRUST_PROXY=true`** — with it off, every request shares one
"unknown" bucket, coarse but ungameable; a client cannot pick its own (or
someone else's) rate-limit bucket by setting a header. With it on, only the
LAST hop of `X-Forwarded-For` is trusted (the entry the one reverse proxy in
front of this app itself appended), never the first — see
`tests/ops/login-rate-limit.test.ts` for the behavior under both settings,
including a header carrying a spoofed first entry.

**Cookies.** `vs_session` is `HttpOnly` (unreadable to any script, so an XSS
bug can't exfiltrate it directly), `SameSite=Lax`, and `Secure` whenever
`NODE_ENV=production` (overridable via `COOKIE_SECURE` either direction —
see `.env.example`).

**CSRF.** Every mutating request (`POST`/`PUT`/`PATCH`/`DELETE`) through
`handler()`/`adminHandler()` checks `Origin` against `config.auth.appOrigin`
(required in production) or, in development, against Next's own
`nextUrl.host`. A mismatched `Origin` is rejected with 403 before the route
body runs. This is defense in depth alongside `SameSite=Lax` (which already
blocks a cross-site form POST or plain link in most browsers) — it catches
what `Lax` doesn't, like a `fetch()` from another origin that still happens
to carry the cookie. A *missing* `Origin` header is allowed through
(some legitimate same-origin requests and non-browser clients omit it); the
cookie's own protections remain the primary defense either way.

**Security headers** (`next.config.ts`, every route): `X-Content-Type-
Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
`X-Frame-Options: SAMEORIGIN`, a `Permissions-Policy` denying camera/mic/
geolocation/payment (unused features), `Strict-Transport-Security` (only
meaningful once actually served over HTTPS — harmless over plain HTTP in
dev), and a `Content-Security-Policy`: `script-src 'self'` with no
`unsafe-inline`/`unsafe-eval` in production (`'unsafe-eval'` only in `npm
run dev`, required for Next's Fast Refresh); `style-src 'self'
'unsafe-inline'` (React's `style={{}}` prop renders as an inline `style`
attribute in a handful of components — inline STYLE is a far smaller attack
surface than inline SCRIPT, which stays fully disallowed); media only from
this app's own content-addressed `/api/media/*` route, never a remote
origin.

**Production error responses never leak internals.** `mapKnownError()`
(`src/lib/api-handler.ts`) always logs the full error server-side, but in
`NODE_ENV=production` an unhandled error's message is replaced with a flat
"internal server error" before it reaches the client — an `ENOENT` with an
absolute data-directory path, a raw SQLite error string, or anything else
`.message` might contain is never shipped out. Structured, intentionally
user-facing errors (`QuotaExceededError`, `ExportCapacityError`,
`InsufficientDiskSpaceError`, the AI Extend quota error) are unaffected —
their messages are written to be shown to a user and keep their specific
text, limit, and usage numbers in every environment. See
`tests/ops/error-leakage.test.ts`.

**Tenant isolation at the data layer.** Enforced structurally, not by
per-query `WHERE tenant_id = ?` discipline: there is no connection that can
see two tenants' `app.db` rows at once, because each tenant's data lives in
its own SQLite file and the only way to open one is through
`currentTenant()` (§3) or an explicitly-named tenant ID in an admin action —
there is no "list across tenants" query possible at the `app.db` layer even
in principle. `tests/isolation/*` exercises this at the HTTP level across
every route.

**`ALLOW_MULTI_TENANT_PREVIEW`.** Gates creating a second tenant at all —
see §9.1 for exactly what would need to be true to remove this gate, and
whether removing it is recommended today.

**Audit log.** `control.db`'s `audit_log` records security-relevant events
(`login_failed`, admin tenant actions, password changes) with actor, tenant,
and a JSON detail blob — append-only, read by the admin console, never
exposed to a non-admin tenant user.

---

## 8. Legacy migration

`npm run tenants:migrate-legacy`:
1. Refuses to run without a confirmation flag.
2. Creates `control.db`, runs its schema.
3. Creates the first tenant + `platform_admin` user from `ADMIN_EMAIL` /
   `ADMIN_PASSWORD`.
4. Moves `data/vision-studio.db` → `data/tenants/<id>/app.db`, moves
   `data/media/*` → `data/tenants/<id>/media/*`, preserving every path
   exactly (content-addressed keys don't change, only their root).
5. Verifies: row counts per table match pre/post, file counts under each
   media root match, and a sample of source hashes re-resolve to the same
   bytes.
6. Idempotent: safe to re-run (checks whether the legacy DB file still
   exists at the old path before doing anything).

`scripts/migrate.ts` migrates `control.db` first, then enumerates every
tenant from it and runs the same parameterized `migrate(db)` against each
tenant handle — one function, called once per tenant, no tenant-specific
branching.

This is the **only** step that touches the pre-multi-tenancy layout, and it
is never run automatically — see `docs/OPERATIONS.md`'s rollback procedure
for why that matters and `docker-entrypoint.sh`'s own comment confirming the
container entrypoint runs `control.db`/tenant migrations on every boot but
never this one.

---

## 9. Operational resilience (P6)

Architecture summary only — procedures live in `docs/OPERATIONS.md`.

- **Graceful shutdown.** On `SIGTERM`/`SIGINT`
  (`src/jobs/shutdown.ts`, wired in `instrumentation.ts`), the pool stops
  claiming new jobs immediately (the worker loop already only checks between
  jobs, never interrupts one in progress), gives whatever's running
  `SHUTDOWN_GRACE_SECONDS` (default 30) to finish, then kills anything still
  busy and returns its job to `pending` via `queue.returnToPending()` —
  which explicitly refunds the attempt `claim()` already consumed
  (`attempts = MAX(0, attempts - 1)`), so an orderly shutdown never counts
  against a job's retry budget the way a crash would. Every open SQLite
  handle is `wal_checkpoint(TRUNCATE)`'d before close. The container
  orchestrator's own stop timeout (`docker stop -t`,
  `terminationGracePeriodSeconds`) **must** exceed this value or `SIGKILL`
  arrives first and skips the graceful path entirely.
- **Disk guard.** Below `DISK_MIN_FREE_GB` free on the data volume, new
  uploads are refused outright (`assertDiskSpaceAvailable`,
  `src/jobs/disk-guard.ts`) before a single byte is written — checked
  against the whole volume, not a tenant's own storage quota, since a full
  disk is a server-wide failure mode no per-tenant limit prevents. Fails
  OPEN if `fs.statfs` itself is unavailable on the platform (never blocks
  uploads over a defensive check that couldn't run), fails CLOSED (refuses)
  when it successfully measures low space.
- **Backups.** `scripts/backup.ts` uses better-sqlite3's online backup API
  (transactionally consistent, non-blocking) for `control.db` and every
  tenant `app.db`, plus an incremental media copy (content-addressed files
  are immutable, so "incremental" is just "copy what doesn't already
  exist"). `scripts/restore.ts` is the matching restore; `scripts/tenant-
  export.ts`/`tenant-import.ts` move one tenant's data between servers. A
  filesystem/volume snapshot of the data directory is **only
  crash-consistent** (equivalent to the server losing power mid-write) —
  SQLite's own WAL recovery handles that safely, but it is a different, less
  controlled guarantee than an online backup taken through the app.
- **Health.** `/api/health` returns status only (`{status: 'ok'}` or 503
  `{status: 'error'}`) — no counts, no detail, nothing an unauthenticated
  prober shouldn't see. Readiness means `control.db` accepts a write lock
  (`BEGIN IMMEDIATE; ROLLBACK`, never committed) and the data directory
  accepts a real file write. The Docker image's `HEALTHCHECK` polls this
  endpoint.
- **Container.** Runs as a non-root user with `/app/data` pre-owned by it;
  dependencies installed from the lockfile (`npm ci`); the entrypoint runs
  `control.db` + tenant migrations on every boot and nothing else — the
  legacy migration is a deliberate, separate, manual step, never triggered
  by the container starting.

---

## 10. Manual two-tenant QA checklist

No browser test harness exists in this repo (no Playwright/Cypress/
Puppeteer), so the isolation properties the automated suite already checks
at the HTTP level (`tests/isolation/*`) are worth re-confirming once, by
hand, the way an actual user would encounter them: two browser sessions
side by side, logged in as two different tenants.

Run through this after any change touching auth, tenancy context, the job
queue, or the streaming upload/export paths. This same checklist is also the
"two-user smoke test" referenced in `docs/DEPLOY.md`'s post-deploy
verification.

### Setup

1. Two tenants, each with at least one user (admin console or
   `npm run admin:create-tenant`).
2. Two browser windows (or one normal + one private/incognito, so cookies
   don't collide) — **Tenant A** and **Tenant B**.

### Checklist

- [ ] Log in as Tenant A in window 1, Tenant B in window 2. Both land on
      their own, empty (or pre-existing) workspace — neither sees the
      other's products, imports, templates, or batches anywhere (sidebar,
      lists, counts).
- [ ] In window 1, start a bulk import (10+ photos). While it's analysing,
      check window 2's Import/Products pages — Tenant B must see **no**
      change: no new images, no shift in "N analysing" counts, no queue
      activity implying another tenant's work.
- [ ] Still mid-import in window 1: open Settings in window 2 (Tenant B).
      The queue depth shown must be Tenant B's own (likely zero), never
      Tenant A's in-flight count.
- [ ] Generate a batch of 20+ creatives in window 1. While it runs, confirm
      window 2 shows no "waiting for a free worker" message unless Tenant
      B *also* has pending work of its own — Tenant A's load on the shared
      worker pool must never surface as Tenant B's own queue state.
- [ ] Try to open a direct URL in window 2 using one of Tenant A's real
      resource ids (copy a product/import/batch id from window 1's network
      tab or address bar, paste into window 2's equivalent URL). Expect a
      404, never the resource itself.
- [ ] Download a bulk ZIP from window 1 (20+ creatives) and from window 2
      concurrently. Both must complete with the correct, respective
      contents — no mixing, no one blocking the other indefinitely (a
      slow one may 429/503 briefly under tight quotas; it must not hang).
- [ ] Upload 50+ files at once in window 1. Mid-upload, close the tab (or
      navigate away) — reopen Import and confirm no orphaned "stuck"
      upload state; previously-succeeded files are already imported and
      not re-required.
- [ ] In window 1, go to Settings → Account and change the password,
      **without** logging out first. Confirm: the current tab stays
      logged in (no redirect to /login), and — if a THIRD window was also
      logged in as Tenant A's same user — that third window is logged out
      on its next request.
- [ ] Trigger a quota error on purpose (e.g. start two large uploads at
      once past `MAX_CONCURRENT_UPLOADS`, or push past
      `AI_EXTEND_GLOBAL_MONTHLY_CAP` if configured low for testing).
      Confirm the UI shows the limit, current usage, and what to do —
      not just a generic "request failed" message.
- [ ] Leave both windows idle (tab visible) for a few minutes and watch the
      Network tab: polling requests should slow down or stop once nothing
      is in flight, and most should come back `304` once state has
      settled. Switch a tab to background (another tab in front) and
      confirm polling pauses entirely while hidden.

---

## Appendix A: Phase 0 investigation findings (historical)

Produced before any multi-tenancy code existed, by reading the then-current
(fully single-tenant, zero-auth) codebase. Kept verbatim as the record of
the starting point.

**Fully single-tenant, zero auth, as documented.** `docs/DEPLOY.md`,
`render.yaml`, and a comment in `config.ts` already said "no login." No
`middleware.ts`, no auth library in `package.json`, no `users` table. Every
one of the 25 API routes under `src/app/api/` fetched by a client-supplied
ID with no ownership check — this wasn't a gap to patch per-route, it was
the universal behavior, confirmed route by route.

**More infrastructure already existed than the spec assumed:**

- **Priority already existed** (`jobs.priority`, lower runs sooner), but as a
  single static integer with no weight and no per-tenant fairness. Claiming
  was `ORDER BY priority, created_at` — strict FIFO within a priority level.
- **Leases/heartbeats already existed.** Workers heartbeat every 5s;
  `reclaimStale()` requeued jobs whose heartbeat was older than 5 minutes.
  Gaps at the time: no explicit lease-expiry column, and `complete()`/
  `fail()` didn't check `worker_id`.
- **Atomic claiming already worked**, via a SELECT-candidates-then-per-row-
  `UPDATE…WHERE status='pending'` inside an `IMMEDIATE` transaction.
- **OS-level worker priority already existed** —
  `os.setPriority(child.pid, PRIORITY_BELOW_NORMAL)` on every spawned
  worker.
- **A version-tracked migration runner already existed**
  (`src/db/migrate.ts`), already parameterized on a `Db` handle rather than
  a singleton.
- **No module-level caches of decoded images or analysis results** existed
  anywhere in `src/vision/` — the ONNX session manager was the only
  long-lived vision state, and pure model weights are safe to share.

**Real gaps the spec correctly anticipated:**

- `media-store.ts`'s `ROOTS` and `config.paths.*` were frozen at module load
  from one `dataDir` — tenant-scoping needed turning these into functions.
- The AI-Extend derived-asset cache key had no tenant component — a
  cross-tenant leak and a paid-credit double-charge-prevention mechanism
  working in reverse.
- The global vision-analysis cache would have given tenant B a cache hit on
  tenant A's analysis of identical photo bytes, since stock photos and
  common product shots collide on hash routinely.
- Bulk ZIP download, export conversion, and upload ingestion all fully
  buffered in memory despite a comment claiming "streamed."

## Appendix B: Phase 0 decisions (historical, all resolved)

These were the architecture-affecting choices flagged before P1 started.
Each is marked with how it was actually resolved, cross-referenced to the
section above that now describes the built result.

### B.1 The `jobs.batch_id → batches` foreign key could not survive the DB split

**Resolved as proposed.** The FK was dropped. `jobs` in `control.db` carries
a plain `(tenant_id, batch_id)` pair with no referential constraint;
cascade-on-delete is an explicit two-step application-level operation
(cancel the batch's jobs in `control.db` first, delete the batch row in the
tenant's `app.db` second) — see `queue.cancelBatch()`.

### B.2 Weighted fair-share scheduling needed a concrete claim mechanism

**Resolved as proposed**, and now the actual implementation — see §4. The
`tenant_queue_state` table and the `running_jobs / weight` claim ordering
described there is exactly this proposal, built.

### B.3 AsyncLocalStorage cannot cross the worker process boundary

**Confirmed, not a conflict** — see §3's description of how the job row's
`tenant_id` and a fresh `runWithTenant()` call per job handle this.

### B.4 Cloudinary stays ONE shared account

**Confirmed, not a conflict** — see §6. One process-global SDK
configuration; per-tenant behavior is a concurrency cap and a quota, never
separate credentials.

### B.5 Streaming vs. moving CPU work to the worker pool for downloads/exports

**Resolved as proposed.** The memory problem was fixed directly: bulk ZIP
downloads stream file-by-file (`archiver`), uploads stream to a tenant
`tmp/` file via `busboy` instead of buffering `request.formData()` (see the
module doc on `src/app/api/imports/[importId]/files/route.ts` for the
full before/after). The CPU question was resolved as a quota/scheduling
concern rather than a hard relocation: `EXPORT_GLOBAL_CONCURRENCY` /
`EXPORT_PER_TENANT_CONCURRENCY` (`src/render/export-concurrency.ts`) cap
concurrent export conversions in the web process; single-creative export
stays synchronous (a sub-second operation that would otherwise become a
multi-second round trip through the job queue for no benefit), while large
bulk ZIP generation goes through the background job queue with a polled
"ready" state.
