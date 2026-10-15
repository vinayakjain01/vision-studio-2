/**
 * Operator diagnostics CLI (Phase 1.2, docs/ISSUES.md).
 *
 *   npm run diag                                   -- against http://localhost:3000
 *   DIAG_BASE_URL=http://168.144.66.255 npm run diag -- against a real deployment
 *
 * An HTTP client, not a direct DB reader — on purpose. Per-worker RSS,
 * in-memory pool state and event-loop delay only exist inside the LIVE
 * server process; a separate script process reading control.db has no way
 * to see them no matter what it queries. This is the one admin script in
 * this repo that genuinely needs the server to be running, unlike the
 * lockout-recovery scripts (admin-promote.ts etc.), which deliberately
 * don't.
 *
 * Logs in with ADMIN_EMAIL/ADMIN_PASSWORD from the environment — never a
 * CLI argument, which npm would echo into its own output (see
 * docs/OPERATIONS.md's admin:promote warning for exactly this leak having
 * happened once already in this project).
 */

const BASE_URL = process.env.DIAG_BASE_URL || 'http://localhost:3000'

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}min`
}

async function main() {
  const email = process.env.ADMIN_EMAIL
  const password = process.env.ADMIN_PASSWORD
  if (!email || !password) {
    console.error('ADMIN_EMAIL and ADMIN_PASSWORD must be set in the environment.')
    process.exit(1)
  }

  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE_URL },
    body: JSON.stringify({ email, password }),
  })
  if (!loginRes.ok) {
    console.error(`Login failed: HTTP ${loginRes.status}`)
    process.exit(1)
  }
  const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0]

  const res = await fetch(`${BASE_URL}/api/admin/diag`, { headers: { cookie } })
  if (!res.ok) {
    console.error(`GET /api/admin/diag failed: HTTP ${res.status}`)
    process.exit(1)
  }
  const diag = await res.json()

  console.log(`Diagnostics @ ${diag.generatedAt} (${BASE_URL})\n`)

  console.log('Jobs by kind/status (oldest-in-bucket age):')
  for (const b of diag.jobsByBucket) {
    console.log(`  ${b.kind.padEnd(16)} ${b.status.padEnd(10)} count=${String(b.count).padEnd(6)} oldest=${fmtMs(b.oldestAgeMs)}`)
  }

  console.log('\nOldest claimed/running job:')
  console.log(
    diag.oldestClaimedOrRunning
      ? `  ${diag.oldestClaimedOrRunning.jobId} (${diag.oldestClaimedOrRunning.kind}, ${diag.oldestClaimedOrRunning.status}) — ${fmtMs(diag.oldestClaimedOrRunning.ageMs)} old, tenant ${diag.oldestClaimedOrRunning.tenantId}`
      : '  none'
  )

  console.log(`\nDeferral-loop candidates (attempts >= maxAttempts-1, still active): ${diag.deferralLoopCandidates.length}`)
  for (const c of diag.deferralLoopCandidates.slice(0, 10)) {
    console.log(`  ${c.jobId} (${c.kind}) attempts=${c.attempts}/${c.maxAttempts} age=${fmtMs(c.ageMs)} tenant=${c.tenantId}`)
  }

  console.log('\nWorkers:')
  for (const w of diag.workers) {
    console.log(`  ${w.id.padEnd(12)} ${w.state.padEnd(8)} pid=${w.pid ?? '-'} rss=${w.rssMb != null ? w.rssMb + 'MB' : 'unknown'} kinds=${w.kinds.join(',')}`)
  }

  console.log(`\nPool stall self-heals since last start: ${diag.stallRestartCount}`)
  console.log(`Queue depth total: ${diag.queueDepthTotal}`)
  console.log(`Event-loop p99: ${diag.eventLoopP99Ms != null ? diag.eventLoopP99Ms + 'ms' : 'unavailable'}`)
  console.log(`Memory: ${diag.memory.rssMb}MB RSS${diag.memory.limitMb != null ? ` / ${diag.memory.limitMb}MB limit (${((diag.memory.rssMb / diag.memory.limitMb) * 100).toFixed(0)}%)` : ' (no container limit detected)'}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
