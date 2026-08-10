/**
 * Wipe Turbopack's persistent dev cache before every `next dev` start.
 *
 * Turbopack keeps a cache database under `.next/dev/cache` across restarts to
 * speed up recompiles. If the process is ever killed ungracefully — closing
 * the terminal window, a crash, `taskkill /F`, the OS itself losing power —
 * mid-write to that database, the next `next dev` can start against a
 * corrupted cache. Observed in practice: Turbopack does not fail cleanly on
 * that corruption, it spawns worker processes to try to recover, each of
 * which hits the same corrupted file and fails, and the retries compound —
 * hundreds of node processes accumulating within minutes, at which point the
 * OS itself (not just this app) becomes unresponsive.
 *
 * A stale cache only ever costs a few seconds of slower recompiling; a
 * corrupted one costs the whole machine. Deleting it unconditionally before
 * every dev start is a small, guaranteed trade against a failure mode with no
 * clean recovery once it starts. `fs.rmSync` rather than a shell `rm -rf` /
 * `Remove-Item` so this runs identically under `npm run dev` on Windows,
 * macOS or Linux.
 */

import fs from 'fs'
import path from 'path'

const target = path.join(process.cwd(), '.next')

try {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 })
} catch (err) {
  // Never block `dev` from starting over a cache directory that would get
  // rebuilt anyway — worst case, it starts against whatever is left.
  console.warn(`[clean-dev-cache] could not fully remove ${target}:`, (err as Error).message)
}
