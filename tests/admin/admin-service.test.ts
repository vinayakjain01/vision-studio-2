import crypto from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import { createTestTenant } from '../helpers/tenancy-fixture'
import { runWithTenant } from '@/tenancy/context'
import { getControlDb } from '@/db/client'
import { migrateControl } from '@/db/migrate'
import { users, sessions, quotas, tenantQueueState, auditLog, tenants } from '@/db/control-repositories'
import { createSession, resolveSession } from '@/auth/session'
import { attemptLogin } from '@/auth/login'
import { verifyPassword } from '@/auth/password'
import * as queue from '@/jobs/queue'
import {
  createTenantAndFirstUser,
  suspendTenant,
  resumeTenant,
  updateTenantQuotas,
  resetUserPassword,
  markTenantPendingDeletion,
  cancelPendingDeletion,
  purgeTenant,
  AdminActionError,
} from '@/services/admin-service'

// `audit_log.actor_user_id` is a real FK (ON DELETE SET NULL) — every
// action under test needs a genuine `users` row to attribute itself to, not
// an arbitrary string. Recreated in `beforeEach` since that hook wipes the
// `users` table along with everything else.
let ACTOR: { userId: string }

describe('admin-service', () => {
  // claim() scans across every tenant in control.db — leftover jobs/tenants
  // from an earlier test in this file would bleed into the next one's
  // claim() calls (same gotcha documented in tests/jobs/queue.test.ts).
  beforeEach(() => {
    const db = getControlDb()
    migrateControl(db)
    db.exec('DELETE FROM jobs')
    db.exec('DELETE FROM tenant_queue_state')
    db.exec('DELETE FROM ai_extend_tenant_state')
    db.exec('DELETE FROM usage_counters')
    db.exec('DELETE FROM quotas')
    db.exec('DELETE FROM memberships')
    db.exec('DELETE FROM sessions')
    db.exec('DELETE FROM users')
    db.exec('DELETE FROM tenants')
    db.exec('DELETE FROM audit_log')

    const actorUser = users.create({ email: 'admin-actor@test.local', passwordHash: 'unused', isPlatformAdmin: true })
    ACTOR = { userId: actorUser.id }
  })

  describe('createTenantAndFirstUser', () => {
    it('creates a tenant, an owner user with a temp password, and forces a change at next login', async () => {
      const result = await createTenantAndFirstUser(
        { tenantName: 'New Co', email: 'owner@newco.test' },
        ACTOR
      )
      expect(result.tempPassword).toHaveLength(16)

      const user = users.get(result.userId)!
      expect(user.mustChangePassword).toBe(true)
      expect(await verifyPassword(user.passwordHash, result.tempPassword)).toBe(true)

      const login = await attemptLogin('owner@newco.test', result.tempPassword, '127.0.0.1')
      expect(login.ok).toBe(true)
      expect(login.ok && login.mustChangePassword).toBe(true)

      const entries = auditLog.list({ action: 'admin_create_tenant' })
      expect(entries).toHaveLength(1)
      expect(entries[0].tenantId).toBe(result.tenantId)
    })

    it('provisions a real, usable app.db and media directories — not just the control-plane row (regression)', async () => {
      // A real bug, found by hand after P5: tenants.create() only inserts
      // control-plane rows (tenants/quotas/tenant_queue_state); it does
      // nothing to the new tenant's own app.db or media directories, which
      // every tenant-scoped page/query assumes already exist. Without
      // provisioning them here, the very first page a brand-new tenant's
      // owner loads throws "no such table: images".
      const result = await createTenantAndFirstUser(
        { tenantName: 'Provisioned Co', email: 'owner@provisioned.test' },
        ACTOR
      )

      const counts = await runWithTenant(
        { tenantId: result.tenantId, userId: result.userId, role: 'owner' },
        async () => {
          const { images } = await import('@/db/repositories')
          return images.statusCounts()
        }
      )
      expect(counts).toEqual({ pending: 0, processing: 0, ready: 0, failed: 0, unavailable: 0 })
    })

    it('rejects creating a user for an email that already exists', async () => {
      await createTenantAndFirstUser({ tenantName: 'A', email: 'dup@test.local' }, ACTOR)
      await expect(
        createTenantAndFirstUser({ tenantName: 'B', email: 'dup@test.local' }, ACTOR)
      ).rejects.toThrow(AdminActionError)
    })
  })

  describe('suspend / resume', () => {
    it('blocks login, revokes every session for the tenant, and the scheduler never claims its jobs — resume reverses all three', async () => {
      const tenant = createTestTenant('SuspendMe')
      const hash = await import('@/auth/password').then(m => m.hashPassword('CorrectHorse1'))
      users.setPasswordHash(tenant.userId, hash)
      const secondSession = createSession(tenant.userId)

      await runWithTenant({ tenantId: tenant.tenantId, userId: tenant.userId, role: 'owner' }, () => {
        queue.enqueue(tenant.tenantId, [
          { kind: 'vision', payload: { imageId: 'i1', sourceHash: 'h1', storageKey: 'k1' } },
        ])
      })

      suspendTenant(tenant.tenantId, ACTOR)

      // 1. Login is blocked.
      const login = await attemptLogin(`${tenant.tenantId}@test.local`, 'CorrectHorse1', '127.0.0.1')
      expect(login.ok).toBe(false)

      // 2. Every session for the tenant is revoked.
      const row = sessions.findByTokenHash(
        crypto.createHash('sha256').update(secondSession.token).digest('hex')
      )
      expect(row?.revokedAt).not.toBeNull()

      // 3. The scheduler never claims its jobs while suspended.
      expect(queue.claim('vision', 'w1')).toBeNull()

      // Audit entry recorded.
      expect(auditLog.list({ action: 'admin_suspend_tenant', tenantId: tenant.tenantId })).toHaveLength(1)

      // Resume reverses it.
      resumeTenant(tenant.tenantId, ACTOR)
      const claimed = queue.claim('vision', 'w1')
      expect(claimed).not.toBeNull()
      expect(claimed!.tenantId).toBe(tenant.tenantId)
      expect(auditLog.list({ action: 'admin_resume_tenant', tenantId: tenant.tenantId })).toHaveLength(1)
    })

    it('resolveSession rejects a still-unrevoked session the instant its tenant is marked suspended (defense in depth)', () => {
      const tenant = createTestTenant('SuspendDefenseInDepth')
      const session = createSession(tenant.userId)
      expect(resolveSession(session.token)).not.toBeNull()

      // Bypasses suspendTenant()'s own session revocation on purpose, to
      // isolate resolveSession's OWN independent check — see its doc
      // comment on why this exists as a second gate, not a replacement for
      // revocation.
      tenants.setStatus(tenant.tenantId, 'suspended')
      expect(resolveSession(session.token)).toBeNull()
    })
  })

  describe('updateTenantQuotas', () => {
    it('takes effect on the very next enqueue (quota) and claim (weight) — no caching', async () => {
      const tenant = createTestTenant('QuotaLive')

      // Lower the queued-job limit to 1, then try to enqueue 2 — must fail now.
      updateTenantQuotas(tenant.tenantId, { maxQueuedJobs: 1 }, ACTOR)
      const { assertCanEnqueue } = await import('@/jobs/quota')
      expect(() => assertCanEnqueue(tenant.tenantId, 2)).toThrow()

      // Raise it back up — must succeed immediately, no restart/cache-bust needed.
      updateTenantQuotas(tenant.tenantId, { maxQueuedJobs: 10 }, ACTOR)
      expect(() => assertCanEnqueue(tenant.tenantId, 2)).not.toThrow()

      // Weight change propagates to the scheduler's own working copy.
      updateTenantQuotas(tenant.tenantId, { weight: 5 }, ACTOR)
      expect(tenantQueueState.get(tenant.tenantId)?.weight).toBe(5)
      expect(quotas.get(tenant.tenantId)?.weight).toBe(5)

      expect(auditLog.list({ action: 'admin_update_quotas', tenantId: tenant.tenantId }).length).toBeGreaterThan(0)
    })
  })

  describe('resetUserPassword', () => {
    it('generates a temp password, revokes sessions, and forces a change at next login', async () => {
      const tenant = createTestTenant('ResetPw')
      const originalSession = createSession(tenant.userId)

      const result = await resetUserPassword(tenant.userId, ACTOR)
      expect(result.tempPassword).toHaveLength(16)

      const user = users.get(tenant.userId)!
      expect(user.mustChangePassword).toBe(true)

      const row = sessions.findByTokenHash(
        crypto.createHash('sha256').update(originalSession.token).digest('hex')
      )
      expect(row?.revokedAt).not.toBeNull()

      expect(auditLog.list({ action: 'admin_reset_password' })).toHaveLength(1)
      // The password itself must never be in the audit detail.
      const detailJson = JSON.stringify(auditLog.list({ action: 'admin_reset_password' })[0].detail)
      expect(detailJson).not.toContain(result.tempPassword)
    })
  })

  describe('tenant deletion (two-step)', () => {
    it('requires pending_deletion status and an exact name match before purging', async () => {
      const tenant = createTestTenant('DeleteMe')

      await expect(purgeTenant(tenant.tenantId, 'DeleteMe', ACTOR)).rejects.toThrow(
        'must be marked pending deletion'
      )

      markTenantPendingDeletion(tenant.tenantId, ACTOR)
      expect(tenants.get(tenant.tenantId)?.status).toBe('pending_deletion')

      await expect(purgeTenant(tenant.tenantId, 'wrong name', ACTOR)).rejects.toThrow(
        'confirmation name does not match'
      )

      await purgeTenant(tenant.tenantId, 'DeleteMe', ACTOR)
      expect(tenants.get(tenant.tenantId)).toBeNull()

      // Cascaded away along with the tenant row.
      expect(quotas.get(tenant.tenantId)).toBeNull()

      // Audit trail survives the tenant's own deletion (ON DELETE SET NULL).
      const entries = auditLog.list({ action: 'admin_purge_tenant' })
      expect(entries).toHaveLength(1)
      expect(entries[0].tenantId).toBeNull()
      expect((entries[0].detail as any).name).toBe('DeleteMe')
    })

    it('cancelPendingDeletion reverses the mark without purging', async () => {
      const tenant = createTestTenant('ChangedMyMind')
      markTenantPendingDeletion(tenant.tenantId, ACTOR)
      cancelPendingDeletion(tenant.tenantId, ACTOR)
      expect(tenants.get(tenant.tenantId)?.status).toBe('active')
    })
  })
})
