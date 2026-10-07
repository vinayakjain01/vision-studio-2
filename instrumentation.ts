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
}
