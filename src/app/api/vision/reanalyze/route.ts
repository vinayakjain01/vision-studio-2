/**
 * Re-queue analysis.
 *
 * Three scopes, narrowest first: one image, one import, or everything not
 * `ready`. The common case is installing the models after an import, which
 * leaves every image at `unavailable`. `force: true` also re-analyses images
 * that succeeded, for a deliberate refresh after an engine-version bump.
 */

import { NextRequest } from 'next/server'
import { reanalyzeAllPending, reanalyzeImport } from '@/import/import-service'
import { images } from '@/db/repositories'
import { enqueue } from '@/jobs/queue'
import { ensurePoolRunning } from '@/jobs/pool'
import { handler, ok, notFound } from '@/lib/api'

export const dynamic = 'force-dynamic'

export const POST = handler(async (request: NextRequest) => {
  const body = await request.json().catch(() => ({}))
  const force = body?.force === true

  if (typeof body?.imageId === 'string') {
    const image = images.get(body.imageId)
    if (!image) return notFound('image not found')

    images.setVisionStatus(image.id, 'pending')
    const { inserted } = enqueue([
      {
        kind: 'vision',
        payload: {
          imageId: image.id,
          sourceHash: image.sourceHash,
          storageKey: image.storageKey,
          force,
        },
        // Ahead of a bulk sweep: someone is watching this one image.
        priority: 1,
        // A forced re-run must not be collapsed into a pending non-forced job
        // for the same content, or it would silently return the cached result.
        dedupeKey: `vision:${image.sourceHash}${force ? ':force' : ''}`,
      },
    ])

    if (inserted > 0) ensurePoolRunning()
    return ok({ queued: inserted })
  }

  const queued =
    typeof body?.importId === 'string'
      ? reanalyzeImport(body.importId, force)
      : reanalyzeAllPending()

  return ok({ queued })
})
