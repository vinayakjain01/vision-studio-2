/**
 * Next.js's documented server-startup hook — `register()` runs once, before
 * the server starts handling requests, in whichever runtime is configured
 * (this app only cares about `nodejs`; the edge runtime has no event loop of
 * its own to monitor the same way).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const { startEventLoopMonitor } = await import('@/lib/event-loop-monitor')
  startEventLoopMonitor()

  // P6: the web process runs an in-process worker pool (see
  // src/jobs/pool.ts, started lazily by ensurePoolRunning()) — on SIGTERM
  // it needs to drain that pool and checkpoint/close the databases the same
  // way the standalone `npm run worker` process does (src/jobs/runner.ts).
  //
  // `exitProcess: true` — registering our own SIGTERM/SIGINT handler
  // SUPPRESSES Node's default "terminate immediately" behavior for that
  // signal, and `next start`'s own signal handling is not something this
  // app controls or can rely on across versions — without calling
  // `process.exit()` ourselves once draining finishes, nothing would, and
  // the container would hang until the orchestrator's SIGKILL timeout. This
  // is explicitly scoped to the JOB QUEUE's own graceful-shutdown
  // guarantees (stop claiming, drain, checkpoint, close) — it does not
  // attempt to gracefully drain in-flight HTTP requests, which is a
  // separate web-server concern outside what this phase asks for.
  const { registerGracefulShutdown } = await import('@/jobs/shutdown')
  registerGracefulShutdown({ exitProcess: true })
}
