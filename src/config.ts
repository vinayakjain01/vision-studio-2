/**
 * Central configuration — the single place environment variables are read.
 *
 * Every value has a working default so the application runs with no .env file.
 * Nearly nothing here reaches out to a network service — Vision Studio is
 * standalone by design (no OAuth, no hosted database, no media CDN) — with one
 * deliberate exception: the "AI Extend" background mode calls Cloudinary's
 * generative-fill API to extend a photo's background into the empty canvas
 * around it, because that is a genuinely hard image problem this app has no
 * local model for. It is entirely opt-in per template and never falls back to
 * a plain fill silently — see `CloudinaryServiceError` handling in
 * `src/jobs/worker.ts`.
 *
 * Every call costs paid credits, which is why the result is cached as a
 * derived asset keyed by (photo hash, canvas, padding, prompt) — see
 * `aiExtendCacheKind` in `src/render/compositor.ts`.
 *
 * Server-only. Do not import from a client component — it touches `path` and
 * `process.env` values that are not `NEXT_PUBLIC_`-prefixed.
 */

import os from 'os'
import path from 'path'

function int(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === '') return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function float(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === '') return fallback
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function resolveFromRoot(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value)
}

const dataDir = resolveFromRoot(process.env.VISION_STUDIO_DATA_DIR || './data')
const modelDir = resolveFromRoot(process.env.VISION_STUDIO_MODEL_DIR || './models')

/**
 * A tenant ID used in a filesystem path has to be validated as strictly as
 * any other path segment, independent of `media-store.ts`'s own key
 * validation — this one guards the ROOT, not a key under it. IDs minted by
 * `newId()` (`<prefix>_<nanoid>`) always match this; anything that doesn't
 * is either a bug or an attempt to escape the tenant root, and either way
 * must not be trusted as a path component.
 */
const TENANT_ID_PATTERN = /^[A-Za-z0-9_-]+$/

export function assertValidTenantId(tenantId: string): void {
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new Error(`invalid tenant id: ${JSON.stringify(tenantId)}`)
  }
}

/**
 * Per-tenant paths, computed on demand rather than frozen at module load —
 * the single biggest structural change this file makes for multi-tenancy.
 * Every caller that used to read `config.paths.database` /
 * `config.paths.originals` etc. now calls `tenantPaths(tenantId)` instead,
 * with the tenant id coming from `currentTenant()` (request/page code) or
 * passed explicitly (scripts, migration, workers — see their own files for
 * why each of those can't use `currentTenant()`).
 */
export function tenantPaths(tenantId: string) {
  assertValidTenantId(tenantId)
  const root = path.join(dataDir, 'tenants', tenantId)
  return {
    root,
    database: path.join(root, 'app.db'),
    originals: path.join(root, 'media', 'originals'),
    derived: path.join(root, 'media', 'derived'),
    creatives: path.join(root, 'media', 'creatives'),
    assets: path.join(root, 'media', 'assets'),
    tmp: path.join(root, 'tmp'),
  }
}

export type TenantPaths = ReturnType<typeof tenantPaths>

/**
 * Default worker counts.
 *
 * One vision worker, one render worker, one ORT thread each. Full stop — not a
 * formula.
 *
 * An earlier version sized this off free memory and core count, scaling up to
 * 4 and then to 2 workers of each kind on the reasoning that a 12-core, 16 GB
 * laptop has room to spare. It does not. In practice, spawning even 2–4
 * worker processes — each starting `tsx`, then loading four ONNX graphs —
 * produced a burst of CPU and disk contention severe enough to make the
 * entire machine stop responding to input, not just this application: window
 * switching, other apps, everything. That is a far worse failure mode than
 * generation taking longer, and no amount of formula-tuning fixed it, because
 * the arithmetic was never the problem — it was reasoning about a laptop as
 * though it were a dedicated, otherwise-idle server. It is neither: it is
 * running a browser, an IDE, a chat client and whatever else at the same
 * time, and this application should be the considerate guest, not the one
 * that assumes it owns the machine.
 *
 * One worker of each kind is the load a normal laptop can absorb without the
 * person noticing anything happened at the OS level. It costs throughput —
 * a big batch takes longer — which is a fair trade against "unusable while it
 * runs." `JOB_VISION_CONCURRENCY`, `JOB_RENDER_CONCURRENCY` and
 * `VISION_ORT_THREADS` raise it explicitly for a machine confirmed to have
 * room, rather than the app guessing that every machine does.
 */
function defaultConcurrency(): { vision: number; render: number; ortThreads: number } {
  const conservative = { vision: 1, render: 1, ortThreads: 1 }

  // Everything above is about a shared laptop, and stays true there. A
  // production host is the opposite case — a box whose only job is this app —
  // and leaving it at 1 worker on 1 thread wastes every other core (one
  // analysis is ~9s, mostly the parsing model, so 200 photos is ~30 minutes).
  // Sized only when NODE_ENV=production and an explicit env var did not already
  // decide; `render.yaml` pins all three to 1 for Render's free plan, so that
  // deploy is unaffected.
  if (process.env.NODE_ENV !== 'production') return conservative

  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length
  // Inside a container `os.totalmem()` reports the HOST; the cgroup limit is
  // what the process can actually use.
  const limit = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0
  const memoryBytes = limit > 0 && limit < os.totalmem() ? limit : os.totalmem()
  const memoryGb = memoryBytes / 1024 ** 3

  // One core stays free for the web process; 1.5 GB for it and the OS.
  const usableCores = Math.max(1, cores - 1)
  const byMemory = Math.floor((memoryGb - 1.5) / 0.8) // ~700 MB per vision worker
  const vision = Math.max(1, Math.min(3, byMemory, Math.floor(usableCores / 2)))
  const ortThreads = Math.max(1, Math.min(4, Math.floor(usableCores / vision)))

  return { vision, render: 1, ortThreads }
}

const defaults = defaultConcurrency()

export const config = {
  paths: {
    dataDir,
    /**
     * Control-plane database: users, tenants, memberships, sessions, quotas,
     * usage, audit log. One file, shared by every tenant — never business
     * data. See `src/db/control-schema.sql`.
     */
    controlDatabase: path.join(dataDir, 'control.db'),
    /**
     * ONNX model weights. Global and read-only, not tenant data — every
     * tenant's vision analysis runs through the same shared model files.
     */
    modelDir,
  },

  vision: {
    /**
     * Longest edge the engine downsamples to before running inference.
     * Landmarks are always projected back into full source-image pixel space,
     * so this bounds inference cost without quantising output precision.
     */
    analysisMaxDim: int(process.env.VISION_ANALYSIS_MAX_DIM, 1280),
    personScoreThreshold: float(process.env.VISION_PERSON_SCORE_THRESHOLD, 0.35),
    personNmsIou: float(process.env.VISION_PERSON_NMS_IOU, 0.45),
    faceScoreThreshold: float(process.env.VISION_FACE_SCORE_THRESHOLD, 0.5),
    faceNmsIou: float(process.env.VISION_FACE_NMS_IOU, 0.4),
    keypointScoreThreshold: float(process.env.VISION_KEYPOINT_SCORE_THRESHOLD, 0.3),
    maskBinaryThreshold: float(process.env.VISION_MASK_BINARY_THRESHOLD, 0.5),
    ortThreads: int(process.env.VISION_ORT_THREADS, defaults.ortThreads),
  },

  jobs: {
    visionConcurrency: int(process.env.JOB_VISION_CONCURRENCY, defaults.vision),
    renderConcurrency: int(process.env.JOB_RENDER_CONCURRENCY, defaults.render),
    pollIntervalMs: int(process.env.JOB_POLL_INTERVAL_MS, 250),
    maxAttempts: int(process.env.JOB_MAX_ATTEMPTS, 3),
    /**
     * A job claimed but not updated for this long is presumed abandoned (worker
     * crash / process kill) and is returned to the queue on the next sweep.
     * Also the default lease DURATION granted at claim time (lease_expires_at
     * = claimed_at + this) — reclaimStale() compares against that expiry
     * rather than recomputing "how long since the last heartbeat" itself.
     */
    staleClaimMs: int(process.env.JOB_STALE_CLAIM_MS, 5 * 60 * 1000),
    /**
     * A 'bulk' job pending longer than this is promoted to 'interactive' class
     * so it can never starve behind a steady stream of fresh bulk work from
     * other tenants (see promoteAgedBulkJobs() in src/jobs/queue.ts).
     */
    bulkMaxWaitSeconds: int(process.env.BULK_MAX_WAIT_SECONDS, 900),
    /**
     * Deletes completed/failed/cancelled job rows from control.db older than
     * this. Safe: each batch's own summary counts are persisted onto its
     * `batches` row (in the tenant's own app.db, never pruned) well before
     * this window elapses — see `batches.refresh`/`applyProgress` and
     * generation-service.ts's call sites, which run on every job completion,
     * not just at prune time.
     */
    retentionDays: int(process.env.JOB_RETENTION_DAYS, 30),
    /**
     * Cadence for the SLOW maintenance sweep (job retention pruning, the
     * media orphan sweep, and storage-usage reconciliation — see pool.ts) —
     * separate from the 60s fast sweep (reclaimStale/reconcileRunningJobs/
     * promoteAgedBulkJobs, all cheap indexed SQL) because this one does a
     * real disk walk per tenant and a potentially-large DELETE, neither of
     * which needs to run anywhere near that often.
     */
    maintenanceSweepIntervalMs: int(process.env.JOB_MAINTENANCE_SWEEP_INTERVAL_MS, 30 * 60 * 1000),
    /**
     * A tmp/ upload fragment older than this is presumed abandoned — its
     * owning request crashed, was killed, or the client disconnected before
     * the route's own `cleanupAll()` ran — and is removed by the same
     * maintenance sweep. Generous on purpose: this is a backstop for requests
     * that skipped normal cleanup, not a cap on how long an upload may
     * legitimately take.
     */
    uploadTmpTtlMs: int(process.env.UPLOAD_TMP_TTL_MS, 6 * 60 * 60 * 1000),
    /**
     * Per-kind watchdog: a job whose 'running' status outlives this is
     * presumed hung (not merely slow — `background_fill`'s own wait-for-
     * dependency pattern never holds 'running' status while waiting, see
     * BackgroundNotReadyError). The pool kills and respawns the worker
     * holding it and counts a failed attempt — see WorkerPool's watchdog
     * sweep in src/jobs/pool.ts. `background_fill` gets the remote API's own
     * timeout plus a margin, since that call can legitimately run for most
     * of CLOUDINARY_TIMEOUT_MS.
     */
    maxRuntimeMs: {
      vision: int(process.env.JOB_MAX_RUNTIME_VISION_MS, 60_000),
      render: int(process.env.JOB_MAX_RUNTIME_RENDER_MS, 90_000),
      background_fill: int(
        process.env.JOB_MAX_RUNTIME_BACKGROUND_FILL_MS,
        int(process.env.CLOUDINARY_TIMEOUT_MS, 180_000) + 60_000
      ),
    } as Record<'vision' | 'render' | 'background_fill', number>,
  },

  aiExtendDispatcher: {
    /**
     * Circuit breaker for the whole shared Cloudinary account, independent of
     * any one tenant's own `max_ai_extend_per_month` quota — every tenant
     * could be individually within quota and the account still over budget
     * in aggregate. A warning logs at 80% of this; the dispatcher refuses
     * outright at 100%, surfaced as a parked (non-retryable) job failure,
     * same as an exhausted per-tenant quota.
     */
    globalMonthlyCap: int(process.env.AI_EXTEND_GLOBAL_MONTHLY_CAP, 20_000),
    /**
     * Max simultaneous Cloudinary calls across every background_fill worker
     * process — see ai_extend_global_state in control-schema.sql for why
     * this can't be a plain in-process semaphore. Defaults to the same
     * value as CLOUDINARY_JOB_CONCURRENCY (worker SLOT count), since that
     * already bounds concurrency structurally in the common case; set this
     * lower to leave headroom without reducing slot count, or higher if
     * slots sometimes idle waiting on something other than the API call.
     */
    globalConcurrency: int(
      process.env.AI_EXTEND_GLOBAL_CONCURRENCY,
      int(process.env.CLOUDINARY_JOB_CONCURRENCY, 4)
    ),
    /** Token-bucket: refilled at this rate, capped at this burst size. */
    rateLimitPerSecond: float(process.env.AI_EXTEND_RATE_LIMIT_PER_SECOND, 2),
    rateLimitBurst: int(process.env.AI_EXTEND_RATE_LIMIT_BURST, 4),
    /** Per-tenant concurrent Cloudinary calls — independent of the global cap above. */
    perTenantConcurrency: int(process.env.AI_EXTEND_PER_TENANT_CONCURRENCY, 2),
    /** Low on purpose — every retry can cost a paid generative credit. */
    maxAttempts: int(process.env.AI_EXTEND_MAX_ATTEMPTS, 3),
    baseBackoffMs: int(process.env.AI_EXTEND_BASE_BACKOFF_MS, 2_000),
    maxBackoffMs: int(process.env.AI_EXTEND_MAX_BACKOFF_MS, 30_000),
  },

  render: {
    outputMaxDim: int(process.env.RENDER_OUTPUT_MAX_DIM, 2048),
    supersample: int(process.env.RENDER_SUPERSAMPLE, 2),
    jpegQuality: int(process.env.RENDER_JPEG_QUALITY, 95),
    /**
     * Export-conversion (sharp decode/re-encode at download time) concurrency
     * caps — see src/render/export-concurrency.ts. Both the single-creative
     * export route and the bulk ZIP route's per-file loop share these same
     * two limiters, so a bulk export in progress genuinely throttles a
     * concurrent single-file one, and vice versa.
     */
    exportGlobalConcurrency: int(process.env.EXPORT_GLOBAL_CONCURRENCY, 4),
    exportPerTenantConcurrency: int(process.env.EXPORT_PER_TENANT_CONCURRENCY, 2),
    /** How long a request waits for a saturated export slot before giving up with a 429/503. */
    exportSlotWaitMs: int(process.env.EXPORT_SLOT_WAIT_MS, 2_000),
    /** How many files a single bulk ZIP converts at once, INSIDE whatever global/per-tenant slots it can get — small on purpose, see the download route's own doc comment. */
    zipInternalConcurrency: int(process.env.ZIP_INTERNAL_CONCURRENCY, 3),
  },

  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY ?? '',
    apiSecret: process.env.CLOUDINARY_API_SECRET ?? '',
    get enabled() {
      return Boolean(this.cloudName && this.apiKey && this.apiSecret)
    },
    /**
     * Separate from `jobs.renderConcurrency` on purpose. This work is a
     * remote HTTP call, not local CPU, so it must not be sized off cores or
     * take slots from the render pool. Kept low regardless: every call
     * spends paid generative credits and Cloudinary rate-limits bursts, so
     * the failure mode of setting it high is a bill and a 429, not just
     * contention.
     */
    jobConcurrency: Math.max(1, int(process.env.CLOUDINARY_JOB_CONCURRENCY, 4)),
    /**
     * Generative fill is a real diffusion job on Cloudinary's side, not a
     * plain transformation — first request for a given derivation regularly
     * takes 30-60s while it renders. This bounds a stuck request, not a slow
     * one, so it sits well above the typical case.
     */
    requestTimeoutMs: int(process.env.CLOUDINARY_TIMEOUT_MS, 180_000),
    /**
     * Longest edge the generated background may be produced at.
     *
     * Must be >= canvas longest edge x `render.supersample`, because the
     * background is requested at the render surface's resolution rather than
     * the canvas's — see `buildAiExtendTarget`. For the largest preset here
     * (1920) at 2x that is 3840, so the default clears it.
     *
     * NOT a bandwidth knob. The renderer composites the original photo back
     * over this background at the framing solver's exact rectangle; a
     * background produced any smaller is both softer than the photo drawn
     * over it and offset by rounding, which shows up as a visible rectangle
     * around the subject. Below the required size the service warns rather
     * than producing that silently.
     */
    maxUploadDim: int(process.env.CLOUDINARY_MAX_UPLOAD_DIM, 4096),
  },

  observability: {
    /** How often the event-loop delay monitor logs and resets its window — see src/lib/event-loop-monitor.ts. */
    eventLoopLogIntervalMs: int(process.env.EVENT_LOOP_LOG_INTERVAL_MS, 60_000),
  },

  auth: {
    /**
     * No open signup by default — an admin creates every account. Set to
     * `true` only for a deployment that genuinely wants self-service
     * registration; the login/account UI checks this before offering a
     * signup path at all, not just before accepting one.
     */
    allowSignup: (process.env.ALLOW_SIGNUP ?? 'false').toLowerCase() === 'true',
    /** Bootstraps the first platform_admin + tenant — see `scripts/tenants-migrate-legacy.ts`. */
    adminEmail: process.env.ADMIN_EMAIL ?? '',
    adminPassword: process.env.ADMIN_PASSWORD ?? '',
    sessionCookieName: 'vs_session',
    /**
     * `Secure` defaults to whether this process thinks it's in production
     * (`NODE_ENV`), not hardcoded true — a hardcoded default broke `npm run
     * dev` over `http://localhost` for anyone whose browser actually
     * enforces the flag (curl doesn't, which is why this looked fine in
     * earlier testing). Override explicitly with `COOKIE_SECURE` either
     * direction: `=false` to deliberately run a production deployment
     * without TLS yet (the session token then travels in cleartext — the
     * real fix is terminating TLS at the reverse proxy, see docs/DEPLOY.md,
     * not this flag), or `=true` to test the production cookie behaviour
     * from a dev build.
     */
    cookieSecure:
      process.env.COOKIE_SECURE != null
        ? process.env.COOKIE_SECURE.toLowerCase() === 'true'
        : process.env.NODE_ENV === 'production',
    /** Sliding expiry: refreshed on use, up to this long since last use. */
    sessionTtlMs: int(process.env.SESSION_TTL_MS, 30 * 24 * 60 * 60 * 1000),
    /** Failed attempts allowed in the window below before backing off. */
    loginMaxAttempts: int(process.env.LOGIN_MAX_ATTEMPTS, 10),
    loginWindowMs: int(process.env.LOGIN_WINDOW_MS, 15 * 60 * 1000),
    /**
     * Off by default — a client-supplied `X-Forwarded-For` is otherwise a
     * free way to pick your own rate-limit bucket (or someone else's).
     * Turn on only behind a reverse proxy you control that OVERWRITES this
     * header rather than appending to whatever the client sent (Caddy's
     * default `reverse_proxy` behaviour does this correctly). With it off,
     * every request is rate-limited as one shared "unknown" IP bucket —
     * safe (if coarse) rather than trusting a header that might be forged.
     */
    trustProxy: (process.env.TRUST_PROXY ?? 'false').toLowerCase() === 'true',
    /**
     * The app's own public origin (e.g. `https://vision.example.com`),
     * used by the mutating-request Origin check instead of
     * `request.nextUrl.host`. Required in production: behind a reverse
     * proxy, Next.js's own view of its host is the internal
     * address/port it's bound to (`127.0.0.1:3000`), not the public
     * domain the browser's `Origin` header actually names, so comparing
     * against `nextUrl.host` there rejects every legitimate same-origin
     * request. Left unset in development, where `nextUrl.host` (just
     * `localhost:3000`, no proxy in front) is already correct.
     */
    appOrigin: process.env.APP_ORIGIN || '',
    /**
     * Gates creating a second (or third, ...) tenant. As of P3 this is no
     * longer an architectural necessity — the worker pool binds tenant
     * context per job and the scheduler fair-shares across tenants (see
     * src/jobs/queue.ts's claim() and docs/MULTI_TENANCY.md §5) — it is a
     * deliberate opt-in kept in place until multi-tenant operation is turned
     * on on purpose, not as a side effect of running the legacy-migration
     * script a second time.
     */
    allowMultiTenantPreview: (process.env.ALLOW_MULTI_TENANT_PREVIEW ?? '') === '1',
  },
} as const

export type AppConfig = typeof config
