/**
 * Overview.
 *
 * Server component reading the database directly — no API round trip for a page
 * whose entire content is counts.
 */

import Link from 'next/link'
import { ArrowRight, FolderUp, LayoutTemplate, Route, Wand2 } from 'lucide-react'
import { images, products, templates, rules, batches, creatives, visionAnalyses } from '@/db/repositories'
import { PageHeader, PageBody } from '@/components/shell/page-header'
import { Panel, PanelHeader, Stat, Badge, EmptyState, Progress } from '@/components/ui/primitives'
import { humanize, timeAgo } from '@/lib/utils'

export const dynamic = 'force-dynamic'

export default function OverviewPage() {
  const imageCounts = images.statusCounts()
  const totalImages = images.total()
  const productCount = products.count()
  const templateList = templates.list()
  const ruleList = rules.list()
  const batchList = batches.list(5)
  const creativeCount = creatives.count()
  const shotTypes = visionAnalyses.shotTypeCounts()

  const analysed = imageCounts.ready
  const coverage = totalImages > 0 ? analysed / totalImages : 0
  const outstanding = imageCounts.pending + imageCounts.processing

  return (
    <>
      <PageHeader
        title="Overview"
        description="Deterministic vision analysis and landmark-based framing for fashion catalogs."
      />

      <PageBody className="space-y-5">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Products" value={productCount} hint={`${totalImages} images`} />
          <Stat
            label="Analysed"
            value={`${Math.round(coverage * 100)}%`}
            hint={
              outstanding > 0
                ? `${outstanding} still queued`
                : imageCounts.failed + imageCounts.unavailable > 0
                  ? `${imageCounts.failed + imageCounts.unavailable} need attention`
                  : 'all images analysed'
            }
            tone={coverage === 1 && totalImages > 0 ? 'positive' : outstanding > 0 ? 'warning' : 'default'}
          />
          <Stat label="Templates" value={templateList.length} hint={`${ruleList.length} rules`} />
          <Stat label="Creatives" value={creativeCount} hint="rendered" />
        </div>

        {totalImages === 0 ? (
          <Panel>
            <EmptyState
              icon={<FolderUp size={26} />}
              title="Nothing imported yet"
              description="Pick a folder of product photographs. Vision Studio walks it recursively, groups each folder into a product, and starts analysing immediately."
              action={
                <Link
                  href="/import"
                  className="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3.5 py-2 text-sm font-medium text-[var(--color-accent-ink)]"
                >
                  Import a folder <ArrowRight size={14} />
                </Link>
              }
            />
          </Panel>
        ) : (
          <div className="grid gap-5 lg:grid-cols-3">
            <Panel className="lg:col-span-2">
              <PanelHeader
                title="Analysis coverage"
                description="Landmark framing only applies to analysed images; the rest render as a plain centred fit."
              />
              <div className="space-y-3 px-4 py-4">
                <Progress value={coverage} />
                <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
                  {(
                    [
                      ['ready', imageCounts.ready, 'positive'],
                      ['pending', imageCounts.pending, 'neutral'],
                      ['processing', imageCounts.processing, 'accent'],
                      ['failed', imageCounts.failed, 'danger'],
                      ['unavailable', imageCounts.unavailable, 'warning'],
                    ] as const
                  )
                    .filter(([, count]) => count > 0)
                    .map(([label, count, tone]) => (
                      <div key={label} className="flex items-center justify-between gap-2">
                        <Badge tone={tone}>{label}</Badge>
                        <span className="numeric text-xs text-[var(--color-ink-muted)]">{count}</span>
                      </div>
                    ))}
                </div>
              </div>
            </Panel>

            <Panel>
              <PanelHeader title="Detected shot types" description="What the engine classified." />
              <div className="px-4 py-3">
                {shotTypes.length === 0 ? (
                  <p className="py-4 text-center text-xs text-[var(--color-ink-subtle)]">
                    No analyses yet.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {shotTypes.map(entry => (
                      <li key={entry.shotType} className="flex items-center justify-between gap-2">
                        <span className="text-xs text-[var(--color-ink-muted)]">
                          {humanize(entry.shotType)}
                        </span>
                        <span className="numeric text-xs font-medium">{entry.count}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Panel>
          </div>
        )}

        {/* Next steps — the pipeline is sequential, so point at whatever is missing. */}
        {totalImages > 0 && (
          <div className="grid gap-3 sm:grid-cols-3">
            <NextStep
              href="/templates"
              icon={<LayoutTemplate size={16} />}
              title="Templates"
              done={templateList.length > 0}
              description={
                templateList.length > 0
                  ? `${templateList.length} template${templateList.length === 1 ? '' : 's'} defined`
                  : 'Define how landmarks map to the canvas'
              }
            />
            <NextStep
              href="/rules"
              icon={<Route size={16} />}
              title="Rules"
              done={ruleList.length > 0}
              description={
                ruleList.length > 0
                  ? `${ruleList.length} rule${ruleList.length === 1 ? '' : 's'} routing products`
                  : 'Map folders and categories to templates'
              }
            />
            <NextStep
              href="/generate"
              icon={<Wand2 size={16} />}
              title="Generate"
              done={creativeCount > 0}
              description={
                creativeCount > 0 ? `${creativeCount} creatives rendered` : 'Render the catalog in bulk'
              }
            />
          </div>
        )}

        {batchList.length > 0 && (
          <Panel>
            <PanelHeader title="Recent batches" />
            <ul className="divide-y divide-[var(--color-border)]">
              {batchList.map(batch => (
                <li key={batch.id}>
                  <Link
                    href={`/generate/${batch.id}`}
                    className="flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-[var(--color-surface-raised)]"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium">{batch.name}</p>
                      <p className="numeric mt-0.5 text-[11px] text-[var(--color-ink-subtle)]">
                        {batch.completedJobs}/{batch.totalJobs} rendered
                        {batch.failedJobs > 0 && ` · ${batch.failedJobs} failed`} ·{' '}
                        {timeAgo(batch.createdAt)}
                      </p>
                    </div>
                    <Badge
                      tone={
                        batch.status === 'completed'
                          ? 'positive'
                          : batch.status === 'failed'
                            ? 'danger'
                            : batch.status === 'running'
                              ? 'accent'
                              : 'neutral'
                      }
                    >
                      {batch.status}
                    </Badge>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </PageBody>
    </>
  )
}

function NextStep({
  href,
  icon,
  title,
  description,
  done,
}: {
  href: string
  icon: React.ReactNode
  title: string
  description: string
  done: boolean
}) {
  return (
    <Link
      href={href}
      className="panel flex items-start gap-3 px-4 py-3 transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-raised)]"
    >
      <span
        className={
          done
            ? 'mt-0.5 text-[var(--color-positive)]'
            : 'mt-0.5 text-[var(--color-ink-subtle)]'
        }
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-medium">{title}</span>
        <span className="mt-0.5 block text-[11px] leading-snug text-[var(--color-ink-subtle)]">
          {description}
        </span>
      </span>
    </Link>
  )
}
