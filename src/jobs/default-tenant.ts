/**
 * P1 bridge: workers run against ONE tenant until P3 builds the real global
 * queue + per-job tenant binding (see docs/MULTI_TENANCY.md §3.3 — worker
 * processes can't inherit `TenantContext` across the process boundary, so
 * each one binds its own context explicitly; P1 has nothing per-job to bind
 * yet, since the job queue itself is still per-tenant, not global).
 *
 * This is deliberately narrow and deliberately temporary: it picks the
 * single tenant legacy migration creates and nothing else, and throws
 * plainly if zero or more than one tenant exists, rather than guessing.
 * Multi-tenant installs cannot use the worker pool correctly until P3 lands
 * — that's the whole point of P3 existing as its own phase.
 */

import { tenants } from '@/db/control-repositories'

let cachedTenantId: string | null = null

export function resolveDefaultTenantId(): string {
  if (cachedTenantId) return cachedTenantId

  const list = tenants.list()
  if (list.length === 0) {
    throw new Error(
      'No tenant exists yet — run `npm run tenants:migrate-legacy` (or create one) before ' +
        'starting the worker pool.'
    )
  }
  if (list.length > 1) {
    throw new Error(
      `${list.length} tenants exist, but the worker pool is still single-tenant until P3 ` +
        '(see docs/MULTI_TENANCY.md). Refusing to guess which one to run jobs against.'
    )
  }

  cachedTenantId = list[0].id
  return cachedTenantId
}
