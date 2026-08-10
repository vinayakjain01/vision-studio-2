/**
 * Standalone worker process.
 *
 *   npm run worker
 *
 * The pool normally runs inside the Next.js server (see `pool.ts`). This
 * entry point runs it on its own instead, for the case where analysis and
 * rendering should not compete with the web server for CPU — a large overnight
 * import, or a second machine pointed at the same data directory.
 *
 * Both modes are safe simultaneously: claiming is a conditional UPDATE, so an
 * in-server pool and a standalone runner simply share the queue.
 */

import { getPool } from './pool'
import * as queue from './queue'
import { closeDb } from '@/db/client'
import { config } from '@/config'

async function main() {
  console.log('Vision Studio — worker')
  console.log(`  database    ${config.paths.database}`)
  console.log(`  models      ${config.paths.modelDir}`)
  console.log(`  vision slots ${config.jobs.visionConcurrency}`)
  console.log(`  render slots ${config.jobs.renderConcurrency}`)

  const pool = getPool()
  pool.start()

  const report = setInterval(() => {
    const vision = queue.stats('vision')
    const render = queue.stats('render')
    const status = pool.status()
    const busy = status.workers.filter(w => w.state === 'busy').length

    if (vision.pending + vision.running + render.pending + render.running === 0) return

    console.log(
      `  vision p=${vision.pending} r=${vision.running} f=${vision.failed} | ` +
      `render p=${render.pending} r=${render.running} f=${render.failed} | ` +
      `workers ${busy}/${status.workers.length} busy`
    )
  }, 5000)

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} — draining`)
    clearInterval(report)
    await pool.stop()
    closeDb()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  // Hold the process open; the pool's threads are unref'd so they would not
  // keep it alive on their own.
  await new Promise(() => {})
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
