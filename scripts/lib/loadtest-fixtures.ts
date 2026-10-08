/**
 * Tenant/photo provisioning helpers for scripts/loadtest-multitenant.ts.
 *
 * Every tenant created here goes through the exact same
 * `createTenantAndFirstUser` the admin console uses — a real control-plane
 * row, a real migrated app.db, real media directories. Nothing here is a
 * parallel fake domain model; it's the same provisioning path production
 * traffic uses, which is the whole point of measuring against it.
 */

import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import sharp from 'sharp'
import { createTenantAndFirstUser } from '@/services/admin-service'
import { quotas as quotaRepo, tenantQueueState, users } from '@/db/control-repositories'
import { hashPassword } from '@/auth/password'
import { runWithTenant, type TenantContext } from '@/tenancy/context'
import { templates } from '@/db/repositories'
import { createDefaultTemplate } from '@/templates/types'
import { createImport, ingestFiles, type IncomingFile } from '@/import/import-service'
import { tenantTmpDir } from '@/storage/media-store'

export interface LoadTestTenant {
  tenantId: string
  userId: string
  name: string
  templateId: string
  email: string
  /** Set once at creation, never rotated — good enough to log in for the web scenarios' HTTP session; this is throwaway load-test data, never a real account. */
  password: string
}

let tenantCounter = 0

export async function createLoadTestTenant(
  name: string,
  quotaOverrides?: Partial<{ maxQueuedJobs: number; maxImagesPerBatch: number; weight: number }>
): Promise<LoadTestTenant> {
  tenantCounter++
  const email = `loadtest-${tenantCounter}-${Date.now()}@loadtest.local`
  const { tenantId, userId } = await createTenantAndFirstUser({ tenantName: name, email }, { userId: null })

  // createTenantAndFirstUser always forces a change-password flow (the real
  // admin-console/lockout-recovery behavior, correctly) — middleware.ts
  // blocks every route except /settings and the change-password endpoint
  // itself while that flag is set. The web scenarios need this tenant's
  // session to call ordinary API routes (products, imports, vision/status),
  // so the load test sets its own known password directly and clears the
  // flag immediately, skipping the HTTP change-password round trip rather
  // than simulating a first-login flow this script has no interest in
  // measuring.
  const password = 'Loadtest-Tenant-Password-1'
  users.setPasswordHash(userId, await hashPassword(password), false)

  if (quotaOverrides) {
    quotaRepo.update(tenantId, quotaOverrides)
    // The scheduler reads its own denormalized copy of weight
    // (tenant_queue_state), not quotas.weight directly — see
    // control-repositories.ts's doc comment on quotas.update(). Both must
    // be kept in sync, same as admin-service.ts's updateTenantQuotas does.
    if (quotaOverrides.weight != null) {
      tenantQueueState.setWeight(tenantId, quotaOverrides.weight)
    }
  }

  const ctx: TenantContext = { tenantId, userId, role: 'owner' }
  const templateId = runWithTenant(ctx, () => {
    const t = templates.create({ name: `${name} template`, document: createDefaultTemplate('4:5') })
    return t.id
  })

  return { tenantId, userId, name, templateId, email, password }
}

/**
 * ~50 distinct, real, decodable JPEGs — generated once per load-test run
 * into a scratch directory, never the real data/ dir (see the script's own
 * VISION_STUDIO_DATA_DIR isolation).
 *
 * A soft gradient with a little noise mixed in — NOT pure random noise.
 * Pure per-pixel random noise is close to JPEG's worst case (every 8x8
 * block is high-frequency, so DCT compression barely helps), producing
 * files several times larger than a real product photo at the same
 * resolution; a load test measuring upload/body-size behavior needs file
 * sizes in the right ballpark, not technically-valid-but-wildly-
 * unrepresentative ones. Real mode's vision analysis still runs its full
 * real pipeline end to end (decode, detect, land on "nothing found" for a
 * gradient) — content realism was never what these fixtures are for.
 */
export async function generateFixturePhotos(dir: string, count: number): Promise<string[]> {
  await fsp.mkdir(dir, { recursive: true })
  const paths: string[] = []
  for (let i = 0; i < count; i++) {
    const width = 1200 + Math.floor(Math.random() * 400)
    const height = 1600 + Math.floor(Math.random() * 400)
    const buffer = Buffer.alloc(width * height * 3)
    const rBase = Math.floor(Math.random() * 256)
    const gBase = Math.floor(Math.random() * 256)
    const bBase = Math.floor(Math.random() * 256)
    for (let y = 0; y < height; y++) {
      const rowShade = Math.floor((y / height) * 60) - 30 // smooth vertical gradient
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 3
        const jitter = (Math.random() * 10) | 0 // a little grain, not full entropy
        buffer[idx] = Math.max(0, Math.min(255, rBase + rowShade + jitter))
        buffer[idx + 1] = Math.max(0, Math.min(255, gBase + rowShade + jitter))
        buffer[idx + 2] = Math.max(0, Math.min(255, bBase + rowShade + jitter))
      }
    }
    const filePath = path.join(dir, `fixture-${i}.jpg`)
    await sharp(buffer, { raw: { width, height, channels: 3 } }).jpeg({ quality: 85 }).toFile(filePath)
    paths.push(filePath)
  }
  return paths
}

/**
 * Imports `count` fixture photos (cycling through `fixturePaths`) into a
 * fresh import for `tenant`, via the exact `ingestFiles` entry point the
 * real upload route uses — this is what actually enqueues real `vision`
 * jobs onto the real queue.
 *
 * `count` routinely exceeds `fixturePaths.length` (e.g. 500 jobs from ~50
 * base photos) — each copy gets a small amount of unique embedded metadata
 * so its `sourceHash` differs from every other copy of the same base photo.
 * Without that, the app's own (correct, real) per-tenant vision-analysis
 * dedup would collapse most of a scenario's intended queue depth down to
 * just `fixturePaths.length` real jobs, undermining anything measuring
 * queue depth or fairness under a genuinely large backlog.
 */
export async function importFixturePhotos(
  tenant: LoadTestTenant,
  fixturePaths: string[],
  count: number
): Promise<{ importId: string; imagesImported: number }> {
  const ctx: TenantContext = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }

  return runWithTenant(ctx, async () => {
    const imp = createImport(`${tenant.name}-import-${Date.now()}`, undefined, count)
    const tmpDir = tenantTmpDir()
    await fsp.mkdir(tmpDir, { recursive: true })

    const incoming: IncomingFile[] = []
    for (let i = 0; i < count; i++) {
      const source = fixturePaths[i % fixturePaths.length]
      const tempPath = path.join(tmpDir, `loadtest-${tenant.tenantId}-${i}-${crypto.randomBytes(4).toString('hex')}.jpg`)
      const original = await fsp.readFile(source)
      // JPEG decoders ignore bytes after the EOF marker (0xFFD9) — appending
      // a unique marker there keeps the file a valid, decodable JPEG (same
      // pixels, same dimensions) while giving it a unique sourceHash.
      const bytes = Buffer.concat([original, Buffer.from(`\n<!-- loadtest-unique:${tenant.tenantId}:${i}:${crypto.randomBytes(8).toString('hex')} -->`)])
      await fsp.writeFile(tempPath, bytes)
      incoming.push({
        relativePath: `loadtest/product-${i}/photo.jpg`,
        fileName: `photo-${i}.jpg`,
        mimeType: 'image/jpeg',
        tempPath,
        sourceHash: crypto.createHash('sha256').update(bytes).digest('hex'),
        byteSize: bytes.length,
      })
    }

    const results = await ingestFiles(imp.id, incoming)
    const imagesImported = results.filter(r => r.outcome.status === 'imported').length
    return { importId: imp.id, imagesImported }
  })
}

export function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}
