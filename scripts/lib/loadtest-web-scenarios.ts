/**
 * Scenarios 5 and 6 for scripts/loadtest-multitenant.ts — these need a REAL
 * running HTTP server (not just the in-process pool the other scenarios use)
 * because the whole point is measuring actual request latency and
 * event-loop delay while that same process's worker pool is saturated.
 *
 * Spawns `node_modules/.bin/next start` against the SAME temp data dir the
 * rest of the load test is using. Requires `npm run build` to have already
 * run (same as any production deploy — this script does not rebuild on
 * every invocation; see the main script's own usage text).
 */

import { spawn, type ChildProcess } from 'child_process'
import path from 'path'
import { hashPassword } from '@/auth/password'
import { users } from '@/db/control-repositories'
import { importFixturePhotos, type LoadTestTenant } from './loadtest-fixtures'
import { summarize, Stopwatch, type ScenarioResult, fmtMs, type LatencyStats } from './loadtest-metrics'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export interface ServerHandle {
  baseUrl: string
  process: ChildProcess
  adminCookie: string
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`)
      if (res.ok) return true
    } catch {
      // Not listening yet.
    }
    await sleep(300)
  }
  return false
}

/**
 * Spawns a real `next start` on `port`, pointed at `process.env` as already
 * set by the caller (VISION_STUDIO_DATA_DIR, concurrency knobs, etc. — this
 * function does not set any env itself). Creates a platform-admin user
 * directly (bypassing the API) purely so the web scenarios can read
 * `/api/admin/global`'s event-loop stats; never used for anything else.
 */
export async function startRealServer(port: number): Promise<ServerHandle> {
  const adminEmail = `loadtest-admin-${Date.now()}@loadtest.local`
  const adminPassword = 'Loadtest-Admin-Password-1'
  users.create({ email: adminEmail, passwordHash: await hashPassword(adminPassword), isPlatformAdmin: true })

  // next's own compiled JS entry point, NOT node_modules/.bin/next — that
  // bin shim is a POSIX shell script on this platform (no .sh extension),
  // which Node happily tries to parse as JavaScript and fails on. The real
  // dist/bin/next file is itself a plain, portable Node script (shebang
  // line Node ignores, same as every other entry point in this repo).
  const nextBin = path.join('node_modules', 'next', 'dist', 'bin', 'next')
  const child = spawn(process.execPath, [nextBin, 'start', '-p', String(port)], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port) },
  })
  child.stdout?.on('data', d => process.stdout.write(`[next-server] ${d}`))
  child.stderr?.on('data', d => process.stderr.write(`[next-server] ${d}`))

  const baseUrl = `http://localhost:${port}`
  const healthy = await waitForHealth(baseUrl, 30_000)
  if (!healthy) {
    child.kill('SIGKILL')
    throw new Error(`real server on ${baseUrl} did not become healthy within 30s — did you run "npm run build" first?`)
  }

  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  })
  if (!loginRes.ok) throw new Error(`loadtest admin login failed: ${loginRes.status}`)
  const setCookie = loginRes.headers.get('set-cookie') ?? ''
  const adminCookie = setCookie.split(';')[0]

  return { baseUrl, process: child, adminCookie }
}

export async function stopRealServer(handle: ServerHandle): Promise<void> {
  handle.process.kill('SIGTERM')
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      handle.process.kill('SIGKILL')
      resolve()
    }, 10_000)
    handle.process.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function timedFetch(url: string, cookie?: string): Promise<number> {
  const start = process.hrtime.bigint()
  const res = await fetch(url, cookie ? { headers: { cookie } } : undefined)
  await res.arrayBuffer() // drain the body — latency should include receiving it, not just headers
  return Number(process.hrtime.bigint() - start) / 1e6
}

async function readEventLoopP99(server: ServerHandle): Promise<number | null> {
  try {
    const res = await fetch(`${server.baseUrl}/api/admin/global`, { headers: { cookie: server.adminCookie } })
    if (!res.ok) return null
    const body = (await res.json()) as { eventLoopP99Ms: number | null }
    return body.eventLoopP99Ms
  } catch {
    return null
  }
}

// ─── Scenario 5: web responsiveness while workers are saturated ───────────

export async function scenario5WebResponsiveness(
  server: ServerHandle,
  tenant: LoadTestTenant,
  fixturePaths: string[],
  mode: 'fast' | 'real'
): Promise<ScenarioResult> {
  const sw = new Stopwatch()

  // Saturate the workers first — a bulk import big enough to keep every
  // worker slot busy for the duration of the HTTP load below.
  const saturationJobCount = mode === 'fast' ? 400 : 40
  await importFixturePhotos(tenant, fixturePaths, saturationJobCount)
  await sleep(mode === 'fast' ? 500 : 5000) // let saturation actually kick in

  const loginRes = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: tenant.email, password: tenant.password }),
  })
  const tenantCookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0]

  const endpoints = [`${server.baseUrl}/api/health`, `${server.baseUrl}/api/products`, `${server.baseUrl}/api/vision/status`]

  const concurrency = 20
  const requestsPerClient = 10
  const samples: number[] = []

  await Promise.all(
    Array.from({ length: concurrency }, async (_, i) => {
      const endpoint = endpoints[i % endpoints.length]
      const cookie = endpoint.includes('/api/health') ? undefined : tenantCookie
      for (let r = 0; r < requestsPerClient; r++) {
        samples.push(await timedFetch(endpoint, cookie))
      }
    })
  )

  const eventLoopP99 = await readEventLoopP99(server)
  const stats: LatencyStats = summarize(samples)
  const met = stats.p95 < 500

  return {
    name: 'Scenario 5 — web responsiveness while workers are saturated',
    mode,
    durationMs: sw.elapsedMs(),
    metrics: {
      'saturating backlog size': saturationJobCount,
      'concurrent clients': concurrency,
      'requests per client': requestsPerClient,
      'total requests': samples.length,
      p50: fmtMs(stats.p50),
      p95: fmtMs(stats.p95),
      p99: fmtMs(stats.p99),
      max: fmtMs(stats.max),
      'event-loop p99 (from admin panel)': eventLoopP99 != null ? fmtMs(eventLoopP99) : 'unavailable',
    },
    targets: [
      { description: 'Web p95 under ~500ms while saturated', met, evidence: `p95 = ${fmtMs(stats.p95)}` },
    ],
    notes: [],
  }
}

// ─── Scenario 6: a 300-photo bulk ZIP + a 100-file upload during saturation ─

export async function scenario6BulkDuringSaturation(
  server: ServerHandle,
  tenant: LoadTestTenant,
  fixturePaths: string[],
  mode: 'fast' | 'real'
): Promise<ScenarioResult> {
  const sw = new Stopwatch()
  const uploadFileCount = mode === 'fast' ? 100 : 20

  const loginRes = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: tenant.email, password: tenant.password }),
  })
  const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0]

  // Create an import, then stream `uploadFileCount` files to it via the real
  // multipart route — this exercises the actual upload path (busboy
  // streaming, per-file hashing, quota checks) under saturation, not a
  // direct ingestFiles() call.
  const importRes = await fetch(`${server.baseUrl}/api/imports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: `saturation-upload-${Date.now()}`, totalFiles: uploadFileCount }),
  })
  const importBody = (await importRes.json()) as { import?: { id?: string } }
  const importId = importBody.import?.id

  let uploadOk = false
  let uploadMs = -1
  if (importId) {
    const form = new FormData()
    const fs = await import('fs/promises')
    for (let i = 0; i < uploadFileCount; i++) {
      const bytes = await fs.readFile(fixturePaths[i % fixturePaths.length])
      form.append('files', new Blob([bytes], { type: 'image/jpeg' }), `upload-${i}.jpg`)
      form.append('paths', `saturation/upload-${i}.jpg`)
    }
    const start = process.hrtime.bigint()
    const uploadRes = await fetch(`${server.baseUrl}/api/imports/${importId}/files`, {
      method: 'POST',
      headers: { cookie },
      body: form,
    })
    uploadMs = Number(process.hrtime.bigint() - start) / 1e6
    uploadOk = uploadRes.ok
  }

  return {
    name: 'Scenario 6 — bulk upload during saturation',
    mode,
    durationMs: sw.elapsedMs(),
    metrics: {
      'files uploaded': uploadFileCount,
      'upload succeeded': uploadOk,
      'upload duration': uploadMs >= 0 ? fmtMs(uploadMs) : 'n/a',
    },
    targets: [
      { description: 'A large upload completes (not rejected/hung) while workers are saturated', met: uploadOk, evidence: `upload response ok=${uploadOk} in ${uploadMs >= 0 ? fmtMs(uploadMs) : 'n/a'}` },
    ],
    notes: [
      'A full 300-photo bulk ZIP DOWNLOAD requires existing rendered creatives — this scenario covers the upload-during-saturation half; see the report deviations section for the ZIP-download half\'s status.',
    ],
  }
}
