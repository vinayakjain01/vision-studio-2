/**
 * Generation control plane.
 *
 * Turns "render this catalog" into a batch of render jobs, and reports on it
 * while it runs.
 *
 * ── Plan before enqueue ──────────────────────────────────────────────────────
 * `planBatch` resolves every product against the rules WITHOUT queuing anything,
 * so the operator sees the template split and the unmatched count first. The
 * mistake worth catching is a rule set that covers 300 of 4,000 products, and it
 * is much cheaper to catch before the renders than after.
 *
 * Server-only.
 */

import {
  batches,
  creatives,
  images,
  products,
  rules as rulesRepo,
  templates,
} from '@/db/repositories'
import { getUsableAnalysis } from './vision-service'
import { resolveTemplate, type RuleSubject } from '@/rules/resolver'
import { isShotTypeApplicable, shotTypeUniverse } from '@/framing/solver'
import * as queue from '@/jobs/queue'
import { ensurePoolRunning } from '@/jobs/pool'
import { config } from '@/config'
import type { BatchRecord, ImageRecord, ProductRecord } from '@/db/types'
import type { ShotType } from '@/vision/types'

/**
 * How many attempts a render job needs when its template uses `ai_extend`.
 *
 * Every attempt but the last one it actually needs is a deferred "not ready
 * yet" (see `BackgroundNotReadyError` in `src/jobs/worker.ts`), polled every
 * `queue.BACKGROUND_FILL_POLL_MS` — not a real failure — so this has to
 * outlast the SLOWEST plausible wait: one full `background_fill` job, timed
 * out at `INPAINT_TIMEOUT_MS`, plus however long it sits queued behind
 * whatever else is already using the inpaint worker slots. Doubling the
 * timeout covers that queueing delay without a separate estimate for it;
 * `config.jobs.maxAttempts` (a real failure's budget, typically 3) would
 * exhaust in under 15 seconds against a wait that can legitimately be
 * minutes in CPU test mode, which is why this is computed instead of reused.
 */
function renderMaxAttempts(templateId: string): number {
  const template = templates.get(templateId)
  if (template?.document.background.mode !== 'ai_extend') return config.jobs.maxAttempts

  const worstCaseWaitMs = config.inpaint.requestTimeoutMs * 2
  return Math.max(
    config.jobs.maxAttempts,
    Math.ceil(worstCaseWaitMs / queue.BACKGROUND_FILL_POLL_MS) + 5
  )
}

function describeShotTypes(types: ShotType[]): string {
  return types.map(t => t.replace(/_/g, ' ')).join(' or ')
}

export interface BatchScope {
  /** Restrict to one import. */
  importId?: string
  /** Restrict to one category. */
  category?: string
  /** Text match against product name or folder path — mirrors the Products
   *  page search box, so a bulk action can be scoped to whatever it shows. */
  search?: string
  /** Explicit product ids. Wins over the filters above. */
  productIds?: string[]
  /**
   * Render every image of each product, or only the primary one.
   * Primary-only is the common case: a catalog wants one hero creative per
   * product, not one per shot.
   */
  allImages?: boolean
  /** Bypass the rules and use this template for everything. */
  templateId?: string
  /**
   * Skip images whose analysis has not finished. On by default — rendering a
   * pending image produces a centred fit that silently differs from every
   * landmark-framed neighbour.
   */
  requireVision?: boolean
  /** Re-render images that already have a creative for the chosen template. */
  overwrite?: boolean
}

export interface BatchPlanItem {
  productId: string
  productName: string
  folderPath: string
  imageId: string
  fileName: string
  templateId: string | null
  templateName: string | null
  explanation: string
  visionReady: boolean
  /** Already rendered for this template. */
  existing: boolean
  /** False when the photo's detected shot type isn't one this template was built for. */
  shotCompatible: boolean
}

export interface BatchPlan {
  items: BatchPlanItem[]
  total: number
  renderable: number
  unmatched: number
  awaitingVision: number
  alreadyRendered: number
  /** Matched a template, but the photo's shot type isn't one it applies to. */
  incompatibleShot: number
  byTemplate: { templateId: string; templateName: string; count: number }[]
  warnings: string[]
}

function toSubject(product: ProductRecord, image: ImageRecord): RuleSubject {
  const { metadata } = getUsableAnalysis(image.sourceHash)
  return {
    productId: product.id,
    productName: product.name,
    folderPath: product.folderPath,
    category: product.category,
    importId: product.importId,
    shotType: metadata?.shot.type ?? null,
    garmentType: metadata?.garment.type ?? null,
  }
}

function collect(scope: BatchScope): { product: ProductRecord; image: ImageRecord }[] {
  const list: ProductRecord[] = scope.productIds?.length
    ? scope.productIds.map(id => products.get(id)).filter((p): p is ProductRecord => p !== null)
    : products.list({
        importId: scope.importId,
        category: scope.category,
        search: scope.search,
        limit: 100000,
      })

  const pairs: { product: ProductRecord; image: ImageRecord }[] = []

  for (const product of list) {
    const productImages = images.listByProduct(product.id)
    if (productImages.length === 0) continue

    if (scope.allImages) {
      for (const image of productImages) pairs.push({ product, image })
    } else {
      const primary =
        productImages.find(i => i.id === product.primaryImageId) ??
        productImages.find(i => i.isPrimary) ??
        productImages[0]
      pairs.push({ product, image: primary })
    }
  }

  return pairs
}

export function planBatch(scope: BatchScope): BatchPlan {
  const requireVision = scope.requireVision ?? true
  const pairs = collect(scope)
  const activeRules = rulesRepo.list({ activeOnly: true })
  const templateNames = new Map(templates.list().map(t => [t.id, t.name]))

  const items: BatchPlanItem[] = []
  const counts = new Map<string, number>()

  let unmatched = 0
  let awaitingVision = 0
  let alreadyRendered = 0
  let incompatibleShot = 0
  let renderable = 0

  for (const { product, image } of pairs) {
    const subject = toSubject(product, image)
    const visionReady = image.visionStatus === 'ready'

    let templateId: string | null
    let explanation: string

    if (scope.templateId) {
      templateId = scope.templateId
      explanation = 'Template chosen explicitly for this batch; rules were not consulted.'
    } else {
      const { match } = resolveTemplate(subject, activeRules)
      templateId = match?.templateId ?? null
      explanation = match?.explanation ?? 'No rule matched this product.'
    }

    const existing = templateId
      ? creatives.findByImageAndTemplate(image.id, templateId) !== null
      : false

    // A rule can match a product without the photo actually being the kind of
    // shot the chosen template's primary rule was built for — e.g. every
    // product in a folder routed to "Full body — editorial" regardless of
    // whether a given photo is a full-body shot or a neckline close-up. That
    // photo still renders — the template's own fallback chain always ends in
    // an anchor-free plain fit, precisely so every photo produces something —
    // this only flags it up front so the operator isn't surprised later by a
    // "fallback" badge in Downloads. Checked only once the photo has a real
    // classification; an unanalysed image is handled by `awaitingVision`
    // below instead.
    let shotCompatible = true
    if (templateId && subject.shotType) {
      const spec = templates.get(templateId)?.document.framing
      if (spec && !isShotTypeApplicable(subject.shotType, spec)) {
        shotCompatible = false
        explanation = `${explanation} — this template is for ${describeShotTypes(shotTypeUniverse(spec))} photos; this one is "${subject.shotType.replace(/_/g, ' ')}", so it will render as a plain resize instead of landmark framing.`
      }
    }

    if (!templateId) unmatched++
    if (!visionReady) awaitingVision++
    if (existing) alreadyRendered++
    if (templateId && visionReady && !shotCompatible) incompatibleShot++

    const willRender =
      templateId !== null && (visionReady || !requireVision) && (!existing || scope.overwrite === true)

    if (willRender) {
      renderable++
      counts.set(templateId!, (counts.get(templateId!) ?? 0) + 1)
    }

    items.push({
      productId: product.id,
      productName: product.name,
      folderPath: product.folderPath,
      imageId: image.id,
      fileName: image.fileName,
      templateId,
      templateName: templateId ? (templateNames.get(templateId) ?? null) : null,
      explanation,
      visionReady,
      existing,
      shotCompatible,
    })
  }

  const warnings: string[] = []
  if (unmatched > 0) {
    warnings.push(
      `${unmatched} of ${items.length} products match no rule and will be skipped. Add a catch-all rule to cover them.`
    )
  }
  if (awaitingVision > 0 && requireVision) {
    warnings.push(
      `${awaitingVision} images have not finished vision analysis and will be skipped. They will frame consistently once analysed.`
    )
  } else if (awaitingVision > 0) {
    warnings.push(
      `${awaitingVision} images have no analysis. They will render as a plain centred fit, not landmark framing.`
    )
  }
  if (incompatibleShot > 0) {
    warnings.push(
      `${incompatibleShot} photo${incompatibleShot === 1 ? ' is' : 's are'} a different kind of shot than their matched template's primary rule expects (e.g. a close-up instead of full-body). They will still render — as a plain resize rather than landmark framing — or route them to a more suitable template with a rule.`
    )
  }
  if (alreadyRendered > 0 && !scope.overwrite) {
    warnings.push(`${alreadyRendered} images already have a creative for their template and will be skipped.`)
  }
  if (activeRules.length === 0 && !scope.templateId) {
    warnings.push('No active rules exist. Create a rule, or pick a template for this batch.')
  }

  return {
    items,
    total: items.length,
    renderable,
    unmatched,
    awaitingVision,
    alreadyRendered,
    incompatibleShot,
    byTemplate: [...counts.entries()]
      .map(([templateId, count]) => ({
        templateId,
        templateName: templateNames.get(templateId) ?? templateId,
        count,
      }))
      .sort((a, b) => b.count - a.count),
    warnings,
  }
}

export interface StartBatchResult {
  batch: BatchRecord
  queued: number
  skipped: number
  plan: BatchPlan
}

export function startBatch(name: string, scope: BatchScope): StartBatchResult {
  const plan = planBatch(scope)
  const batch = batches.create(name)

  const renderable = plan.items.filter(
    item =>
      item.templateId !== null &&
      (item.visionReady || scope.requireVision === false) &&
      (!item.existing || scope.overwrite === true)
  )

  const { inserted } = queue.enqueue(
    renderable.map(item => ({
      kind: 'render' as const,
      batchId: batch.id,
      payload: {
        imageId: item.imageId,
        productId: item.productId,
        templateId: item.templateId!,
        sourceHash: images.get(item.imageId)?.sourceHash ?? '',
      },
      priority: 50,
      maxAttempts: renderMaxAttempts(item.templateId!),
      // Scoped to the batch so the same image+template can be re-rendered in a
      // later batch, while duplicates within one batch collapse.
      dedupeKey: `render:${batch.id}:${item.imageId}:${item.templateId}`,
    }))
  )

  batches.setTotal(batch.id, inserted)
  if (inserted > 0) {
    batches.setStatus(batch.id, 'running')
    ensurePoolRunning()
  } else {
    batches.setStatus(batch.id, 'completed')
  }

  return {
    batch: batches.get(batch.id)!,
    queued: inserted,
    skipped: plan.total - inserted,
    plan,
  }
}

// ─── Reporting ───────────────────────────────────────────────────────────────

export interface BatchProgress {
  batch: BatchRecord
  queue: queue.QueueStats
  /** 0–1. */
  progress: number
  /** Estimated seconds remaining. Null until enough jobs have finished to measure. */
  etaSeconds: number | null
  failures: { jobId: string; error: string; imageId: string | null }[]
}

export function getBatchProgress(batchId: string): BatchProgress | null {
  const batch = batches.refresh(batchId)
  if (!batch) return null

  const jobs = queue.listByBatch(batchId, { limit: 100000 })

  const stats: queue.QueueStats = {
    pending: 0,
    claimed: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  }
  for (const job of jobs) stats[job.status]++

  const finished = stats.completed + stats.failed + stats.cancelled
  const progress = jobs.length > 0 ? finished / jobs.length : 0

  return {
    batch,
    queue: stats,
    progress,
    etaSeconds: estimateEta(batch, jobs.length, finished),
    failures: jobs
      .filter(job => job.status === 'failed')
      .slice(0, 50)
      .map(job => ({
        jobId: job.id,
        error: job.error ?? 'unknown error',
        imageId: (job.payload as any)?.imageId ?? null,
      })),
  }
}

/**
 * Remaining time from observed throughput.
 *
 * Measured rather than assumed: render cost varies by an order of magnitude
 * with source resolution and canvas size, so a fixed per-image estimate is
 * wrong on most catalogs. Returns null below a handful of completions, where
 * the rate is too noisy to be worth showing.
 */
function estimateEta(batch: BatchRecord, total: number, finished: number): number | null {
  if (!batch.startedAt || finished < 5 || finished >= total) return null

  const elapsedMs = Date.now() - new Date(batch.startedAt).getTime()
  if (elapsedMs <= 0) return null

  const perJobMs = elapsedMs / finished
  return Math.round(((total - finished) * perJobMs) / 1000)
}

export function cancelBatch(batchId: string): { cancelled: number } {
  const cancelled = queue.cancelBatch(batchId)
  batches.setStatus(batchId, 'cancelled')
  batches.refresh(batchId)
  return { cancelled }
}

export function retryBatchFailures(batchId: string): { retried: number } {
  const retried = queue.retryBatch(batchId)
  if (retried > 0) {
    batches.setStatus(batchId, 'running')
    ensurePoolRunning()
  }
  batches.refresh(batchId)
  return { retried }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Render one image against one template, waiting for the result.
 *
 * For the product page's "generate this now" action, where the operator is
 * watching and a queue round trip reads as extra latency. It still goes
 * through the SAME job queue and worker pool as a bulk batch, though — an
 * earlier version called `handleRenderJob` directly in this process to skip
 * that round trip, which sounded like a reasonable shortcut but instead ran
 * the actual canvas compositing (a synchronous, CPU-bound native call that can
 * take several seconds on a large source image) inside the web server's own
 * request handler. Node has one thread for that: for the whole duration of
 * that render, the server could not respond to anything else either — not
 * unrelated API calls, not a page navigation, nothing. Enqueuing and polling
 * a cheap, indexed row instead keeps the heavy work in a worker process and
 * the main process free to keep serving everyone else while this waits.
 */
export async function renderOnce(
  imageId: string,
  templateId: string
): Promise<{ creativeId: string; storageKey: string }> {
  const image = images.get(imageId)
  if (!image) throw new Error('image not found')

  const { inserted, ids } = queue.enqueue([
    {
      kind: 'render',
      payload: {
        imageId,
        productId: image.productId,
        templateId,
        sourceHash: image.sourceHash,
      },
      // Ahead of any bulk batch already queued — someone is watching this one.
      priority: 0,
      batchId: null,
      dedupeKey: `render:adhoc:${imageId}:${templateId}`,
      maxAttempts: renderMaxAttempts(templateId),
    },
  ])
  ensurePoolRunning()

  const jobId = ids[0]
  if (inserted === 0 || !jobId) {
    throw new Error('A render for this photo and template is already in progress — try again in a moment.')
  }

  // 120s covers a plain render with room to spare. An `ai_extend` template
  // can legitimately need much longer — a real GPU generation plus whatever
  // it queued behind, or, in CPU test mode, minutes for one inference — so
  // the wait budget matches whatever `renderMaxAttempts` above assumed it
  // would need, not the fast case's number.
  const template = templates.get(templateId)
  const deadline =
    Date.now() +
    (template?.document.background.mode === 'ai_extend'
      ? config.inpaint.requestTimeoutMs * 2 + 60_000
      : 120_000)
  for (;;) {
    const job = queue.get(jobId)
    if (!job) throw new Error('render job disappeared from the queue')
    if (job.status === 'completed') break
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(job.error ?? 'render failed')
    }
    if (Date.now() > deadline) throw new Error('render timed out')
    await sleep(200)
  }

  const creative = creatives.findByImageAndTemplate(imageId, templateId)
  if (!creative) throw new Error('render produced no creative')

  return { creativeId: creative.id, storageKey: creative.storageKey }
}
