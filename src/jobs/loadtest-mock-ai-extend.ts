/**
 * A `GenerativeFillProvider` for `scripts/loadtest-multitenant.ts`'s real
 * mode — simulates Cloudinary's generative-fill API with realistic latency
 * and occasional 429s, WITHOUT ever making a network call or spending a real
 * credit. Real Cloudinary credentials are never read or required when this
 * is active.
 *
 * Activated only when `VISION_STUDIO_LOADTEST_MOCK_AI_EXTEND=1` is set — see
 * `src/jobs/worker.ts`'s `handleBackgroundFillJob`, the one call site that
 * checks this env var. Never set in production; this module is only ever
 * imported from that one conditional branch or directly by the load-test
 * script itself.
 */

import sharp from 'sharp'
import type { GenerativeFillProvider, GenerativeFillRequest, GenerativeFillResult } from '@/services/cloudinary-service'
import { CloudinaryServiceError } from '@/services/cloudinary-service'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Roughly matches real Cloudinary generative-fill latency: most calls 2-6s, a long tail out to ~15s. */
function sampleLatencyMs(): number {
  const base = 2000 + Math.random() * 4000
  const longTail = Math.random() < 0.1 ? Math.random() * 9000 : 0
  return base + longTail
}

export function createMockAiExtendProvider(options?: { rateLimitProbability?: number }): GenerativeFillProvider {
  const rateLimitProbability = options?.rateLimitProbability ?? 0.08

  return {
    async generativeFill(request: GenerativeFillRequest): Promise<GenerativeFillResult> {
      await sleep(sampleLatencyMs())

      if (Math.random() < rateLimitProbability) {
        throw new CloudinaryServiceError('(loadtest mock) rate limited', 'rate_limited', 1500)
      }

      // A real-looking canvas-sized JPEG — a flat colour is enough; nothing
      // downstream inspects pixel content, only dimensions and that it's a
      // decodable image (see `looksLikeCompleteJpeg`).
      const bytes = await sharp({
        create: {
          width: request.canvasWidth,
          height: request.canvasHeight,
          channels: 3,
          background: { r: 180, g: 180, b: 180 },
        },
      })
        .jpeg({ quality: 90 })
        .toBuffer()

      return { bytes, width: request.canvasWidth, height: request.canvasHeight }
    },
  }
}
