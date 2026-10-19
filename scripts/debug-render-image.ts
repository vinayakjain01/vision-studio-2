/**
 * One-off diagnostic: run an arbitrary image file through the REAL vision
 * engine AND the REAL framing solver + compositor (full_body_editorial
 * preset, solid background — no AI Extend/Cloudinary call) and save the
 * result to disk for visual inspection. No tenant context, DB, or storage
 * touched — same bypass approach as debug-analyze-image.ts.
 *
 *   npx tsx scripts/debug-render-image.ts <path-to-image> <output-path> [--aspect=4:5]
 *
 * Built to reproduce issues 1/2/3/11 (framing bugs) against whatever real
 * photos are available, however imperfect (e.g. a screenshot crop) —
 * printing the vision metadata's shot-type/anchors AND the framing result's
 * strategy/violations alongside the saved image, so a visual check and the
 * underlying data can be read together.
 */

import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { VisionEngine, OnnxVisionProvider } from '@/vision'
import { config } from '@/config'
import { renderCreative } from '@/render/compositor'
import { createDefaultTemplate, type AspectRatioId } from '@/templates/types'

async function main() {
  const [imagePath, outputPath, ...rest] = process.argv.slice(2)
  if (!imagePath || !outputPath) {
    console.error('Usage: npx tsx scripts/debug-render-image.ts <path-to-image> <output-path> [--aspect=4:5]')
    process.exit(1)
  }
  const aspectArg = rest.find(a => a.startsWith('--aspect='))
  const aspect = (aspectArg ? aspectArg.slice('--aspect='.length) : '4:5') as AspectRatioId

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
    logger: { debug: () => {}, warn: console.warn, error: console.error },
  })

  console.log(`[debug-render] ${path.basename(imagePath)} (${bytes.length} bytes) — analyzing...`)
  await engine.initialize()
  const metadata = await engine.analyze(bytes, { sourceHash, force: true })

  console.log(
    `[debug-render] shot=${metadata.shot.type} (confidence=${metadata.shot.confidence}) hasFace=${metadata.shot.signals.hasFace} headVisible=${metadata.shot.signals.headVisible} kneesVisible=${metadata.shot.signals.kneesVisible} anklesVisible=${metadata.shot.signals.anklesVisible}`
  )
  const anchorSummary = Object.entries(metadata.anchors ?? {})
    .map(([name, a]: [string, any]) => `${name}=(${Math.round(a.x)},${Math.round(a.y)} src=${a.source} conf=${a.confidence?.toFixed(2)})`)
    .join('  ')
  console.log(`[debug-render] anchors: ${anchorSummary}`)

  const template = createDefaultTemplate(aspect)
  // Solid background, not AI Extend — this harness isolates FRAMING
  // correctness (issues 1/2/3/11's actual complaint), not the generative
  // fill step, and never spends a real Cloudinary credit.
  template.background = { ...template.background, mode: 'solid', color: '#e5e5e5' }

  const result = await renderCreative({
    source: bytes,
    vision: metadata,
    template,
    variables: {
      product_name: 'debug',
      category: '',
      folder: '',
      file_name: path.basename(imagePath),
      shot_type: metadata.shot.type,
      garment_type: metadata.garment?.type ?? 'unknown',
      index: '1',
    },
  })

  console.log(
    `[debug-render] framing: strategy=${result.framing.strategyId} usedFallback=${result.framing.usedFallback} violations=${JSON.stringify(result.framing.violations)} overflow=${JSON.stringify(result.framing.overflow)}`
  )
  console.log(`[debug-render] output: ${result.width}x${result.height} ${result.mimeType} in ${result.durationMs}ms`)

  await fs.writeFile(outputPath, result.buffer)
  console.log(`[debug-render] saved to ${outputPath}`)
}

main().catch(err => {
  console.error('[debug-render] fatal:', err)
  process.exit(1)
})
