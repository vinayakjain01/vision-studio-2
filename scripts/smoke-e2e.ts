/**
 * End-to-end smoke test.
 *
 *   npx tsx scripts/smoke-e2e.ts <baseUrl> <imageDir>
 *
 * Drives the real HTTP API through the whole pipeline: import a folder, wait
 * for vision analysis, create a template and a rule, plan and run a batch, then
 * verify the creatives exist and record which framing strategy produced each.
 *
 * Exercises the worker pool, the queue, the compositor and the shared framing
 * solver together — the parts that can only break in combination.
 */

import fs from 'fs'
import path from 'path'
import { createDefaultTemplate } from '../src/templates/types'
import { clonePreset } from '../src/framing/types'

const baseUrl = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '')
const imageDir = process.argv[3]

if (!imageDir || !fs.existsSync(imageDir)) {
  console.error('usage: tsx scripts/smoke-e2e.ts <baseUrl> <imageDir>')
  process.exit(1)
}

let failures = 0

function check(label: string, condition: boolean, detail?: string): void {
  console.log(`  ${condition ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!condition) failures++
}

function step(label: string): void {
  console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}`)
}

async function api<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${pathname}`, init)
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`${init?.method ?? 'GET'} ${pathname} → ${response.status}: ${body.slice(0, 300)}`)
  }
  return response.json() as Promise<T>
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  console.log(`Vision Studio — end-to-end smoke test`)
  console.log(`  target  ${baseUrl}`)
  console.log(`  images  ${imageDir}`)

  // ── Engine ────────────────────────────────────────────────────────────────
  step('Engine status')
  const status = await api<any>('/api/vision/status')
  check('engine reports ready', status.engine.ready === true, status.engine.error ?? '')
  check(
    'all models present',
    status.models.every((m: any) => m.present),
    status.models.filter((m: any) => !m.present).map((m: any) => m.id).join(', ') || 'ok'
  )
  check('garment parsing available', status.engine.capabilities.garmentSegmentation === true)

  // ── Import ────────────────────────────────────────────────────────────────
  step('Folder import')
  const files = fs
    .readdirSync(imageDir)
    .filter(f => /\.(jpe?g|png|webp)$/i.test(f))
    .slice(0, 6)
  check('found test images', files.length > 0, `${files.length} files`)
  if (files.length === 0) process.exit(1)

  const created = await api<any>('/api/imports', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `smoke-${Date.now()}`, totalFiles: files.length }),
  })
  const importId: string = created.import.id
  check('import session created', !!importId, importId)

  const form = new FormData()
  for (const [index, file] of files.entries()) {
    const bytes = fs.readFileSync(path.join(imageDir, file))
    // Two folders, so product grouping and folder-based rules are both exercised.
    const folder = index % 2 === 0 ? 'looks/aw25-coat' : 'looks/aw25-dress'
    // A real File, matching what a browser sends from the directory picker.
    form.append(
      'files',
      new File([new Uint8Array(bytes)], file, { type: 'image/jpeg' }),
      file
    )
    form.append('paths', `${folder}/${file}`)
  }

  const upload = await api<any>(`/api/imports/${importId}/files`, { method: 'POST', body: form })
  check(
    'files ingested',
    upload.summary.imported + upload.summary.duplicates === files.length,
    JSON.stringify(upload.summary)
  )

  await api(`/api/imports/${importId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'finalize' }),
  })

  // ── Analysis ──────────────────────────────────────────────────────────────
  step('Vision analysis (worker pool)')
  const analysisStart = Date.now()
  let analysed = false

  for (let attempt = 0; attempt < 150; attempt++) {
    const detail = await api<any>(`/api/imports/${importId}`)
    const { pending, processing, ready, failed, unavailable } = detail.vision

    if (pending === 0 && processing === 0) {
      analysed = ready > 0
      check(
        'all images analysed',
        ready === detail.imageCount,
        `ready=${ready} failed=${failed} unavailable=${unavailable} in ${Math.round((Date.now() - analysisStart) / 1000)}s`
      )
      break
    }
    await sleep(2000)
  }
  if (!analysed) check('analysis completed within timeout', false)

  // ── Landmarks ─────────────────────────────────────────────────────────────
  step('Landmarks')
  const products = await api<any>(`/api/products?importId=${importId}&limit=50`)
  check('products created', products.products.length > 0, `${products.products.length} products`)
  check(
    'grouped by folder',
    products.products.length === 2,
    products.products.map((p: any) => `${p.folderPath} (${p.imageCount})`).join(', ')
  )

  const detail = await api<any>(`/api/products/${products.products[0].id}`)
  const firstImage = detail.images[0]
  check('vision payload present', !!firstImage?.vision)

  if (firstImage?.vision) {
    const vision = firstImage.vision
    const anchorCount = Object.keys(vision.anchors).length
    check('anchors derived', anchorCount > 0, `${anchorCount} anchors`)
    check('shot type classified', vision.shot.type !== 'unknown', vision.shot.type)
    check(
      'landmark coordinates are in source space',
      Object.values(vision.anchors).every(
        (a: any) => a.x >= -vision.image.width && a.x <= vision.image.width * 2
      )
    )
    check('quality scored', vision.quality.overall > 0, vision.quality.overall.toFixed(2))
    check('person mask stored', !!firstImage.assets.personMask)
    check('preview generated', !!firstImage.assets.preview)
  }

  // ── Preview subjects ──────────────────────────────────────────────────────
  step('Preview subjects (live preview feed)')
  const subjects = await api<any>('/api/preview/subjects?limit=6')
  check('subjects returned', subjects.subjects.length > 0, `${subjects.subjects.length}`)
  check(
    'subjects carry anchors for local solving',
    subjects.subjects.every((s: any) => s.anchors && s.image?.width > 0)
  )

  // ── Template ──────────────────────────────────────────────────────────────
  step('Template')
  const templateDoc = createDefaultTemplate('4:5')
  templateDoc.framing = clonePreset('full_body_editorial')
  templateDoc.layers = [
    {
      id: 'smoke_text',
      type: 'text',
      name: 'Product name',
      x: 6,
      y: 86,
      width: 60,
      height: 8,
      rotation: 0,
      opacity: 1,
      zIndex: 5,
      visible: true,
      locked: false,
      anchorTo: null,
      content: '{{product_name}}',
      fontFamily: 'Inter',
      fontSizePct: 3.2,
      fontWeight: 'bold',
      color: '#ffffff',
      align: 'left',
      lineHeight: 1.15,
      letterSpacing: 0.5,
      wrap: true,
      backgroundColor: null,
      paddingPct: 0,
      borderRadiusPct: 0,
      uppercase: true,
    },
  ]

  const template = await api<any>('/api/templates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Smoke 4:5', aspectRatio: '4:5' }),
  })
  const templateId: string = template.template.id

  await api(`/api/templates/${templateId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ document: templateDoc }),
  })
  check('template created and updated', !!templateId, templateId)

  // Validation should reject a chain whose fallback needs anchors.
  const invalidDoc = JSON.parse(JSON.stringify(templateDoc))
  invalidDoc.framing.strategies[invalidDoc.framing.strategies.length - 1].requires = ['head_top']
  const invalidResponse = await fetch(`${baseUrl}/api/templates/${templateId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ document: invalidDoc }),
  })
  check('rejects a fallback strategy that requires anchors', invalidResponse.status === 400)

  // ── Rule ──────────────────────────────────────────────────────────────────
  step('Rules')
  const rule = await api<any>('/api/rules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Smoke — looks folder',
      matchType: 'folder',
      operator: 'starts_with',
      value: 'looks',
      templateId,
      priority: 100,
    }),
  })
  check('rule created', !!rule.rule.id)

  const rulesList = await api<any>('/api/rules')
  check('rules returned in evaluation order with specificity', rulesList.rules[0].specificity > 0)

  // ── Plan ──────────────────────────────────────────────────────────────────
  step('Generation plan')
  const planned = await api<any>('/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ importId, dryRun: true }),
  })
  check('plan resolves products to the template', planned.plan.renderable > 0, `${planned.plan.renderable} renderable`)
  check('no unmatched products', planned.plan.unmatched === 0, `${planned.plan.unmatched} unmatched`)
  check(
    'explanation names the matching rule',
    planned.plan.items[0]?.explanation?.includes('folder'),
    planned.plan.items[0]?.explanation
  )

  // ── Batch ─────────────────────────────────────────────────────────────────
  step('Bulk generation')
  const batch = await api<any>('/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ importId, allImages: true, name: 'Smoke batch' }),
  })
  const batchId: string = batch.batch.id
  check('batch queued', batch.queued > 0, `${batch.queued} jobs`)

  let batchDone = false
  const renderStart = Date.now()
  for (let attempt = 0; attempt < 120; attempt++) {
    const progress = await api<any>(`/api/batches/${batchId}?creatives=true`)
    if (['completed', 'failed', 'cancelled'].includes(progress.batch.status)) {
      batchDone = true
      check(
        'batch completed',
        progress.batch.status === 'completed',
        `${progress.batch.completedJobs}/${progress.batch.totalJobs} in ${Math.round((Date.now() - renderStart) / 1000)}s`
      )
      check('no failed renders', progress.batch.failedJobs === 0, JSON.stringify(progress.failures.slice(0, 2)))
      check('creatives recorded', (progress.creatives?.length ?? 0) > 0)

      const strategies = new Map<string, number>()
      for (const creative of progress.creatives ?? []) {
        strategies.set(creative.strategyId, (strategies.get(creative.strategyId) ?? 0) + 1)
      }
      console.log(
        `    strategies used: ${[...strategies].map(([id, n]) => `${id}×${n}`).join(', ')}`
      )
      break
    }
    await sleep(2000)
  }
  if (!batchDone) check('batch finished within timeout', false)

  // ── Output ────────────────────────────────────────────────────────────────
  step('Creative output')
  const creatives = await api<any>('/api/creatives?limit=20')
  check('creatives listed', creatives.creatives.length > 0, `${creatives.total} total`)

  const sample = creatives.creatives[0]
  if (sample) {
    const image = await fetch(`${baseUrl}${sample.url}`)
    const bytes = Buffer.from(await image.arrayBuffer())
    check('creative bytes served', image.ok && bytes.byteLength > 1000, `${bytes.byteLength} bytes`)
    // JPEG SOI marker — confirms a real encoded image, not an error page.
    check('output is a valid JPEG', bytes[0] === 0xff && bytes[1] === 0xd8)
    check('framing recorded on the creative', !!sample.strategyId, sample.strategyLabel ?? '')
  }

  // ── Ephemeral proof render ────────────────────────────────────────────────
  step('Ad-hoc render of an unsaved template')
  const proof = await fetch(`${baseUrl}/api/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ imageId: firstImage.id, document: templateDoc, maxDimension: 600 }),
  })
  const proofBytes = Buffer.from(await proof.arrayBuffer())
  check('proof render returns PNG', proof.ok && proofBytes[1] === 0x50, `${proofBytes.byteLength} bytes`)
  check('framing diagnostics in headers', !!proof.headers.get('x-framing-strategy'), proof.headers.get('x-framing-strategy') ?? '')

  // ── Determinism ───────────────────────────────────────────────────────────
  step('Determinism')
  const second = await fetch(`${baseUrl}/api/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ imageId: firstImage.id, document: templateDoc, maxDimension: 600 }),
  })
  const secondBytes = Buffer.from(await second.arrayBuffer())
  check(
    'the same input renders byte-identically',
    Buffer.compare(proofBytes, secondBytes) === 0,
    `${proofBytes.byteLength} vs ${secondBytes.byteLength} bytes`
  )

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(64)}`)
  if (failures === 0) {
    console.log('✓ all checks passed')
  } else {
    console.log(`✗ ${failures} check(s) failed`)
    process.exitCode = 1
  }
}

main().catch(err => {
  console.error('\nsmoke test aborted:', err)
  process.exit(1)
})
