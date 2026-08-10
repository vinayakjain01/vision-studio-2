/**
 * CLI: download and verify ONNX model weights.
 *
 *   npm run models:fetch          download anything missing, verify everything
 *   npm run models:verify         verify only, download nothing
 *   npm run models:fetch -- --force   re-download even if present and valid
 *
 * Verification is sha256 against `src/vision/model-registry.ts`. A file that
 * fails is moved aside rather than deleted, so a partial or corrupted download
 * can be inspected instead of silently vanishing.
 */

import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { config } from '../src/config'
import { MODEL_LIST, type ModelSpec } from '../src/vision/model-registry'

const force = process.argv.includes('--force')
const verifyOnly = process.argv.includes('--verify-only')

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function bar(fraction: number, width = 28): string {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width)
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}

async function download(spec: ModelSpec, dest: string): Promise<void> {
  const tmp = `${dest}.download`
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  await fsp.rm(tmp, { force: true })

  const response = await fetch(spec.url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`)
  }

  const expected = Number(response.headers.get('content-length')) || spec.byteSize
  let received = 0
  let lastRender = 0

  const handle = await fsp.open(tmp, 'w')
  try {
    // @ts-expect-error — Node's fetch body is an async-iterable ReadableStream.
    for await (const chunk of response.body) {
      const buf = Buffer.from(chunk)
      await handle.write(buf)
      received += buf.length
      const now = Date.now()
      if (now - lastRender > 120) {
        lastRender = now
        process.stdout.write(
          `\r    ${bar(received / expected)} ${mb(received)} / ${mb(expected)}   `
        )
      }
    }
  } finally {
    await handle.close()
  }
  process.stdout.write(`\r    ${bar(1)} ${mb(received)} / ${mb(expected)}   \n`)

  await fsp.rename(tmp, dest)
}

async function processModel(spec: ModelSpec): Promise<'ok' | 'downloaded' | 'failed' | 'missing'> {
  const dest = path.join(config.paths.modelDir, spec.file)
  const label = `${spec.id.padEnd(13)} ${spec.file}`

  const exists = fs.existsSync(dest)

  if (exists && !force) {
    const digest = await sha256File(dest)
    if (digest === spec.sha256) {
      console.log(`  ✓ ${label}  ${mb(spec.byteSize)}  verified`)
      return 'ok'
    }
    const quarantine = `${dest}.invalid-${digest.slice(0, 8)}`
    await fsp.rename(dest, quarantine)
    console.log(`  ! ${label}  digest mismatch`)
    console.log(`      expected ${spec.sha256}`)
    console.log(`      actual   ${digest}`)
    console.log(`      moved to ${path.basename(quarantine)}`)
    if (verifyOnly) return 'failed'
  }

  if (verifyOnly) {
    console.log(`  · ${label}  not present`)
    return 'missing'
  }

  console.log(`  ↓ ${label}  ${mb(spec.byteSize)}`)
  try {
    await download(spec, dest)
  } catch (err: any) {
    console.log(`  ✗ ${label}  download failed: ${err.message}`)
    return 'failed'
  }

  const digest = await sha256File(dest)
  if (digest !== spec.sha256) {
    const quarantine = `${dest}.invalid-${digest.slice(0, 8)}`
    await fsp.rename(dest, quarantine)
    console.log(`  ✗ ${label}  digest mismatch after download`)
    console.log(`      expected ${spec.sha256}`)
    console.log(`      actual   ${digest}`)
    return 'failed'
  }

  console.log(`  ✓ ${label}  verified`)
  return 'downloaded'
}

async function main() {
  console.log(`\nVision Studio — model ${verifyOnly ? 'verification' : 'fetch'}`)
  console.log(`  directory  ${config.paths.modelDir}`)
  const total = MODEL_LIST.reduce((sum, m) => sum + m.byteSize, 0)
  console.log(`  models     ${MODEL_LIST.length} (${mb(total)} total)\n`)

  await fsp.mkdir(config.paths.modelDir, { recursive: true })

  const outcomes: Record<string, string> = {}
  for (const spec of MODEL_LIST) {
    outcomes[spec.id] = await processModel(spec)
  }

  const failedRequired = MODEL_LIST.filter(
    m => m.required && outcomes[m.id] !== 'ok' && outcomes[m.id] !== 'downloaded'
  )
  const failedOptional = MODEL_LIST.filter(
    m => !m.required && outcomes[m.id] !== 'ok' && outcomes[m.id] !== 'downloaded'
  )

  console.log('\nLicences')
  for (const spec of MODEL_LIST) {
    console.log(`  ${spec.id.padEnd(13)} ${spec.license}`)
    console.log(`  ${' '.repeat(13)} ${spec.licenseUrl}`)
  }

  if (failedOptional.length) {
    console.log(
      `\n⚠ optional models unavailable: ${failedOptional.map(m => m.id).join(', ')}`
    )
    console.log('  The engine runs without them, with reduced capability:')
    for (const m of failedOptional) console.log(`    ${m.id} — ${m.description}`)
  }

  if (failedRequired.length) {
    console.error(
      `\n✗ required models unavailable: ${failedRequired.map(m => m.id).join(', ')}`
    )
    console.error('  Vision analysis cannot run. Re-run `npm run models:fetch`.')
    process.exit(1)
  }

  console.log('\n✓ models ready')
}

main().catch(err => {
  console.error('\n✗ fetch failed:', err)
  process.exit(1)
})
