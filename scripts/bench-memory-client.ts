/**
 * Upload-memory benchmark — CLIENT half.
 *
 *   npm run bench:memory
 *
 * Spawns `bench-memory-server.ts` as a genuinely separate OS process,
 * drives real HTTP multipart uploads against it for batches of 10, 50, 100
 * and 300 files, and reads the server's OWN `process.memoryUsage()` back
 * over HTTP — so every number reported is the server's, never this
 * process's. Peak RSS is sampled continuously by the server during the
 * request; settled RSS is read after two forced GC passes once the
 * response has returned and a short idle period has elapsed.
 */

import crypto from 'crypto'
import path from 'path'
import { spawn, type ChildProcess } from 'child_process'

const PORT = 4851
const BASE = `http://127.0.0.1:${PORT}`
const BATCH_SIZES = [10, 50, 100, 300]

interface MemSnapshot {
  rss: number
  heapTotal: number
  heapUsed: number
  external: number
  arrayBuffers: number
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(2)
}

async function noisyJpegBytes(width: number, height: number, seed: number): Promise<Buffer> {
  const sharp = (await import('sharp')).default
  // Seeded-ish noise (not cryptographically random, just varied enough that
  // every file is a genuinely distinct image, not a dedup-friendly repeat)
  // — a real batch of photos is never N copies of the same bytes.
  const raw = Buffer.alloc(width * height * 3)
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761 + seed) & 0xff
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 85 }).toBuffer()
}

function multipartBody(
  files: { name: string; bytes: Buffer; relativePath: string }[]
): { body: Buffer; contentType: string } {
  const boundary = '----visionStudioBenchBoundary' + crypto.randomBytes(8).toString('hex')
  const parts: Buffer[] = []
  for (const f of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: image/jpeg\r\n\r\n`
      ),
      f.bytes,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="paths"\r\n\r\n${f.relativePath}\r\n`)
    )
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

async function waitForServer(proc: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    proc.stdout?.on('data', chunk => {
      const text = chunk.toString()
      process.stdout.write(`[server] ${text}`)
      if (!settled && text.includes('BENCH_SERVER_READY')) {
        settled = true
        resolve()
      }
    })
    proc.stderr?.on('data', chunk => process.stderr.write(`[server] ${chunk.toString()}`))
    proc.on('exit', code => {
      if (!settled) reject(new Error(`server exited early with code ${code}`))
    })
    setTimeout(() => {
      if (!settled) reject(new Error('server did not report ready within 30s'))
    }, 30_000)
  })
}

async function main() {
  console.log('Vision Studio — upload memory benchmark (separate server process, --expose-gc)\n')

  // `node <node_modules>/tsx/dist/cli.mjs <file>` rather than `npx tsx` —
  // `npx` needs `shell: true` to resolve on Windows, which spawns a cmd.exe
  // wrapper that does NOT reliably propagate SIGTERM down to the real node
  // grandchild: the first version of this script left an orphaned server
  // holding the benchmark port after being killed. Invoking tsx's own CLI
  // entry point directly makes `server` the actual node process running the
  // server, so `server.kill()` below really does stop it.
  // --expose-gc via NODE_OPTIONS (env), not an execArgv flag on this spawn
  // directly — tsx's CLI re-execs an internal child process to install its
  // loader hooks, and an argv flag on the OUTER process doesn't reach that
  // inner one, but an inherited environment variable does.
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const server = spawn(process.execPath, [tsxCli, 'scripts/bench-memory-server.ts'], {
    env: { ...process.env, BENCH_PORT: String(PORT), NODE_OPTIONS: '--expose-gc' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Belt and suspenders: if THIS process is killed abruptly (Ctrl+C, the
  // harness stopping a backgrounded run), still take the server down with
  // it rather than leaving it bound to the port for the next run to collide
  // with — exactly what happened once during development of this script.
  const killServer = () => server.kill('SIGKILL')
  process.on('exit', killServer)
  process.on('SIGINT', () => {
    killServer()
    process.exit(1)
  })
  process.on('SIGTERM', () => {
    killServer()
    process.exit(1)
  })

  try {
    await waitForServer(server)

    const setupRes = await fetch(`${BASE}/setup-info`)
    const { importId, token } = (await setupRes.json()) as { importId: string; token: string }
    const { config } = await import('../src/config')
    const cookie = `${config.auth.sessionCookieName}=${token}`

    const results: {
      n: number
      peakMB: string
      settled: MemSnapshot
      settledMB: string
      heapUsedMB: string
      externalMB: string
      arrayBuffersMB: string
    }[] = []

    for (const n of BATCH_SIZES) {
      console.log(`\n── ${n} files ──────────────────────────────────────────`)
      console.log(`  building ${n} distinct noise-JPEGs (300x400)...`)
      const files = []
      for (let i = 0; i < n; i++) {
        files.push({
          name: `photo-${i}.jpg`,
          bytes: await noisyJpegBytes(300, 400, i),
          relativePath: `product-${i}/photo-${i}.jpg`,
        })
      }
      const { body, contentType } = multipartBody(files)
      console.log(`  request body: ${mb(body.byteLength)} MB`)

      await fetch(`${BASE}/mem/reset-peak`, { method: 'POST' })

      const start = Date.now()
      const uploadRes = await fetch(`${BASE}/api/imports/${importId}/files`, {
        method: 'POST',
        headers: { cookie, 'content-type': contentType },
        body: new Uint8Array(body),
      })
      const uploadBody = await uploadRes.json()
      const elapsedMs = Date.now() - start

      const peakRes = await fetch(`${BASE}/mem/peak`)
      const { peakRss } = (await peakRes.json()) as { peakRss: number }

      // Let any trailing microtasks/timers from the just-finished request
      // settle before measuring "idle" memory.
      await new Promise(r => setTimeout(r, 500))
      const settledRes = await fetch(`${BASE}/mem/settled?gc=1`)
      const settled = (await settledRes.json()) as MemSnapshot

      console.log(`  status ${uploadRes.status}  summary ${JSON.stringify(uploadBody.summary)}  elapsed ${elapsedMs}ms`)
      console.log(`  peak RSS     ${mb(peakRss)} MB`)
      console.log(
        `  settled RSS  ${mb(settled.rss)} MB  (heapUsed ${mb(settled.heapUsed)} MB, ` +
          `external ${mb(settled.external)} MB, arrayBuffers ${mb(settled.arrayBuffers)} MB)`
      )

      results.push({
        n,
        peakMB: mb(peakRss),
        settled,
        settledMB: mb(settled.rss),
        heapUsedMB: mb(settled.heapUsed),
        externalMB: mb(settled.external),
        arrayBuffersMB: mb(settled.arrayBuffers),
      })
    }

    console.log('\n\n== Summary ==')
    console.table(
      results.map(r => ({
        files: r.n,
        'peak RSS (MB)': r.peakMB,
        'settled RSS (MB)': r.settledMB,
        'settled heapUsed (MB)': r.heapUsedMB,
        'settled external (MB)': r.externalMB,
        'settled arrayBuffers (MB)': r.arrayBuffersMB,
      }))
    )

    const first = results[0]
    const last = results[results.length - 1]
    const fileRatio = last.n / first.n
    const settledRatio = parseFloat(last.settledMB) / parseFloat(first.settledMB)
    console.log(
      `\nFile count grew ${fileRatio}x (${first.n} -> ${last.n}); settled RSS grew ${settledRatio.toFixed(2)}x ` +
        `(${first.settledMB} MB -> ${last.settledMB} MB).`
    )
  } finally {
    server.kill('SIGTERM')
    await new Promise(r => setTimeout(r, 300))
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
