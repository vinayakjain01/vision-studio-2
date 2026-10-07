/**
 * Vision engine readiness, queue depth and analysis coverage.
 *
 * Polled by the nav pill and the import page. The point is that an operator
 * learns the parsing model is missing BEFORE importing four thousand images,
 * not from four thousand analyses reporting `unknown` garment data.
 */

import { NextRequest } from 'next/server'
import { getVisionStatus } from '@/services/vision-service'
import { images } from '@/db/repositories'
import * as queue from '@/jobs/queue'
import { getPool } from '@/jobs/pool'
import { MODEL_LIST } from '@/vision/model-registry'
import { config } from '@/config'
import { currentTenant } from '@/tenancy/context'
import fs from 'fs'
import path from 'path'
import { handler, okWithEtag } from '@/lib/api-handler'

export const dynamic = 'force-dynamic'

export const GET = handler(async (request: NextRequest) => {
  const tenantId = currentTenant().tenantId
  const status = await getVisionStatus()
  const counts = images.statusCounts()
  const total = images.total()

  const models = MODEL_LIST.map(spec => {
    const file = path.join(config.paths.modelDir, spec.file)
    const present = fs.existsSync(file)
    return {
      id: spec.id,
      file: spec.file,
      version: spec.version,
      description: spec.description,
      required: spec.required,
      present,
      byteSize: spec.byteSize,
      license: spec.license,
    }
  })

  return okWithEtag(request, {
    engine: status,
    models,
    images: { total, ...counts },
    // Scoped to this tenant — `queue.stats()` reads the GLOBAL control.db
    // jobs table shared across every tenant (see P3's queue migration), so
    // calling it with no tenantId here would leak every OTHER tenant's
    // queue depth into this tenant's own settings page.
    queue: {
      vision: queue.stats('vision', tenantId),
      render: queue.stats('render', tenantId),
    },
    // Worker id/kind/state/pid only — process-level, not tenant data.
    pool: getPool().status(),
  })
})
