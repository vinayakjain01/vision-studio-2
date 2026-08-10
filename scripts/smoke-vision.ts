/**
 * Developer smoke test for the Vision Engine.
 *
 *   npx tsx scripts/smoke-vision.ts <image...>
 *
 * Runs a real analysis and prints detections, anchors, shot classification and
 * quality, then solves each framing preset against the result. Exists so the
 * engine can be exercised end-to-end without the app, the database or a browser
 * — which is also the fastest way to see whether a model swap changed anything.
 */

import fs from 'fs'
import path from 'path'
import { config } from '../src/config'
import { VisionEngine } from '../src/vision/engine'
import { OnnxVisionProvider } from '../src/vision/providers/onnx'
import { hashBytes } from '../src/storage/media-store'
import { solveFraming } from '../src/framing/solver'
import { FRAMING_PRESETS } from '../src/framing/types'
import type { AnchorName, VisionMetadata } from '../src/vision/types'

const files = process.argv.slice(2).filter(a => !a.startsWith('--'))
if (files.length === 0) {
  console.error('usage: tsx scripts/smoke-vision.ts <image...>')
  process.exit(1)
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits)
}

function printAnalysis(file: string, m: VisionMetadata) {
  console.log(`\n${'═'.repeat(78)}`)
  console.log(`${path.basename(file)}   ${m.image.width}×${m.image.height}   ${m.durationMs}ms`)
  console.log('═'.repeat(78))

  console.log(`\n  timings      ${Object.entries(m.timings).map(([k, v]) => `${k}=${v}ms`).join('  ')}`)

  console.log(`\n  DETECTION`)
  console.log(`    persons    ${m.persons.length}${m.primaryPersonIndex !== null ? ` (primary #${m.primaryPersonIndex})` : ''}`)
  m.persons.forEach((p, i) => {
    const marker = i === m.primaryPersonIndex ? '→' : ' '
    console.log(
      `    ${marker} #${i} score=${fmt(p.score, 3)} kps=${p.visibleKeypointCount}/17 ` +
      `area=${fmt(p.areaRatio * 100)}% box=[${Math.round(p.box.left)},${Math.round(p.box.top)} ${Math.round(p.box.right)},${Math.round(p.box.bottom)}]`
    )
  })
  console.log(`    faces      ${m.faces.length}${m.primaryFaceIndex !== null ? ` (primary #${m.primaryFaceIndex})` : ''}`)
  m.faces.forEach((f, i) => {
    const marker = i === m.primaryFaceIndex ? '→' : ' '
    console.log(
      `    ${marker} #${i} score=${fmt(f.score, 3)} roll=${f.roll !== null ? fmt(f.roll) + '°' : 'n/a'} ` +
      `landmarks=${f.landmarks ? 'yes' : 'no'} box=[${Math.round(f.box.left)},${Math.round(f.box.top)} ${Math.round(f.box.right)},${Math.round(f.box.bottom)}]`
    )
  })

  console.log(`\n  SEGMENTATION`)
  const pm = m.segmentation.person
  const gm = m.segmentation.garment
  console.log(
    `    person     ${pm ? `${pm.width}×${pm.height} coverage=${fmt(pm.coverage * 100)}% meanP=${fmt(pm.meanProbability, 2)} ref=${pm.ref || '(not stored)'}` : 'none'}`
  )
  console.log(
    `    garment    ${gm ? `coverage=${fmt(gm.coverage * 100)}% bbox=[${Math.round(gm.bbox.left)},${Math.round(gm.bbox.top)} ${Math.round(gm.bbox.right)},${Math.round(gm.bbox.bottom)}]` : 'none'}`
  )

  const g = m.garment
  console.log(`\n  GARMENT`)
  console.log(`    type       ${g.type}  (confidence ${fmt(g.confidence, 2)})`)
  console.log(`    sleeves    ${g.sleeveLength}     neckline  ${g.neckline}`)
  console.log(
    `    extent     top=${g.topY !== null ? Math.round(g.topY) : '—'}  hem=${g.hemY !== null ? Math.round(g.hemY) : '—'}` +
    `  coverage=${fmt(g.bodyCoverage * 100)}%  hemCropped=${g.hemCropped}`
  )

  console.log(`\n  ANCHORS`)
  const names = Object.keys(m.anchors) as AnchorName[]
  if (names.length === 0) console.log('    (none)')
  for (const name of names.sort()) {
    const a = m.anchors[name]!
    const yPct = (a.y / m.image.height) * 100
    console.log(
      `    ${name.padEnd(16)} (${String(Math.round(a.x)).padStart(5)}, ${String(Math.round(a.y)).padStart(5)})  ` +
      `y=${fmt(yPct).padStart(5)}%  conf=${fmt(a.confidence, 2)}  ${a.source}`
    )
  }

  console.log(`\n  SHOT`)
  console.log(`    ${m.shot.type}  (confidence ${fmt(m.shot.confidence, 2)})`)
  console.log(`    ${m.shot.reasoning}`)

  console.log(`\n  QUALITY`)
  const q = m.quality
  console.log(
    `    overall=${fmt(q.overall, 2)}  detection=${fmt(q.detection, 2)}  landmarks=${fmt(q.landmarks, 2)}  segmentation=${fmt(q.segmentation, 2)}`
  )
  for (const w of q.warnings) {
    console.log(`    [${w.severity}] ${w.code}: ${w.message}`)
  }
}

function printFraming(m: VisionMetadata) {
  console.log(`\n  FRAMING  (canvas 1080×1350)`)
  const canvas = { width: 1080, height: 1350 }
  const subject = {
    image: m.image,
    anchors: m.anchors,
    shotType: m.shot.type,
    subjectBox: m.segmentation.person?.bbox ?? m.persons[m.primaryPersonIndex ?? 0]?.box ?? null,
  }

  for (const [id, preset] of Object.entries(FRAMING_PRESETS)) {
    const result = solveFraming(subject, preset.spec, canvas)
    console.log(
      `    ${id.padEnd(20)} → ${result.strategyId.padEnd(18)} ` +
      `crop=[${Math.round(result.crop.x)},${Math.round(result.crop.y)} ${Math.round(result.crop.width)}×${Math.round(result.crop.height)}] ` +
      `zoom=${fmt(result.upscale, 2)}×${result.usedFallback ? '  (fallback)' : ''}`
    )
    for (const p of result.placements) {
      if (!p.target) continue
      const errY = p.error ? Math.round(p.error.y) : 0
      console.log(
        `      ${p.anchor.padEnd(16)} landed y=${String(Math.round(p.canvas.y)).padStart(5)}  ` +
        `target y=${String(Math.round(p.target.y)).padStart(5)}  error=${errY}px`
      )
    }
    for (const v of result.violations) {
      console.log(`      [${v.severity}] ${v.code}: ${v.message}`)
    }
  }
}

async function main() {
  const provider = new OnnxVisionProvider({
    modelDir: config.paths.modelDir,
    threads: config.vision.ortThreads,
  })
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
  })

  const loadStart = Date.now()
  await engine.initialize()
  console.log(`models loaded in ${Date.now() - loadStart}ms`)
  console.log(`capabilities  ${JSON.stringify(engine.capabilities())}`)
  if (!engine.isReady()) {
    console.error(`engine not ready: ${engine.readinessError()}`)
    process.exit(1)
  }
  for (const note of provider.degradations()) console.warn(`  degraded: ${note}`)

  for (const file of files) {
    const bytes = fs.readFileSync(file)
    const metadata = await engine.analyze(bytes, { sourceHash: hashBytes(bytes) })
    printAnalysis(file, metadata)
    printFraming(metadata)
  }

  await engine.dispose()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
