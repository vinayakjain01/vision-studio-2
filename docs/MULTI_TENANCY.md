# Multi-tenancy — Phase 0 design note

Status: **Phase 0 (read + design) complete.** Nothing in `src/` has been
changed by this phase — this document is the only output. Sections marked
**DECISION NEEDED** are architecture-affecting choices the spec asked us to
surface before diverging; P1 should not start until these are confirmed.

This was produced by reading the actual code (job queue, worker pool, DB
layer, storage layer, every API route, the render/export pipeline, and the
Cloudinary integration) rather than assuming the spec's description matches
what's there. Where it didn't match, that's called out explicitly below.

---

## 1. What the code actually does today (confirmed by reading it)

**Fully single-tenant, zero auth, as documented.** `docs/DEPLOY.md`,
`render.yaml`, and a comment in `config.ts` already say "no login." No
`middleware.ts`, no auth library in `package.json`, no `users` table. Every
one of the 25 API routes under `src/app/api/` fetches by a client-supplied
ID with no ownership check — this isn't a gap to patch per-route, it's the
universal current behavior, confirmed route by route.

**Good news — more infrastructure already exists than the spec assumed:**

- **Priority already exists** (`jobs.priority`, lower runs sooner), but as a
  single static integer with no weight and no per-tenant fairness. Claiming
  is `ORDER BY priority, created_at` — strict FIFO within a priority level.
- **Leases/heartbeats already exist.** Workers heartbeat every 5s;
  `reclaimStale()` requeues jobs whose heartbeat is older than 5 minutes, run
  at pool start and every 60s. Gaps: no explicit lease-expiry column
  (staleness is "heartbeat age" with one global threshold), and
  `complete()`/`fail()` don't check `worker_id`, so a reclaimed-but-still-alive
  worker can race a new claimant.
- **Atomic claiming already works**, via a SELECT-candidates-then-per-row-
  `UPDATE…WHERE status='pending'` inside an `IMMEDIATE` transaction. Safe
  under SQLite's single-writer guarantee. This guarantee is **per SQLite
  file** — important once jobs move to a separate control-plane DB from
  tenant data (see §3).
- **OS-level worker priority already exists** —
  `os.setPriority(child.pid, PRIORITY_BELOW_NORMAL)` is already called on
  every spawned worker in `pool.ts`. The spec's §5 ask here is already done;
  only the *web process's own* priority (left at default/normal) might
  warrant an explicit `os.setPriority` call for symmetry, though that's
  arguably unnecessary — leaving the web process at normal and workers below
  it already produces the desired relative priority.
- **A version-tracked migration runner already exists**
  (`src/db/migrate.ts`), and it already takes a `Db` parameter rather than
  assuming a singleton — it's already shaped for "run this against any
  handle," which is exactly what per-tenant lazy migration needs.
- **No module-level caches of decoded images or analysis results** were
  found anywhere in `src/vision/`. The ONNX session manager (one session per
  model per process) is the only long-lived vision state, and it's pure
  model weights — safe to share across tenants as-is.

**Real gaps the spec correctly anticipated:**

- `media-store.ts`'s `ROOTS` and `config.paths.*` are frozen at module load
  from one `dataDir` — not per-call, so tenant-scoping requires turning
  these into functions, not just adding a parameter somewhere.
- The AI-Extend derived-asset cache key (`sourceHash` + prompt) has no
  tenant component — exactly the cross-tenant leak (and paid-credit
  double-charge prevention... working in reverse) the spec's "dedup is
  per-tenant only" rule exists to prevent.
- The global vision-analysis cache (`vision_analyses` keyed on
  `(source_hash, engine_version)`) would give tenant B a cache hit on tenant
  A's analysis of identical photo bytes if they ever shared a DB — confirmed
  as a real hazard, not hypothetical, since stock photos and common product
  shots collide on hash routinely.
- Bulk ZIP download and export conversion both **fully buffer in memory**
  despite a comment in the download route claiming "streamed" (that comment
  only describes the output side — every input file is fully read, format-
  converted, and held as a `Buffer` before any bytes are added to the zip).
  Upload ingestion also fully buffers (`request.formData()`) before checking
  size caps, so the cap doesn't bound memory, only reject after the fact.

---

## 2. Target layout

```
data/
  control.db                         # users, tenants, memberships, sessions,
                                      # jobs (global queue), quotas, usage, audit
  tenants/
    <tenantId>/
      app.db                         # products, images, vision_analyses,
                                      # templates, rules, batches, creatives
      media/
        originals/ derived/ creatives/ assets/
      tmp/                           # staging uploads, export scratch; TTL-swept
models/                              # UNCHANGED — global, read-only, shared
```

`modelDir` stays exactly as it is today: ONNX weights are not tenant data,
and nothing about loading them needs to change.

---

## 3. Conflicts between the spec and the actual code — **DECISIONS NEEDED**

### 3.1 The `jobs.batch_id → batches` foreign key cannot survive the DB split

**The conflict:** `jobs` has `batch_id TEXT REFERENCES batches(id) ON DELETE
CASCADE`, and `queue.cancelBatch()` / `isBatchCancelled()` read the
`batches` table directly, assuming it's in the same database file as `jobs`.
The spec puts `jobs` in `control.db` and `batches` in each tenant's
`app.db`. SQLite foreign keys cannot span separate database files opened as
independent connections (ATTACH-based cross-DB FKs exist but aren't
reliably enforced by better-sqlite3 and would reintroduce exactly the kind
of implicit cross-tenant coupling we're trying to eliminate — not
recommended).

**Recommended resolution:** Drop the FK entirely. `jobs` in `control.db`
gets a plain `(tenant_id, batch_id)` pair with no referential constraint.
Cascade-on-delete becomes an explicit two-step **application-level**
operation, ordered so a crash mid-operation fails safe:

1. Cancel/delete the batch's jobs in `control.db` first (by
   `tenant_id + batch_id`).
2. Delete the batch row in the tenant's `app.db` second.

If step 1 succeeds and step 2 is interrupted, the batch row survives with no
jobs attached (harmless — it just looks "stuck," discoverable and
re-deletable). If step 1 is interrupted, nothing has changed. The failure
mode that must never happen — a deleted batch with jobs still silently
running against it — is excluded either way. `getBatchProgress` and
`listByBatch` become plain filtered queries against `control.db` by
`(tenant_id, batch_id)` — no cross-DB JOIN needed, since progress is always
looked up for one specific batch the caller already knows the ID of.

**This changes the architecture as the spec anticipated it might; flagging
per the Phase 0 contract.** If a different resolution is preferred (e.g.
keeping a `jobs` *pointer* table inside each tenant DB for cascade safety,
with `control.db` holding only the dispatch-relevant columns), say so before
P1 — the migration script and `generation-service.ts` call sites differ
depending on which is chosen.

### 3.2 Weighted fair-share scheduling needs a concrete claim mechanism, not just a policy statement

**The conflict:** the spec describes the policy ("choose the tenant with
lowest `running_jobs / weight` among those with queued work") but the
current `claim()` is a single flat query (`ORDER BY priority, created_at`)
with no notion of tenants at all. Computing `running_jobs` per tenant via a
live `GROUP BY` over the full `jobs` table on every single claim (workers
poll every 250ms, N of them) does not scale and reintroduces exactly the
kind of expensive-query-per-claim pattern that makes fairness logic a
performance risk.

**Recommended resolution:** a small denormalized `tenant_queue_state` table
in `control.db`:

```sql
CREATE TABLE tenant_queue_state (
  tenant_id     TEXT PRIMARY KEY,
  weight        REAL NOT NULL DEFAULT 1.0,
  running_jobs  INTEGER NOT NULL DEFAULT 0
);
```

`running_jobs` is incremented transactionally inside the same `IMMEDIATE`
transaction that claims a job, and decremented inside `complete()`/`fail()`/
`reclaimStale()`. The claim query becomes: among tenants with at least one
`pending` job of the requested kind, pick the one with the lowest
`running_jobs / weight` (ties broken by the oldest `pending` job's
`created_at`), then claim that tenant's oldest eligible job. This is one
indexed join instead of an aggregate scan, and it's the standard shape for
weighted fair queuing over a small number of active tenants. Interactive vs.
bulk priority classes sit on top of this unchanged (priority is still
checked first, within a tenant's own jobs).

**Not asking for a decision here** — this is an implementation detail
within the stated policy, included for concreteness since "weighted fair
share" alone isn't buildable without picking a bookkeeping mechanism.

### 3.3 AsyncLocalStorage cannot cross the worker process boundary — already correctly anticipated by the spec

Confirmed: worker children are separate OS processes (`child_process.spawn`),
so no in-process context (ALS or otherwise) reaches them. The spec already
says the job message must carry `tenantId` and the worker binds its own
context — this matches what the code requires exactly, so no conflict, just
confirming the job row needs a `tenant_id` column threaded into the
`job:done`/`job:failed` IPC messages too (today's payloads carry
`imageId`/`sourceHash`/`templateId` etc. but nothing identifying a tenant).

### 3.4 Cloudinary stays ONE shared account — confirming, not conflicting

The spec's wording ("per-tenant concurrency cap") could be misread as
"per-tenant credentials." Confirmed from the code: `cloudinary.config()` is
a process-global SDK singleton, called once. Re-reading the full spec
section, it only asks for a **global** concurrency limit + rate limiter with
a **per-tenant cap layered on top** (a quota, not separate credentials) —
consistent with one shared paid account. Documenting this explicitly so the
dispatcher design (§5) isn't built around per-tenant credential swapping,
which the SDK doesn't support without re-`config()`-ing between calls (racy
across concurrent workers sharing the process).

### 3.5 Streaming vs. moving CPU work to the worker pool for downloads/exports

The spec says both "the web process does no heavy CPU work" and "convert
buffer-everything-in-memory behavior to streaming" for the same routes.
These aren't quite the same fix. `sharp`'s encode/resize work runs in
libvips' native thread pool, off Node's event loop — it doesn't block other
requests the way synchronous JS would, but it does consume CPU cores in the
web process, and the size-budget search does ~7 full decode+encode passes
per image today.

**Recommended resolution:** fix the memory problem (stream the ZIP
file-by-file via a library that supports lazy entries — `archiver` or `yazl`
— instead of JSZip's buffer-everything-then-generate; stream uploads to a
tenant `tmp/` file instead of buffering `formData()`), and treat the CPU
question as a quota/scheduling concern rather than a hard relocation: cap
concurrent export conversions per tenant (reusing the same quota mechanism
as job concurrency) rather than moving every single-photo export through
the full job-queue-and-poll cycle, which would turn a sub-second download
into a multi-second round trip for no real benefit at typical bulk-download
sizes. Large bulk ZIP generation (hundreds of images) is the case worth
moving to a background job with a polled "ready" state; a single creative's
export is not. **Flagging this as a judgment call, not re-litigating it
silently** — if "no heavy CPU work in the web process" is meant literally
even for single-file exports, that's a larger UX change (export becomes
async everywhere) worth confirming before P4.

---

## 4. TenantContext

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

- Set once per request, in a single middleware/wrapper around route
  handlers (the existing `handler()` in `src/lib/api.ts` is the natural
  place — it already wraps every route for error handling, confirmed by the
  investigation as the one place all 25 routes already funnel through).
- `db/client.ts`'s `getDb()` reads `currentTenant().tenantId`, looks up (or
  lazily opens) that tenant's handle in the LRU, and **throws if no context
  is set** — fail closed, per the spec. No default tenant, ever.
- `media-store.ts`'s `ROOTS` becomes a function of `currentTenant()` instead
  of a module-level constant computed once at import time.
- Workers: the job row's `tenant_id` is read in `runOne()`, and the handler
  body is wrapped in `runWithTenant({tenantId, ...}, () => handle(job))` —
  this is where the worker "binds its own context" the spec describes.
- `vision-service.ts`'s engine singleton keeps its shared ONNX provider but
  gets its `cache` and `maskSink` ports reconstructed per tenant (cheap —
  they're just closures over the tenant's `getDb()`/media root, not new
  model instances) rather than built once globally.

**Lint guard** (§7 of the spec): a script that greps for `getDb(` and
`ROOTS[` outside `src/db/client.ts` / `src/storage/media-store.ts`, and for
any new raw `new Database(` outside the client module (closing the exact
hole `scripts/clear-queue.js` currently represents). Wired into
`npm run lint` or a pre-commit check in P2.

---

## 5. Scheduler (expands §3.2)

```
control.db:
  jobs (id, tenant_id, kind, priority_class, status, attempts, max_attempts,
        worker_id, lease_expires_at, heartbeat_at, dedupe_key UNIQUE(tenant_id, dedupe_key),
        payload, created_at, updated_at, completed_at, error)
  tenant_queue_state (tenant_id, weight, running_jobs)
```

- `dedupe_key` uniqueness moves from global to `(tenant_id, dedupe_key)` —
  fixes the cross-tenant job-suppression hazard found in `worker.ts`'s
  background-fill dedupe key (`bgfill:${sourceHash}:${templateId}`, today
  global).
- Priority classes (`interactive` / `bulk`) are a column, checked before the
  fairness ordering within a tenant's own queue — a tenant's own interactive
  job still jumps their own bulk backlog, independent of fairness across
  tenants.
- Reserve ≥1 render slot for interactive by having render workers prefer
  `priority_class='interactive'` first regardless of which tenant, falling
  back to the fairness-ordered bulk pick only when no interactive work is
  queued anywhere.
- `reclaimStale()` additionally decrements `tenant_queue_state.running_jobs`
  for the tenant whose lease expired.
- Startup memory-budget check: extend `defaultConcurrency()` (which already
  reads `process.constrainedMemory()` / `os.availableParallelism()`) to also
  account for per-tenant-handle `cache_size` (today 32MB/handle) × the
  planned LRU size, so the vision-worker count it computes doesn't leave no
  headroom for open tenant DB handles.

## 6. AI Extend dispatcher

A single module-level (shared, since Cloudinary creds are global — §3.4)
dispatcher: a counting semaphore for global concurrency, a token-bucket rate
limiter, and a `Map<tenantId, count>` for the per-tenant cap. Every
`background_fill` job acquires through the dispatcher before calling
`generativeFill`; on a 429, the existing `defer()`-with-backoff path stays,
just reads `Retry-After` when present instead of the current fixed 20s
cooldown. Monthly usage metering is a `control.db` counter incremented on
each successful generation, read by the admin page (§8) and checked against
quota before the dispatcher even attempts the call (fail fast with a clear
tenant-facing error rather than spending a slot on a call that'll be
rejected downstream).

## 7. Legacy migration

`npm run tenants:migrate-legacy`:
1. Refuses to run without `--i-have-a-backup` (or equivalent confirmation
   flag).
2. Creates `control.db`, runs its schema.
3. Creates the first tenant + `platform_admin` user from `ADMIN_EMAIL` /
   `ADMIN_PASSWORD`.
4. Moves `data/vision-studio.db` → `data/tenants/<id>/app.db`, moves
   `data/media/*` → `data/tenants/<id>/media/*`, preserving every path
   exactly (content-addressed keys don't change, only their root).
5. Verifies: row counts per table match pre/post, file counts under each
   media root match, and a sample of N source hashes re-resolve to the same
   bytes.
6. Idempotent: safe to re-run (checks whether the legacy DB file still
   exists at the old path before doing anything).

`scripts/migrate.ts` (the existing single-DB runner) becomes: migrate
`control.db`, then enumerate tenants from `control.db` and call the
existing `migrate(db)` (already parameterized — no change needed to that
function itself) against each tenant handle.

---

## 8. Still to detail in later phases (not blocking P1)

- Exact `control.db` schema for `users` / `memberships` / `sessions` /
  `quotas` / `usage` / `audit_log` (P1).
- Admin page field list and the ops runbook (backup/restore/move/delete/
  suspend) (P5/P6, after the storage layout in §2 is implemented and there's
  something concrete to document procedures against).
- Load test script and its recorded results (P6).

---

## Summary: what needs sign-off before P1 starts

1. **§3.1** — drop the `jobs.batch_id` FK, handle cascade at the application
   level in the stated order. Confirm, or specify the pointer-table
   alternative.
2. **§3.5** — single-file export stays synchronous-in-web-process (CPU
   bounded by quota, not moved to the job queue); only bulk ZIP generation
   and upload ingestion move to true streaming. Confirm, or require all
   image conversion to go through workers.

Everything else in this document is either already-confirmed-aligned with
the spec or an implementation detail within a decision the spec already
made. Absent objections, P1 (control plane, auth, TenantContext, legacy
migration) starts from this document as written.

---

## 9. P4 manual QA checklist — two-session smoke test

No browser test harness exists in this repo (no Playwright/Cypress/
Puppeteer), so the isolation properties the automated suite already checks
at the HTTP level (`tests/isolation/*`) are worth re-confirming once, by
hand, the way an actual user would encounter them: two browser sessions
side by side, logged in as two different tenants.

Run through this after any change touching auth, tenancy context, the job
queue, or the streaming upload/export paths.

### Setup

1. Two tenants, each with at least one user (`scripts/`'s admin bootstrap or
   the signup flow, whichever is enabled).
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
