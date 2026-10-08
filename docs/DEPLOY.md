# Deploying Vision Studio

This is a self-hosted, multi-tenant deployment: one Docker container, one
persistent volume, Caddy terminating TLS in front of it. There is no
free-tier path anymore — multi-tenancy needs a volume that survives a
restart (every tenant's database and photos live on it), which rules out
Render's free plan entirely (no persistent disk, auto-sleep wipes the
filesystem). `render.yaml` in the repo root is a leftover from the
pre-multi-tenancy single-user deployment and should not be used for a real
deployment of this version — it has no login and no persistent storage,
both of which are now load-bearing assumptions elsewhere in the app.

## What you're deploying

- **Dockerfile** (repo root) — single-stage, `node:20-slim`, builds as a
  non-root `node` user, bakes in the ~160MB of ONNX model weights at build
  time, runs a `HEALTHCHECK` against `/api/health`.
- **docker-entrypoint.sh** — runs `control.db` + every tenant's `app.db`
  migration on every start (idempotent, safe to run on an already-migrated
  volume), then `exec`s the real server process so it becomes PID 1 and
  receives `SIGTERM` directly for graceful shutdown.
- **A Caddyfile** (below) — reverse proxy, TLS, and the forwarded headers
  `TRUST_PROXY`/the Origin check depend on.
- **One persistent volume** mounted at `/app/data` — everything this app
  ever writes (control-plane DB, every tenant's own DB and media, nothing
  else) lives under it.

## Volume layout

```
/app/data/
  control.db(-wal/-shm)              # users, tenants, sessions, job queue, quotas, audit
  tenants/
    <tenantId>/
      app.db(-wal/-shm)              # that tenant's products, images, templates, creatives
      media/{originals,derived,creatives,assets}/
      tmp/                           # upload staging — TTL-swept, safe to lose
```

Back this volume up regularly — see `docs/OPERATIONS.md`. A plain filesystem/
volume snapshot of it is **crash-consistent only** (equivalent to the
server losing power mid-write — SQLite's WAL recovers from that safely on
next open, but it's a weaker guarantee than the online backup `scripts/
backup.ts` takes through the app itself). `models/` is NOT on this volume —
it's baked into the image, read-only, identical across every tenant.

---

## Environment variables

Every variable has a working default (see `.env.example` for the canonical,
commented copy) — only the ones marked **required** below actually need
setting for a real deployment.

| Variable | Default | Notes |
|---|---|---|
| `VISION_STUDIO_DATA_DIR` | `./data` | Mount your persistent volume here. |
| `VISION_STUDIO_MODEL_DIR` | `./models` | Baked into the image; leave alone. |
| **`APP_ORIGIN`** | *(empty)* | **Required in production.** Your public origin, e.g. `https://studio.example.com`. The CSRF Origin check compares against this, not Next's own (proxy-hidden) view of its host — leaving it blank in production rejects every real mutating request. |
| **`TRUST_PROXY`** | `false` | **Required `true`** once Caddy is in front (see the Caddyfile below) — otherwise login rate-limiting keys every request off one shared "unknown" IP bucket. Only set `true` behind a proxy you control that sets this correctly; see §"Forwarded headers" below. |
| **`ADMIN_EMAIL`** / **`ADMIN_PASSWORD`** | *(empty)* | **Required** for the legacy migration / first-tenant bootstrap. Rotate the password immediately after first login (see post-deploy checklist). |
| `ALLOW_SIGNUP` | `false` | Leave `false` unless you deliberately want self-service registration — every account is otherwise admin-created. |
| `ALLOW_MULTI_TENANT_PREVIEW` | *(empty)* | Set to exactly `1` to allow creating a second tenant. See §"ALLOW_MULTI_TENANT_PREVIEW" below before deciding whether to remove this gate. |
| `SESSION_TTL_MS` | `2592000000` (30d) | Sliding expiry, refreshed on use. |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_WINDOW_MS` | `10` / `900000` | Per-account; per-IP cap is `4×` this, see `docs/MULTI_TENANCY.md` §7. |
| `COOKIE_SECURE` | unset (→ `true` when `NODE_ENV=production`) | Only override to deliberately run production without TLS yet (not recommended — the real fix is Caddy terminating TLS). |
| `JOB_VISION_CONCURRENCY` / `JOB_RENDER_CONCURRENCY` | `1` (dev) / sized from cores+memory (production) | See the recommended-settings table in this doc's load-test report, or `scripts/loadtest-multitenant.ts`'s own output for your actual hardware. |
| `VISION_ORT_THREADS` | sized from cores (production) | ONNX Runtime intra-op threads per vision worker. |
| `JOB_POLL_INTERVAL_MS` | `250` | SQLite-backed queue poll interval. |
| `JOB_MAX_ATTEMPTS` | `3` | Attempts before a job parks as `failed`. |
| `JOB_STALE_CLAIM_MS` | `300000` | Lease duration / staleness threshold. |
| `BULK_MAX_WAIT_SECONDS` | `900` | A pending bulk job older than this is promoted to interactive class. |
| `JOB_RETENTION_DAYS` | `30` | Finished job rows older than this are pruned from `control.db`. |
| `JOB_MAINTENANCE_SWEEP_INTERVAL_MS` | `1800000` | Slow sweep cadence (retention, media orphans, storage reconciliation). |
| `UPLOAD_TMP_TTL_MS` | `21600000` | Abandoned upload fragments older than this are swept. |
| **`SHUTDOWN_GRACE_SECONDS`** | `30` | Grace period on `SIGTERM` before killing in-flight jobs. **Your orchestrator's own stop timeout (`docker stop -t`) must exceed this**, or `SIGKILL` arrives first and skips the graceful path. |
| **`DISK_MIN_FREE_GB`** | `2` | Below this much free space on the data volume, new uploads are refused with a clear error. |
| `JOB_MAX_RUNTIME_VISION_MS` / `_RENDER_MS` / `_BACKGROUND_FILL_MS` | built-in defaults (60s/90s/`CLOUDINARY_TIMEOUT_MS`+60s) | Per-kind hang watchdog. |
| `AI_EXTEND_GLOBAL_MONTHLY_CAP` | `20000` | Whole-account circuit breaker, independent of any tenant's own quota. |
| `AI_EXTEND_GLOBAL_CONCURRENCY` | = `CLOUDINARY_JOB_CONCURRENCY` | Max simultaneous Cloudinary calls across all workers. |
| `AI_EXTEND_RATE_LIMIT_PER_SECOND` / `_BURST` | `2` / `4` | Token-bucket limiter in front of Cloudinary. |
| `AI_EXTEND_PER_TENANT_CONCURRENCY` | `2` | Independent of the global cap. |
| `AI_EXTEND_MAX_ATTEMPTS` / `_BASE_BACKOFF_MS` / `_MAX_BACKOFF_MS` | `3` / `2000` / `30000` | Low attempt count on purpose — every retry can spend a paid credit. |
| `EVENT_LOOP_LOG_INTERVAL_MS` | `60000` | Event-loop delay monitor log cadence. |
| `RENDER_OUTPUT_MAX_DIM` / `RENDER_SUPERSAMPLE` / `RENDER_JPEG_QUALITY` | `2048` / `2` / `95` | Creative rendering quality. |
| `EXPORT_GLOBAL_CONCURRENCY` / `EXPORT_PER_TENANT_CONCURRENCY` | `4` / `2` | Export (download-time) conversion concurrency caps, web process. |
| `EXPORT_SLOT_WAIT_MS` | `2000` | How long a download waits for a free export slot before 429/503. |
| `ZIP_INTERNAL_CONCURRENCY` | `3` | A single bulk ZIP's own internal conversion cap. |
| `CLOUDINARY_CLOUD_NAME` / `_API_KEY` / `_API_SECRET` | *(empty)* | AI Extend is simply unavailable until all three are set — everything else works offline. |
| `CLOUDINARY_JOB_CONCURRENCY` | `4` | Separate from render concurrency — bounds a remote billed API, not local CPU. |
| `CLOUDINARY_TIMEOUT_MS` | `180000` | A first-time generative fill genuinely takes 30-60s; this bounds a stuck request, not a slow one. |
| `CLOUDINARY_MAX_UPLOAD_DIM` | `4096` | Must be ≥ your largest template canvas × `RENDER_SUPERSAMPLE`. |

---

## Forwarded headers (Caddy)

`TRUST_PROXY=true` only means anything if whatever sits in front of this
app is trusted to have **set** `X-Forwarded-For` to the real client IP as
the LAST entry — `src/auth/client-ip.ts` reads the last hop specifically
because that's the one entry the proxy itself is responsible for, regardless
of what a client sent further upstream. Caddy's `reverse_proxy` does this by
default (it appends the real connecting IP as the final entry in the chain),
so no extra configuration is needed beyond `TRUST_PROXY=true` — just don't
put a second untrusted proxy in front of Caddy without accounting for it.

```caddyfile
# /etc/caddy/Caddyfile
#
# No basic auth here — Vision Studio has its own login (sessions, per-tenant
# accounts). Basic auth in front of it would just ask for a second,
# unrelated set of credentials.

studio.example.com {
	# Caddy terminates TLS automatically (ACME/Let's Encrypt) for any
	# domain here — nothing else to configure for HTTPS.

	reverse_proxy localhost:3000 {
		# Caddy sets these by default; listed explicitly so the
		# dependency is visible rather than implicit:
		#   X-Forwarded-For   (appends the real client IP as the last hop —
		#                      see src/auth/client-ip.ts)
		#   X-Forwarded-Proto
		#   X-Forwarded-Host
		header_up X-Forwarded-For {http.request.header.X-Forwarded-For}
		header_up X-Forwarded-Proto {scheme}
		header_up X-Forwarded-Host {host}
	}
}
```

Point `APP_ORIGIN=https://studio.example.com` at the same domain this
Caddyfile serves — the CSRF check in `src/lib/api-handler.ts` compares every
mutating request's `Origin` header against this, not against whatever
internal host/port the Next.js process is actually bound to behind the
proxy.

---

## First deploy

1. **Provision a host** with persistent storage attached (any VPS — a
   DigitalOcean/Hetzner/Linode droplet, or your own server). 4 vCPU / 8 GB
   RAM is the baseline this app's load test targets (see the recommended
   settings table in the load-test report); smaller works for a single
   light tenant, just raise concurrency settings conservatively.
2. **Create the data volume** and note its mount path, e.g. `/mnt/vision-data`.
3. **Set required environment variables** (`APP_ORIGIN`, `TRUST_PROXY=true`,
   `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `NODE_ENV=production`) — via `.env`,
   your orchestrator's secret store, or `docker run -e`.
4. **Build the image**: `docker build -t vision-studio .`
5. **Run it**, with the volume mounted at `/app/data` and the orchestrator's
   stop timeout set above `SHUTDOWN_GRACE_SECONDS`:
   ```sh
   docker run -d --name vision-studio \
     --stop-timeout 45 \
     -p 3000:3000 \
     -v /mnt/vision-data:/app/data \
     --env-file .env \
     vision-studio
   ```
   The entrypoint runs `control.db` + tenant migrations automatically. On a
   brand-new volume this creates an empty, migrated `control.db` with **no
   tenants yet**.
6. **Install Caddy** in front of it (the Caddyfile above), pointed at
   `localhost:3000`.
7. **Bootstrap the first tenant.** Two cases:
   - **Brand-new deployment, no prior single-tenant data**: `docker exec -it
     vision-studio npm run admin:create-tenant -- --email you@example.com`
     (see `docs/OPERATIONS.md` for the exact flags).
   - **Migrating an existing pre-multi-tenancy deployment** (you have a
     legacy `data/vision-studio.db` + `data/media/` from before this
     version): copy that legacy data onto the new volume first (so it's at
     `/app/data/vision-studio.db` and `/app/data/media/`), **take a backup
     of the volume before continuing** (this migration moves files in
     place with no backup of its own), then run:
     ```sh
     docker exec -it vision-studio npm run tenants:migrate-legacy -- --i-have-a-backup
     ```
     This is the **only** step that touches the legacy layout, and it is
     never run automatically by the container starting — see
     `docker-entrypoint.sh`'s own comment and `docs/MULTI_TENANCY.md` §8.
8. **Log in as `ADMIN_EMAIL`**, confirm the forced password change works,
   and run the post-deploy checklist below.

## Update procedure

1. `git pull` (or pull the new image) on the host.
2. `docker build -t vision-studio .` (rebuilds against the current
   `package-lock.json` and source).
3. `docker stop vision-studio` — gives the running container
   `SHUTDOWN_GRACE_SECONDS` to finish in-flight jobs before the
   `--stop-timeout` you set kills it. Watch the logs for
   `[shutdown]`/`[pool]` lines confirming an orderly stop, not a timeout
   kill.
4. `docker rm vision-studio`, then re-run the same `docker run` command
   from step 5 above (same volume, same env) with the freshly built image.
   The entrypoint re-runs migrations automatically — safe, idempotent, and
   a no-op if nothing changed.
5. Confirm `/api/health` returns `{"status":"ok"}` and spot-check the admin
   console before considering the update complete.

No step here ever runs `tenants:migrate-legacy` — that command only exists
for the one-time legacy transition and must never be part of a routine
update.

---

## `ALLOW_MULTI_TENANT_PREVIEW`

This flag gates creating a second (or further) tenant at all. It predates
P3's scheduler work, from a point when the worker pool and job queue were
still genuinely single-tenant — enabling a second tenant then would have
meant real data corruption or cross-tenant leakage, not just a rough edge.

**As of P3 (fair-share scheduler, per-job tenant binding, quotas) that
architectural blocker no longer exists** — see `docs/MULTI_TENANCY.md` §4.
The flag today is a deliberate opt-in, not a safety rail that's still load-
bearing against known-broken behavior.

**What would need to be true to remove it entirely** (make multi-tenant the
unconditional default, no flag required):

1. **This document's load-test report** (see below) run on the actual
   target production hardware, with every stated target (fairness, p95
   latency under saturation, aggregate throughput, memory flatness) met or
   explicitly accepted with documented numbers — not just run once on a
   dev laptop.
2. **The chaos scenario** (kill -9 a worker, restart the container mid-run)
   rehearsed on that same hardware with zero job loss and zero corrupt
   results confirmed by evidence, not assumption.
3. **At least one real multi-tenant deployment window** — this flag turned
   on deliberately, two or more tenants actually running concurrently for
   some period, with no isolation incident (cross-tenant data visibility,
   one tenant's load starving another) observed or reported.
4. **The security pass in this document** (login rate limiting, CSRF,
   cookie flags, production error leakage, tenancy-boundary lint guard)
   passing with no open finding — done as of P6, see the P6 report.

**Recommendation: do not remove it yet.** Items 1–3 above are either not
yet done on real production-class hardware or not yet accumulated as
operating history — the flag costs nothing to leave in place (it's one
admin action to flip on), while removing it prematurely turns "a second
tenant" from a deliberate decision into something that happens by default
the next time someone reruns the legacy migration or a setup script,
exactly the accidental-activation failure mode the flag exists to prevent.
Revisit once items 1–3 have real evidence behind them, ideally after this
app has run multi-tenant in production for at least one full billing/usage
cycle.

---

## AI Extend — Cloudinary generative fill

The "AI Extend" background mode (per-template, opt-in) calls Cloudinary's
generative-fill API to extend a photo's own backdrop into the empty canvas
around it. Everything else in this app runs offline; this is the one
outbound dependency, and the one that costs money — see
`docs/MULTI_TENANCY.md` §6 for the dispatcher (global + per-tenant
concurrency, rate limiting, monthly circuit breaker) that sits in front of
every call.

Set `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET`
to enable it; leave any one blank and the feature is simply unavailable
(the Template Builder shows this before a batch runs, not after a pile of
failed jobs). One shared account across every tenant — not per-tenant
credentials, see `docs/MULTI_TENANCY.md` §6 for why.

---

## Pre-deploy checklist

- [ ] `.env` has `APP_ORIGIN`, `TRUST_PROXY=true`, `ADMIN_EMAIL`,
      `ADMIN_PASSWORD`, `NODE_ENV=production` set — not left at defaults.
- [ ] The host has a persistent volume attached and mounted at a path you
      control, with enough free space above `DISK_MIN_FREE_GB`.
- [ ] `npm run build`, `npm test`, `npm run typecheck`, and `npm run lint`
      all pass on the exact commit being deployed.
- [ ] `npm audit` reviewed — no new HIGH/CRITICAL findings beyond the
      accepted, documented residual risk (see the P6 report).
- [ ] The orchestrator's stop timeout exceeds `SHUTDOWN_GRACE_SECONDS`.
- [ ] If migrating a legacy single-tenant deployment: a backup of the
      legacy volume exists and has been verified restorable BEFORE running
      `tenants:migrate-legacy`.
- [ ] Caddy (or your reverse proxy) is configured to forward the real
      client IP as the last `X-Forwarded-For` hop, matching `TRUST_PROXY`'s
      assumption.

## Post-deploy verification checklist

- [ ] `/api/health` returns `{"status":"ok"}` over the public domain
      (through Caddy, not just `localhost:3000` on the host).
- [ ] `docker exec vision-studio whoami` reports `node`, not `root`.
- [ ] Log in as `ADMIN_EMAIL`, confirm the forced password-change flow, and
      rotate the password immediately (the one in `.env` should not remain
      the live credential — see `docs/OPERATIONS.md`'s reset procedure if
      you need to change it again later).
- [ ] Run `docs/MULTI_TENANCY.md` §10's **two-tenant smoke test** end to
      end — this is the real verification that tenant isolation, the
      scheduler, and quotas all work correctly in the actual deployed
      environment, not just in the test suite.
- [ ] Confirm a `docker stop` / redeploy cycle completes without losing an
      in-flight job (start a bulk import, stop the container mid-run,
      restart, confirm the job resumed rather than vanished).
- [ ] Take a first backup (`npm run backup` — see `docs/OPERATIONS.md`) and
      confirm it restores into a scratch directory before relying on the
      deployment with real tenant data.
