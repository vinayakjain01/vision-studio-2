import type { SeededResources } from '../helpers/seed-resources'

export type ResourceKind = 'product' | 'image' | 'template' | 'rule' | 'batch' | 'creative' | 'import'

/** Maps a resource kind to the ID `seedResources()` produced for it. */
export function resourceId(resources: SeededResources, kind: ResourceKind): string {
  const map: Record<ResourceKind, string> = {
    product: resources.productId,
    image: resources.imageId,
    template: resources.templateId,
    rule: resources.ruleId,
    batch: resources.batchId,
    creative: resources.creativeId,
    import: resources.importId,
  }
  return map[kind]
}

export interface PathResourceCheck {
  /** Dynamic segment name, e.g. `productId`. */
  param: string
  resource: ResourceKind
  methods: string[]
}

export interface BodyResourceCheck {
  method: string
  /** JSON body field carrying the ID. */
  field: string
  resource: ResourceKind
  /** Extra body fields required to get past earlier validation before the ownership check runs. */
  extraBody?: Record<string, unknown>
}

export interface RouteEntry {
  routePath: string
  methods: string[]
  /** No auth/tenant check at all — must stay reachable with no session. */
  public?: boolean
  /** A GET that returns a tenant-scoped collection; checked for cross-tenant leakage. */
  listResource?: ResourceKind
  /** A dynamic `[param]` segment naming one specific resource. */
  pathResource?: PathResourceCheck
  /** A resource ID read from the JSON body instead of the path. */
  bodyResources?: BodyResourceCheck[]
  /** Why this route has no per-ID ownership check, when that's deliberate. */
  note: string
}

/**
 * The isolation matrix. `route-coverage.test.ts` fails if a route exists on
 * disk (per `route-inventory.ts`) that isn't listed here, or vice versa —
 * this file cannot silently fall out of date with the actual route tree.
 */
export const ROUTE_MANIFEST: RouteEntry[] = [
  { routePath: '/api/health', methods: ['GET'], public: true, note: 'health check, no auth by design' },
  { routePath: '/api/auth/login', methods: ['POST'], public: true, note: 'establishes the session itself' },
  {
    routePath: '/api/auth/logout',
    methods: ['POST'],
    public: true,
    note: 'must clear the cookie even for an already-expired/foreign session (see middleware.ts PUBLIC_PATHS comment)',
  },
  {
    routePath: '/api/auth/change-password',
    methods: ['POST'],
    note: 'operates only on the CALLING session\'s own user (resolveSession\'s userId), never an id from the request — no cross-tenant/cross-user surface to probe',
  },

  {
    routePath: '/api/products',
    methods: ['GET'],
    listResource: 'product',
    note: 'list scoped by getDb(); checked for cross-tenant leakage',
  },
  {
    routePath: '/api/products/[productId]',
    methods: ['GET'],
    pathResource: { param: 'productId', resource: 'product', methods: ['GET'] },
    note: '',
  },
  {
    routePath: '/api/products/[productId]/delete',
    methods: ['POST'],
    pathResource: { param: 'productId', resource: 'product', methods: ['POST'] },
    note: '',
  },
  {
    routePath: '/api/products/[productId]/shot-type-override',
    methods: ['POST'],
    pathResource: { param: 'productId', resource: 'product', methods: ['POST'] },
    note: '',
  },

  { routePath: '/api/templates', methods: ['GET', 'POST'], listResource: 'template', note: 'POST is create-only, no ID to check' },
  {
    routePath: '/api/templates/[templateId]',
    methods: ['GET', 'PATCH', 'DELETE'],
    pathResource: { param: 'templateId', resource: 'template', methods: ['GET', 'PATCH', 'DELETE'] },
    note: '',
  },

  { routePath: '/api/rules', methods: ['GET', 'POST'], listResource: 'rule', note: 'POST is create-only, no ID to check' },
  {
    routePath: '/api/rules/[ruleId]',
    methods: ['PATCH', 'DELETE'],
    pathResource: { param: 'ruleId', resource: 'rule', methods: ['PATCH', 'DELETE'] },
    note: '',
  },

  { routePath: '/api/batches', methods: ['GET'], listResource: 'batch', note: '' },
  {
    routePath: '/api/batches/[batchId]',
    methods: ['GET', 'PATCH'],
    pathResource: { param: 'batchId', resource: 'batch', methods: ['GET', 'PATCH'] },
    note: '',
  },
  {
    routePath: '/api/batches/[batchId]/delete',
    methods: ['POST'],
    pathResource: { param: 'batchId', resource: 'batch', methods: ['POST'] },
    note: '',
  },

  { routePath: '/api/creatives', methods: ['GET'], listResource: 'creative', note: '' },
  {
    routePath: '/api/creatives/[creativeId]',
    methods: ['DELETE'],
    pathResource: { param: 'creativeId', resource: 'creative', methods: ['DELETE'] },
    note: '',
  },
  {
    routePath: '/api/creatives/[creativeId]/export',
    methods: ['GET'],
    pathResource: { param: 'creativeId', resource: 'creative', methods: ['GET'] },
    note: '',
  },
  {
    routePath: '/api/creatives/download',
    methods: ['GET'],
    note:
      'ID is a `?batchId=`/`?productId=` query filter on a LIST query (creatives.listByBatch/listByProduct), ' +
      "not a single-resource fetch — another tenant's ID matches zero rows in this tenant's own DB and the " +
      "route returns 400 \"there are no creatives to download\" rather than 404. Covered by a dedicated test " +
      '(route-cross-tenant.test.ts) asserting that specific, intentionally-different status rather than folded ' +
      'into the generic 404 check — still produces an identical response for "wrong tenant" and "nonexistent ID", ' +
      'which is the actual isolation property that matters; the status code just differs from the other routes.',
  },

  {
    routePath: '/api/imports',
    methods: ['GET', 'POST'],
    listResource: 'import',
    note: 'POST is create-only, no ID to check',
  },
  {
    routePath: '/api/imports/[importId]',
    methods: ['GET', 'PATCH', 'DELETE'],
    pathResource: { param: 'importId', resource: 'import', methods: ['GET', 'PATCH', 'DELETE'] },
    note: '',
  },
  {
    routePath: '/api/imports/[importId]/files',
    methods: ['POST'],
    pathResource: { param: 'importId', resource: 'import', methods: ['POST'] },
    note: 'ownership check (imports.get) happens before multipart body parsing, so no file payload is needed to reach it',
  },

  {
    routePath: '/api/render',
    methods: ['POST'],
    bodyResources: [{ method: 'POST', field: 'imageId', resource: 'image' }],
    note: '',
  },
  {
    routePath: '/api/vision/reanalyze',
    methods: ['POST'],
    bodyResources: [{ method: 'POST', field: 'imageId', resource: 'image' }],
    note: 'only the single-image branch is ID-scoped; the bulk branches (no imageId) operate over the caller\'s own tenant by construction',
  },
  {
    routePath: '/api/vision/status',
    methods: ['GET'],
    note: 'model/readiness status plus this tenant\'s own queue depth (explicitly tenant-scoped against the global control.db jobs table, P4) — no ID param to probe cross-tenant with, so only needs the baseline auth-required check',
  },
  {
    routePath: '/api/ai-extend/status',
    methods: ['GET'],
    note: 'reports whether Cloudinary env vars are configured — global config, not tenant data; baseline auth-required check only',
  },
  {
    routePath: '/api/preview/subjects',
    methods: ['GET'],
    listResource: 'image',
    note: 'reads via images.listByStatus(), already tenant-scoped at the query; optional ?imageId/?productId are soft hints, not a lookup that can 404',
  },
  {
    routePath: '/api/storage/sweep',
    methods: ['GET', 'POST'],
    note:
      'reports/sweeps this tenant\'s own media roots only (media-store.ts\'s roots() is tenant-scoped) — no ' +
      'cross-tenant ID surface exists to test; baseline auth-required check only',
  },
  {
    routePath: '/api/generate',
    methods: ['POST'],
    note:
      'dryRun planning over a scope (optionally productIds/importId/templateId) rather than a single-resource ' +
      "fetch — another tenant's ID simply matches nothing in this tenant's own DB query, producing an empty " +
      'plan rather than a 404. Covered by a dedicated test asserting a plan scoped to another tenant\'s productId ' +
      'matches zero products, not folded into the generic 404 matrix.',
  },

  {
    routePath: '/api/media/[root]/[...key]',
    methods: ['GET'],
    note:
      'covered by its own dedicated suite (media-cross-tenant.test.ts) rather than the generic path-param ' +
      'matrix: the "resource" is a storage key, not a DB row ID, and the route also needs path-traversal ' +
      'coverage the generic matrix does not express.',
  },

  // ── Admin (P5) ──────────────────────────────────────────────────────────
  // None of these take a "resource owned by the caller's tenant" ID the way
  // the generic matrix above checks — an admin operates ACROSS tenants by
  // design (a `tenantId` in the path here names the tenant being
  // administered, not the caller's own). The property that actually matters
  // — a regular tenant user, an anonymous caller, or a forged session
  // cannot reach ANY of these at all — is covered by its own dedicated
  // suite, tests/isolation/admin-isolation.test.ts, not the per-ID matrix.
  {
    routePath: '/api/admin/tenants',
    methods: ['GET', 'POST'],
    note: 'platform-admin only; covered by admin-isolation.test.ts, not the per-ID matrix (see section comment above)',
  },
  {
    routePath: '/api/admin/tenants/[tenantId]',
    methods: ['PATCH', 'DELETE'],
    note: 'platform-admin only; covered by admin-isolation.test.ts, not the per-ID matrix (see section comment above)',
  },
  {
    routePath: '/api/admin/users/[userId]/reset-password',
    methods: ['POST'],
    note: 'platform-admin only; covered by admin-isolation.test.ts, not the per-ID matrix (see section comment above)',
  },
  {
    routePath: '/api/admin/global',
    methods: ['GET'],
    note: 'platform-admin only; covered by admin-isolation.test.ts, not the per-ID matrix (see section comment above)',
  },
  {
    routePath: '/api/admin/audit-log',
    methods: ['GET'],
    note: 'platform-admin only; covered by admin-isolation.test.ts, not the per-ID matrix (see section comment above)',
  },
  {
    routePath: '/api/admin/diag',
    methods: ['GET'],
    note: 'platform-admin only; counts/sizes/timings only (same privacy boundary as /api/admin/global), covered by admin-isolation.test.ts, not the per-ID matrix (see section comment above)',
  },
]
