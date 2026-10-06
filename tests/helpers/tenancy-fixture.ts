import './tenant-env'

import { getControlDb, openTenantDbById, type Db } from '@/db/client'
import { migrate, migrateControl } from '@/db/migrate'
import { tenants, users, memberships } from '@/db/control-repositories'
import { createSession } from '@/auth/session'
import { ensureMediaRoots } from '@/storage/media-store'
import { config } from '@/config'

export interface TestTenant {
  tenantId: string
  userId: string
  sessionToken: string
  db: Db
}

let controlMigrated = false

/**
 * Creates one fully-usable tenant: control-plane rows (tenant, user,
 * membership), a migrated app.db, media directories on disk, and a live
 * session token — everything a test needs to act as that tenant, either by
 * calling repository functions directly inside `runWithTenant` or by
 * building an authenticated `NextRequest` with its cookie (see
 * `tests/helpers/request.ts`).
 */
export function createTestTenant(name: string): TestTenant {
  if (!controlMigrated) {
    migrateControl(getControlDb())
    controlMigrated = true
  }

  const tenant = tenants.create(name)
  ensureMediaRoots(tenant.id)
  const db = openTenantDbById(tenant.id)
  migrate(db)

  const user = users.create({
    email: `${tenant.id}@test.local`,
    // Never verified in these tests — fixtures authenticate via a session
    // token (createSession below), the same way an already-logged-in
    // browser would, not by re-running the password check.
    passwordHash: 'unused-in-tests',
  })
  memberships.create(user.id, tenant.id, 'owner')
  const { token } = createSession(user.id)

  return { tenantId: tenant.id, userId: user.id, sessionToken: token, db }
}

export function cookieHeader(token: string): string {
  return `${config.auth.sessionCookieName}=${token}`
}
