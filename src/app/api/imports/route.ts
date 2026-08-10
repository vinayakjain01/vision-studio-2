/**
 * Import sessions: list and create.
 *
 * Creating an import opens a session; files are then POSTed in batches to
 * `/api/imports/[importId]/files`, and `PATCH` on the same path finalises it.
 * Split that way because a folder import is thousands of files and tens of
 * gigabytes — one request would exceed every body limit and give no progress.
 */

import { NextRequest } from 'next/server'
import { imports } from '@/db/repositories'
import { createImport } from '@/import/import-service'
import { handler, ok, badRequest } from '@/lib/api'

export const dynamic = 'force-dynamic'

export const GET = handler(async () => {
  return ok({ imports: imports.list(50) })
})

export const POST = handler(async (request: NextRequest) => {
  const body = await request.json().catch(() => null)
  const name = typeof body?.name === 'string' ? body.name.trim() : ''

  if (!name) return badRequest('name is required')

  const record = createImport(
    name,
    typeof body?.rootPath === 'string' ? body.rootPath : undefined,
    typeof body?.totalFiles === 'number' ? body.totalFiles : 0
  )

  return ok({ import: record }, { status: 201 })
})
