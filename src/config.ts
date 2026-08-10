/**
 * Central configuration — the single place environment variables are read.
 *
 * Every value has a working default so the application runs with no .env file.
 * Nearly nothing here reaches out to a network service — Vision Studio is
 * standalone by design (no OAuth, no hosted database, no media CDN) — with one
 * deliberate exception: the "AI Extend" background mode calls a self-hosted
 * SDXL inpainting service (`services/inpaint-service`, a separate deployable,
 * GPU-hosted in production) to outpaint a photo's background, because that is
 * a genuinely hard image problem this app has no local model for. It is
 * entirely opt-in per template and never falls back to a plain fill silently —
 * see `INPAINT_JOB_FAILED` handling in `src/jobs/worker.ts`.
 *
 * Server-only. Do not import from a client component — it touches `path` and
 * `process.env` values that are not `NEXT_PUBLIC_`-prefixed.
 */

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
  return { vision: 1, render: 1, ortThreads: 1 }
}

const defaults = defaultConcurrency()

export const config = {
  paths: {
    dataDir,
    /** SQLite database file. */
    database: path.join(dataDir, 'vision-studio.db'),
    /** Immutable, content-addressed source images. Never modified after write. */
    originals: path.join(dataDir, 'media', 'originals'),
    /** Vision-engine outputs keyed by source hash: masks, cutouts, previews. */
    derived: path.join(dataDir, 'media', 'derived'),
    /** Rendered creatives, grouped by generation batch. */
    creatives: path.join(dataDir, 'media', 'creatives'),
    /** Template thumbnails and user-uploaded template assets (logos, overlays). */
    assets: path.join(dataDir, 'media', 'assets'),
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
     */
    staleClaimMs: int(process.env.JOB_STALE_CLAIM_MS, 5 * 60 * 1000),
  },

  render: {
    outputMaxDim: int(process.env.RENDER_OUTPUT_MAX_DIM, 2048),
    supersample: int(process.env.RENDER_SUPERSAMPLE, 2),
    jpegQuality: int(process.env.RENDER_JPEG_QUALITY, 95),
  },

  inpaint: {
    /** The self-hosted inpaint-service's own base URL — never a public endpoint. */
    serviceUrl: process.env.INPAINT_SERVICE_URL || 'http://localhost:8001',
    /**
     * Mirrors the SAME env var the Python service reads (`INPAINT_DEVICE`) —
     * set identically on both when running the CPU test setup described in
     * docs/DEPLOY.md, so this side's own throttling stays in sync with what
     * the service can actually deliver, without the two needing to ask each
     * other over the wire.
     */
    device: process.env.INPAINT_DEVICE === 'cpu' ? ('cpu' as const) : ('cuda' as const),
    /**
     * A hard cap, not a default: CPU inference runs on the SAME machine as the
     * vision/render workers in the dev/test setup this mode implies, and a
     * config value that could push it past 1 would defeat the entire point of
     * giving this its own concurrency knob in the first place.
     */
    jobConcurrency:
      process.env.INPAINT_DEVICE === 'cpu'
        ? 1
        : Math.max(1, int(process.env.INPAINT_JOB_CONCURRENCY, 2)),
    /**
     * How long to wait for one generation before giving up on it.
     *
     * The GPU default is 180s, not the 60s it started as. 60s was sized for
     * a fast datacentre card and turned every request on a modest GPU into a
     * timeout — a Quadro P2000 takes ~75s for a single 768px SD inpaint, so
     * the client was killing healthy requests the service went on to
     * complete successfully, wasting the work and failing the batch. This
     * needs to bound a HUNG service, not a slow one; a real hang is
     * indistinguishable from slowness until the budget is comfortably past
     * what any working GPU would take.
     */
    requestTimeoutMs: int(
      process.env.INPAINT_TIMEOUT_MS,
      process.env.INPAINT_DEVICE === 'cpu' ? 900_000 : 180_000
    ),
  },
} as const

export type AppConfig = typeof config
