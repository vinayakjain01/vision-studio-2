/**
 * Cloudinary generative background fill, for the "AI Extend" background mode.
 *
 * The one outbound network dependency in this app, and the one that costs
 * money: every generative-fill derivation spends paid credits. That single
 * fact drives most of the design here and the caching in
 * `src/jobs/worker.ts` — an identical re-render must never buy the same
 * image twice.
 *
 * ── How the fill is actually requested ───────────────────────────────────────
 * Confirmed against Cloudinary's current transformation reference rather than
 * assumed, because the parameter has been renamed across versions:
 *
 *     b_gen_fill[:prompt_<prompt>][;seed_<seed>]
 *
 * It is a QUALIFIER on a padding crop, not a standalone effect — it must be
 * paired with `c_pad` (or `c_lpad`/`c_mpad`/`c_auto_pad`/`c_fill_pad`), and it
 * fills the area that crop ADDS. That has a consequence worth stating plainly,
 * because it is the opposite of what the feature description suggests:
 *
 *   The image uploaded here must be the photo ALONE — never the padded canvas
 *   with blank space already in it.
 *
 * Cloudinary generates into padding IT adds. Handed a canvas whose empty
 * region is already white pixels, it has no idea those pixels are "empty" and
 * fills nothing. So this uploads the bare photo and asks for `c_pad` out to
 * the canvas size, positioning the photo inside that pad with the same offsets
 * the local compositor uses.
 *
 * ── The subject is never modified ────────────────────────────────────────────
 * Cloudinary returns the whole canvas, including a re-encoded copy of the
 * photo. That copy is NOT used as the subject: the renderer draws the
 * original photo back over this result at full resolution (`drawSubject` in
 * `src/render/compositor.ts`), so what ships is original pixels on top of a
 * generated backdrop. This module's output is a background layer, nothing
 * more.
 *
 * Server-only.
 */

import { v2 as cloudinary } from 'cloudinary'
import sharp from 'sharp'
import { config } from '@/config'

export class CloudinaryServiceError extends Error {
  constructor(
    message: string,
    /**
     * Distinguishes failures that need different handling: `rate_limited`
     * and `busy` are worth retrying shortly, `credits` and `auth` are not
     * (they need a human), and retrying them just burns attempts against a
     * condition no retry can change.
     */
    readonly kind: 'auth' | 'credits' | 'rate_limited' | 'timeout' | 'unreachable' | 'rejected' =
      'rejected'
  ) {
    super(message)
    this.name = 'CloudinaryServiceError'
  }
}

let configured = false
function client() {
  if (!configured) {
    cloudinary.config({
      cloud_name: config.cloudinary.cloudName,
      api_key: config.cloudinary.apiKey,
      api_secret: config.cloudinary.apiSecret,
      secure: true,
    })
    configured = true
  }
  return cloudinary
}

/**
 * Cloudinary's transformation URL syntax uses commas and colons as its own
 * delimiters, and it decodes a percent-escaped one back to the literal
 * character BEFORE it finishes parsing the transformation string — verified
 * directly against the API: an escaped comma inside a prompt still splits it
 * and fails with "Invalid transformation component". There is no working
 * escape, so punctuation meaningful to the parser is stripped rather than
 * encoded. Hyphens and apostrophes survive; neither breaks a request.
 */
function sanitizePrompt(text: string): string {
  return text
    .replace(/[,;:/|.()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Used when a template leaves its prompt empty. Deliberately generic — it
 * names only properties every backdrop has. A prompt written for one
 * backdrop and applied to a photo shot against another does not fail
 * quietly; it invents scenery and equipment that were never there.
 */
const DEFAULT_PROMPT =
  "Seamlessly continue this photograph's existing backdrop floor lighting and shadow beyond its current edges matching colour texture and perspective exactly with no visible seam"

export interface GenerativeFillRequest {
  /** The source photo's own bytes — NOT a padded canvas. See the module doc. */
  photo: Buffer
  /** Canvas to pad out to, in canvas pixels. */
  canvasWidth: number
  canvasHeight: number
  /**
   * Where the photo sits inside that canvas, canvas pixels from the top-left
   * — the same placement the local compositor computes, so the generated
   * padding lines up with where the subject will actually be drawn.
   */
  offsetX: number
  offsetY: number
  /** The photo's size once placed, canvas pixels. */
  placedWidth: number
  placedHeight: number
  /** Optional guidance; the default above is used when empty. */
  prompt?: string
}

export interface GenerativeFillResult {
  /** Canvas-sized JPEG: the photo plus a generatively filled surround. */
  bytes: Buffer
  width: number
  height: number
}

/**
 * Ask Cloudinary to extend a photo's background out to a full canvas.
 *
 * Throws `CloudinaryServiceError` on every failure path — never returns a
 * silently degraded result, because a background that quietly reverted to
 * flat white is a defect nobody notices until they look at the output.
 */
export async function generativeFill(
  request: GenerativeFillRequest
): Promise<GenerativeFillResult> {
  if (!config.cloudinary.enabled) {
    throw new CloudinaryServiceError(
      'Cloudinary is not configured — set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and ' +
        'CLOUDINARY_API_SECRET (see .env.example)',
      'auth'
    )
  }

  const prompt = sanitizePrompt(request.prompt?.trim() || DEFAULT_PROMPT)

  // Requested at the canvas's OWN size whenever the cap allows it, and the cap
  // is set high enough that it normally does.
  //
  // Downscaling here looks like a harmless bandwidth saving and is not. The
  // renderer draws the original photo back on top of this background at the
  // exact rectangle the framing solver computed. If the background was built
  // at a different scale, two things go wrong at once: its copy of the photo
  // is upscaled and soft while the one drawn over it is sharp, and rounding
  // the offsets at the smaller scale shifts its copy by a pixel or two. The
  // result is a visible rectangle around the subject that reads as the photo
  // having been pasted over its own background — which is exactly what it is.
  //
  // At scale 1 the geometry is integer-exact and the background's photo
  // region lands precisely under the one drawn on top, so the only visible
  // boundary is the one Cloudinary already blended.
  const scale = Math.min(
    1,
    config.cloudinary.maxUploadDim / Math.max(request.canvasWidth, request.canvasHeight)
  )
  const exact = scale === 1
  const canvasW = Math.max(8, Math.round(request.canvasWidth * scale))
  const canvasH = Math.max(8, Math.round(request.canvasHeight * scale))
  const placedW = Math.max(1, Math.round(request.placedWidth * scale))
  const placedH = Math.max(1, Math.round(request.placedHeight * scale))
  const offsetX = Math.max(0, Math.round(request.offsetX * scale))
  const offsetY = Math.max(0, Math.round(request.offsetY * scale))
  if (!exact) {
    console.warn(
      `[cloudinary] canvas ${request.canvasWidth}x${request.canvasHeight} exceeds ` +
        `CLOUDINARY_MAX_UPLOAD_DIM=${config.cloudinary.maxUploadDim}; generating the background ` +
        `at ${canvasW}x${canvasH} instead. Expect a faint edge where the subject is composited ` +
        `back over it — raise the cap to match the canvas to remove it.`
    )
  }

  // Resized locally to exactly the size it will occupy inside the pad, so
  // Cloudinary only has to pad — no scaling on their side to reason about.
  const upload = await sharp(request.photo)
    .resize({ width: placedW, height: placedH, fit: 'fill' })
    .jpeg({ quality: 90 })
    .toBuffer()

  let publicId: string
  try {
    const uploaded = await client().uploader.upload(
      `data:image/jpeg;base64,${upload.toString('base64')}`,
      {
        folder: 'vision-studio/ai-extend',
        unique_filename: true,
        overwrite: false,
        resource_type: 'image',
      }
    )
    publicId = uploaded.public_id
  } catch (err) {
    throw classify(err, 'upload')
  }

  const url = client().url(publicId, {
    secure: true,
    format: 'jpg',
    // Explicit, high, and not `auto`. This result is not a backdrop the real
    // photo gets painted over — it IS the delivered image, subject included
    // (see the note in `renderCreative`). Cloudinary's default automatic
    // quality optimises for web bytes, which is the wrong trade for a
    // catalogue master that gets composited and re-encoded downstream.
    quality: 90,
    transformation: [
      {
        // `lpad`, NOT `pad` — this distinction is the whole feature working or
        // not, and it is easy to get wrong because both "pad".
        //
        // `c_pad` RESIZES the image to fit the target box before padding. The
        // photo here is deliberately pre-sized to the exact box it will occupy
        // on the canvas (2316x3312 inside 2400x3600, say), so `c_pad` scaled it
        // UP to 2400x3432 and shifted it. The background's copy of the photo
        // then sat at a different scale and position than the one the renderer
        // draws over it, producing a hard rectangle around the subject that
        // looked exactly like the photo had been pasted onto its own
        // background. Measured 29/255 mean error against the original before
        // this changed.
        //
        // `c_lpad` ("limit pad") only scales DOWN, and only if the image is
        // larger than the target. Ours never is — it is a sub-region of the
        // canvas — so it pads and nothing else, which is all that was ever
        // wanted. Still a documented `b_gen_fill` crop mode.
        crop: 'lpad',
        gravity: 'north_west',
        x: offsetX,
        y: offsetY,
        width: canvasW,
        height: canvasH,
        // Encoded explicitly: the SDK percent-encodes spaces but not every
        // character, and `sanitizePrompt` has already removed the ones that
        // would break parsing regardless.
        background: `gen_fill:prompt_${encodeURIComponent(prompt)}`,
      },
    ],
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.cloudinary.requestTimeoutMs)
  let response: Response
  try {
    response = await fetch(url, { signal: controller.signal })
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    throw new CloudinaryServiceError(
      aborted
        ? `Cloudinary did not return a generated image within ${config.cloudinary.requestTimeoutMs}ms. ` +
          `Generative fill renders on their side and can be slow on first request; the derivation ` +
          `may still complete and be served from their cache on retry.`
        : `Could not reach Cloudinary: ${(err as Error).message}`,
      aborted ? 'timeout' : 'unreachable'
    )
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    // Cloudinary reports the real reason in this header rather than the body
    // for transformation errors, and the body is usually a placeholder GIF.
    const detail = response.headers.get('x-cld-error') ?? (await response.text().catch(() => ''))
    throw classifyHttp(response.status, detail)
  }

  const bytes = Buffer.from(await response.arrayBuffer())
  await assertUsableImage(bytes, response, canvasW, canvasH)
  return { bytes, width: canvasW, height: canvasH }
}

/**
 * Refuse to return a background that is not a complete, correctly-sized image.
 *
 * Everything downstream trusts these bytes: they are cached as a derived
 * asset, composited, and shipped as the finished creative, and the render job
 * that uses them reports success. So an image that is merely *decodable* is
 * not good enough — a truncated JPEG decodes perfectly happily, filling
 * whatever never arrived with a flat grey or black block and a hard
 * horizontal edge, which is indistinguishable from a bad generation to
 * everything downstream and gets cached permanently under a key that will
 * never be recomputed.
 *
 * The checks are all STRUCTURAL — byte counts, markers, dimensions — chosen
 * because they cannot produce a false rejection. A content-based check
 * ("reject if the fill came back too dark") is deliberately NOT here: this
 * catalogue's own backdrop is a painted mural whose lower bands measure
 * luminance 11/255 at a standard deviation of 1.2, i.e. genuinely near-black
 * and genuinely almost flat. Any threshold strict enough to catch a failure
 * block would throw away correct output on those photos.
 */
async function assertUsableImage(
  bytes: Buffer,
  response: Response,
  expectedWidth: number,
  expectedHeight: number
): Promise<void> {
  const fail = (why: string) =>
    new CloudinaryServiceError(`Cloudinary returned an unusable image — ${why}`, 'rejected')

  if (bytes.length === 0) throw fail('the response body was empty')

  // A short read is the single most likely way to get a flat block: the
  // connection drops mid-download and the partial file still decodes.
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > 0 && bytes.length !== declared) {
    throw fail(`a truncated download (${bytes.length} of ${declared} bytes)`)
  }

  // JPEG start- and end-of-image markers. The EOI is what a truncated
  // transfer loses, and checking it costs two byte comparisons.
  const hasSoi = bytes[0] === 0xff && bytes[1] === 0xd8
  const hasEoi = bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
  if (!hasSoi) throw fail('a response that is not a JPEG at all')
  if (!hasEoi) throw fail('an incomplete JPEG (no end-of-image marker)')

  let meta: { width?: number; height?: number }
  try {
    meta = await sharp(bytes).metadata()
  } catch (err) {
    throw fail(`an undecodable image (${(err as Error).message})`)
  }

  // Cloudinary serves a small placeholder on some transformation errors even
  // with a 200, and a wrong size would silently letterbox or stretch.
  if (meta.width !== expectedWidth || meta.height !== expectedHeight) {
    throw fail(
      `${meta.width}x${meta.height} when ${expectedWidth}x${expectedHeight} was requested`
    )
  }
}

function classifyHttp(status: number, detail: string): CloudinaryServiceError {
  const text = detail.slice(0, 400)
  if (status === 401 || status === 403) {
    return new CloudinaryServiceError(
      `Cloudinary rejected the credentials (${status}): ${text}. Check CLOUDINARY_API_KEY / ` +
        `CLOUDINARY_API_SECRET / CLOUDINARY_CLOUD_NAME.`,
      'auth'
    )
  }
  if (status === 420 || status === 429) {
    return new CloudinaryServiceError(
      `Cloudinary rate-limited this request (${status}): ${text}`,
      'rate_limited'
    )
  }
  if (/credit|quota|limit reached|usage/i.test(text)) {
    return new CloudinaryServiceError(
      `Cloudinary reports the account is out of generative credits or over quota: ${text}`,
      'credits'
    )
  }
  return new CloudinaryServiceError(`Cloudinary returned ${status}: ${text}`, 'rejected')
}

function classify(err: unknown, phase: string): CloudinaryServiceError {
  const anyErr = err as { http_code?: number; message?: string; error?: { message?: string } }
  const status = anyErr?.http_code ?? 0
  const message = anyErr?.error?.message ?? anyErr?.message ?? String(err)
  if (status) return classifyHttp(status, `${phase}: ${message}`)
  return new CloudinaryServiceError(`Cloudinary ${phase} failed: ${message}`, 'unreachable')
}

/** Whether credentials are present — used by the builder to warn up front. */
export function isConfigured(): boolean {
  return config.cloudinary.enabled
}

/**
 * Cheap integrity check for a background read back OUT of the derived cache.
 *
 * `generativeFill` validates before writing, but entries cached before that
 * existed — or truncated by a disk-full or an interrupted write — are still
 * on disk, and a truncated JPEG decodes into a flat block rather than an
 * error. Checking on read lets a bad entry be discarded and regenerated
 * instead of being composited into a finished creative forever.
 */
export function looksLikeCompleteJpeg(bytes: Buffer): boolean {
  return (
    bytes.length > 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9
  )
}
