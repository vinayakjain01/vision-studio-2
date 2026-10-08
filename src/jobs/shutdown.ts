/**
 * Graceful shutdown (P6), shared by both processes that run a worker pool:
 * the web process (in-process pool, started lazily by `ensurePoolRunning()`
 * — see `instrumentation.ts`, which registers this) and the standalone
 * `npm run worker` process (`src/jobs/runner.ts`).
 *
 * Order matters: `pool.stop()` first (stops claiming, waits up to
 * `SHUTDOWN_GRACE_SECONDS` for in-flight jobs, hands back whatever doesn't
 * finish in time — see pool.ts's `stop()`), THEN `closeDb()` (checkpoints
 * the WAL and closes every handle) — closing the database while a worker
 * might still be mid-write would be the exact corruption risk this ordering
 * avoids.
 *
 * Idempotent and safe to call more than once (a container runtime can send
 * SIGTERM followed by SIGINT, or the same signal twice) — a second call
 * while the first is still draining just waits on the same in-flight
 * shutdown rather than starting a second one.
 */

let shuttingDown: Promise<void> | null = null

async function runShutdown(): Promise<void> {
  const { getPool } = await import('./pool')
  const { closeDb } = await import('@/db/client')

  console.log('[shutdown] received signal — draining (grace period: see SHUTDOWN_GRACE_SECONDS)')
  await getPool().stop()
  closeDb()
  console.log('[shutdown] drained — DBs checkpointed and closed')
}

/** Registers SIGTERM/SIGINT handlers once. `exitProcess` is false for the web process (Next.js owns its own process lifecycle after this) and true for the standalone worker (which has nothing else keeping it alive). */
export function registerGracefulShutdown(options: { exitProcess: boolean }): void {
  const handle = (signal: string) => {
    if (!shuttingDown) {
      shuttingDown = runShutdown().catch(err => {
        console.error('[shutdown] error while draining:', err)
      })
    }
    shuttingDown.finally(() => {
      if (options.exitProcess) process.exit(0)
    })
    void signal
  }

  process.on('SIGTERM', () => handle('SIGTERM'))
  process.on('SIGINT', () => handle('SIGINT'))
}
