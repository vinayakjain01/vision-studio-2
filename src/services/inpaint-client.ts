/**
 * Client for the self-hosted SDXL inpainting service (`services/inpaint-service`).
 *
 * The one network dependency in this app, and deliberately a plain HTTP call
 * to a service THIS deployment owns — not a third-party API. No credentials,
 * because there is nothing to authenticate to: the service is meant to sit on
 * an internal network with no public exposure (see docs/DEPLOY.md), the same
 * posture as this app's own "no authentication" stance.
 *
 * No silent fallback on failure. A Cloudinary-backed predecessor of this
 * feature degraded to a plain fill when the call failed; this one does not,
 * on purpose — see `InpaintServiceError` and how `src/jobs/worker.ts` uses it.
 * A background that quietly reverted to white space on a transient network
 * blip would be a defect nobody hears about until they notice the output.
 * Surfacing it as a distinct, retryable job failure means it shows up in the
 * batch's own failure list instead.
 *
 * Server-only.
 */

import { config } from '@/config'

export class InpaintServiceError extends Error {
  constructor(
    message: string,
    /**
     * Distinguishes "the service said no" from "the service never answered"
     * from "the service is fine, just already working" — the last one is not
     * a failure at all and must not consume a retry attempt. See how
     * `src/jobs/worker-entry.ts` treats `busy`.
     */
    readonly kind: 'unreachable' | 'timeout' | 'rejected' | 'busy' = 'rejected'
  ) {
    super(message)
    this.name = 'InpaintServiceError'
  }
}

export interface InpaintRequest {
  /** Canvas-sized JPEG bytes: the photo placed per the template's framing, blank elsewhere. */
  image: Buffer
  /** Canvas-sized, feathered grayscale PNG mask: white = generate, black = protect. */
  mask: Buffer
  /** Overrides the service's own baked-in default when set. */
  prompt?: string
}

export interface InpaintResponse {
  /** Canvas-sized JPEG bytes — the input with only the masked region regenerated. */
  image: Buffer
}

export interface HealthStatus {
  reachable: boolean
  device?: 'cpu' | 'cuda'
  modelLoaded?: boolean
}

/**
 * `GET /health` — used before committing a batch of `background_fill` jobs
 * to a service that turns out not to be up, rather than letting every one of
 * them individually time out to discover that.
 */
export async function checkHealth(): Promise<HealthStatus> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5_000)
    let response: Response
    try {
      response = await fetch(`${config.inpaint.serviceUrl}/health`, { signal: controller.signal })
    } finally {
      clearTimeout(timeout)
    }
    if (!response.ok) return { reachable: false }
    const body = (await response.json()) as { device?: 'cpu' | 'cuda'; model_loaded?: boolean }
    return { reachable: true, device: body.device, modelLoaded: body.model_loaded }
  } catch {
    return { reachable: false }
  }
}

/**
 * `POST /inpaint`. Timeout is sized in `src/config.ts` from
 * `INPAINT_TIMEOUT_MS` — seconds, not milliseconds, because real generation
 * time is seconds on a GPU and can be minutes in CPU test mode, and a
 * timeout borrowed from a typical API call (a few seconds) would abort a
 * healthy request before it ever had a chance to finish.
 */
export async function inpaint(request: InpaintRequest): Promise<InpaintResponse> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.inpaint.requestTimeoutMs)

  let response: Response
  try {
    response = await fetch(`${config.inpaint.serviceUrl}/inpaint`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        image: request.image.toString('base64'),
        mask: request.mask.toString('base64'),
        ...(request.prompt ? { prompt: request.prompt } : {}),
      }),
    })
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    throw new InpaintServiceError(
      aborted
        ? `inpaint service did not respond within ${config.inpaint.requestTimeoutMs}ms ` +
          `(device=${config.inpaint.device}). The request may still have SUCCEEDED on the ` +
          `service side — check its log before assuming it is down. A modest GPU can take ` +
          `well over a minute per image; raise INPAINT_TIMEOUT_MS if this is simply slow ` +
          `rather than stuck.`
        : `inpaint service unreachable at ${config.inpaint.serviceUrl}: ${(err as Error).message}`,
      aborted ? 'timeout' : 'unreachable'
    )
  } finally {
    clearTimeout(timeout)
  }

  if (response.status === 503) {
    // Single-GPU service, already generating for someone else. Not an error
    // condition — the caller should step aside and retry, not burn an
    // attempt or wait in a queue that makes the backlog worse.
    throw new InpaintServiceError(
      'inpaint service is busy with another generation',
      'busy'
    )
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new InpaintServiceError(
      `inpaint service returned ${response.status}: ${body.slice(0, 500)}`,
      'rejected'
    )
  }

  const body = (await response.json()) as { image?: string; error?: string }
  if (!body.image) {
    throw new InpaintServiceError(
      `inpaint service returned no image: ${body.error ?? 'unknown reason'}`,
      'rejected'
    )
  }

  return { image: Buffer.from(body.image, 'base64') }
}
