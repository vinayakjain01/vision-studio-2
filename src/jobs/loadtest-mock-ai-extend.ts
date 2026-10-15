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

/**
 * Centred on `centerMs` (±40% jitter) with a long tail out to 2x `centerMs`
 * on ~10% of calls. `centerMs` defaults to 12s — Phase 1.3's own reported
 * real-world Cloudinary generative-fill latency (see docs/ISSUES.md issue 4)
 * — and is configurable via `VISION_STUDIO_LOADTEST_AI_EXTEND_LATENCY_MS` so
 * `scripts/reproduce-issue4-slow-batch.ts` can sweep it without touching code.
 */
function sampleLatencyMs(centerMs: number): number {
  const base = centerMs * (0.6 + Math.random() * 0.8)
  const longTail = Math.random() < 0.1 ? Math.random() * centerMs : 0
  return base + longTail
}

export function createMockAiExtendProvider(options?: { rateLimitProbability?: number; latencyMs?: number }): GenerativeFillProvider {
  const rateLimitProbability =
    options?.rateLimitProbability ?? Number(process.env.VISION_STUDIO_LOADTEST_AI_EXTEND_RATE_LIMIT_PROB ?? '0.08')
  const latencyMs = options?.latencyMs ?? Number(process.env.VISION_STUDIO_LOADTEST_AI_EXTEND_LATENCY_MS ?? '12000')

  return {
    async generativeFill(request: GenerativeFillRequest): Promise<GenerativeFillResult> {
      await sleep(sampleLatencyMs(latencyMs))

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
