/**
 * Every test file that touches the DB/storage layer must import this FIRST,
 * before any `@/...` import — `src/config.ts` reads `VISION_STUDIO_DATA_DIR`
 * into a module-level constant at import time, so the env var has to be set
 * before that module is ever evaluated. Vitest gives each test file its own
 * module registry (the default `isolate: true`), so this runs fresh per file
 * and each file gets its own, never-reused temp directory — tests in
 * different files can never see each other's tenants or DB files.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-test-'))
process.env.VISION_STUDIO_DATA_DIR = dir
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@test.local'
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Test-Password-1'
process.env.ALLOW_MULTI_TENANT_PREVIEW = '1'

export const testDataDir = dir
