/**
 * One-off diagnostic: run an arbitrary image file through the REAL vision
 * engine (real ONNX models) and print the full metadata — shot type,
 * anchors (with confidence/source), person/face detection — without any
 * tenant context, DB, or storage. Bypasses `getVisionEngine()`'s DB-backed
 * cache/maskSink entirely (both are optional on VisionEngine) so this never
 * touches a tenant's app.db or the media store.
 *
 *   npx tsx scripts/debug-analyze-image.ts <path-to-image>
 *
 * Built to sanity-check whether a LOW-RESOLUTION source (e.g. a screenshot
 * crop, not an original upload) still produces meaningful detection output
 * before trusting any conclusion drawn from it — see docs/ISSUES.md issue
 * 11's caveat about needing a real fixture, not a thumbnail.
 */

import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { VisionEngine, OnnxVisionProvider } from '@/vision'
import { config } from '@/config'

async function main() {
  const imagePath = process.argv[2]
  if (!imagePath) {
    console.error('Usage: npx tsx scripts/debug-analyze-image.ts <path-to-image>')
    process.exit(1)
  }

  const bytes = await fs.readFile(imagePath)
  const sourceHash = crypto.createHash('sha256').update(bytes).digest('hex')

  const provider = new OnnxVisionProvider({ modelDir: config.paths.modelDir, threads: config.vision.ortThreads })
  const engine = new VisionEngine({
    provider,
    analysisMaxDim: config.vision.analysisMaxDim,
    thresholds: {
      personScore: config.vision.personScoreThreshold,
      personNmsIou: config.vision.personNmsIou,
      faceScore: config.vision.faceScoreThreshold,
      faceNmsIou: config.vision.faceNmsIou,
      keypointScore: config.vision.keypointScoreThreshold,
      maskBinary: config.vision.maskBinaryThreshold,
    },
    // No cache, no maskSink — read-only, no DB/storage touched.
    logger: {
      debug: () => {},
      warn: (message, meta) => console.warn(`[vision] ${message}`, meta ?? ''),
      error: (message, meta) => console.error(`[vision] ${message}`, meta ?? ''),
    },
  })

  console.log(`[debug-analyze] ${path.basename(imagePath)} (${bytes.length} bytes, hash ${sourceHash.slice(0, 12)})`)
  await engine.initialize()
  const metadata = await engine.analyze(bytes, { sourceHash, force: true })

  console.log(JSON.stringify(metadata, null, 2))
}

main().catch(err => {
  console.error('[debug-analyze] fatal:', err)
  process.exit(1)
})
