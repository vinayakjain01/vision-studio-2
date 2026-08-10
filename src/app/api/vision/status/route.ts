/**
 * Vision engine readiness, queue depth and analysis coverage.
 *
 * Polled by the nav pill and the import page. The point is that an operator
 * learns the parsing model is missing BEFORE importing four thousand images,
 * not from four thousand analyses reporting `unknown` garment data.
 */

import { getVisionStatus } from '@/services/vision-service'
import { images } from '@/db/repositories'
import * as queue from '@/jobs/queue'
import { getPool } from '@/jobs/pool'
import { MODEL_LIST } from '@/vision/model-registry'
import { config } from '@/config'
import fs from 'fs'
import path from 'path'
import { handler, ok } from '@/lib/api'

export const dynamic = 'force-dynamic'

export const GET = handler(async () => {
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

  return ok({
    engine: status,
    models,
    images: { total, ...counts },
    queue: {
      vision: queue.stats('vision'),
      render: queue.stats('render'),
    },
    pool: getPool().status(),
  })
})
