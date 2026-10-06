import { defineConfig } from 'vitest/config'
import path from 'path'

/**
 * Node environment, not jsdom — every test here exercises server-only code
 * (route handlers, repositories, the tenant DB layer) directly, never a
 * browser DOM.
 *
 * `fileParallelism: false`: most tests in `tests/isolation/` spin up real
 * SQLite files under a temp data dir and mutate `process.env.VISION_STUDIO_
 * DATA_DIR` per file (see `tests/helpers/tenant-env.ts`). Running files in
 * parallel workers is fine in principle (each gets its own temp dir), but
 * serial keeps failures easy to attribute to one test's actual assertion
 * rather than cross-file filesystem contention, which matters more here than
 * wall-clock time.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
})
