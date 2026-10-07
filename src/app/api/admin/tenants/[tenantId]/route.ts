/**
 * One tenant: suspend/resume, edit quotas, mark/cancel pending deletion
 * (PATCH), purge (DELETE). Platform-admin only.
 */

import { NextRequest } from 'next/server'
import { adminHandler } from '@/lib/admin-handler'
import { ok, badRequest } from '@/lib/api-handler'
import {
  suspendTenant,
  resumeTenant,
  updateTenantQuotas,
  markTenantPendingDeletion,
  cancelPendingDeletion,
  purgeTenant,
  AdminActionError,
} from '@/services/admin-service'

export const dynamic = 'force-dynamic'

export const PATCH = adminHandler(
  async (session, request: NextRequest, context: { params: Promise<{ tenantId: string }> }) => {
    const { tenantId } = await context.params
    const body = await request.json().catch(() => ({}))
    const actor = { userId: session.userId }

    try {
      switch (body?.action) {
        case 'suspend':
          suspendTenant(tenantId, actor)
          return ok({ ok: true })
        case 'resume':
          resumeTenant(tenantId, actor)
          return ok({ ok: true })
        case 'mark_pending_deletion':
          markTenantPendingDeletion(tenantId, actor)
          return ok({ ok: true })
        case 'cancel_pending_deletion':
          cancelPendingDeletion(tenantId, actor)
          return ok({ ok: true })
        case 'update_quotas':
          return ok(updateTenantQuotas(tenantId, body?.quotas ?? {}, actor))
        default:
          return badRequest(`unknown action: ${body?.action}`)
      }
    } catch (err) {
      if (err instanceof AdminActionError) return badRequest(err.message)
      throw err
    }
  }
)

export const DELETE = adminHandler(
  async (session, request: NextRequest, context: { params: Promise<{ tenantId: string }> }) => {
    const { tenantId } = await context.params
    const body = await request.json().catch(() => ({}))
    const confirmName = typeof body?.confirmName === 'string' ? body.confirmName : ''

    try {
      await purgeTenant(tenantId, confirmName, { userId: session.userId })
      return ok({ ok: true })
    } catch (err) {
      if (err instanceof AdminActionError) return badRequest(err.message)
      throw err
    }
  }
)
