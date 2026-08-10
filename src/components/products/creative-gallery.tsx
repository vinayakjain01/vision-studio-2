'use client'

import * as React from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import { Download, Loader2, Sparkles, Wand2 } from 'lucide-react'
import { fetcher, postJson } from '@/lib/api'
import { Badge, Button, EmptyState, Panel, PanelHeader, Select } from '@/components/ui/primitives'
import { formatBytes, timeAgo } from '@/lib/utils'
import type { ProductImageDetail } from '@/app/api/products/[productId]/route'
import type { FramingResult } from '@/framing/types'
import type { TemplateRecord } from '@/db/types'

interface Creative {
  id: string
  templateId: string
  templateName: string
  url: string
  width: number
  height: number
  byteSize: number
  framing: FramingResult | null
  renderMs: number
  createdAt: string
}

export function CreativeGallery({
  creatives,
  image,
}: {
  creatives: Creative[]
  image: ProductImageDetail
}) {
  const { data } = useSWR<{ templates: TemplateRecord[] }>('/api/templates?active=true', fetcher)
  const templates = data?.templates ?? []

  const [templateId, setTemplateId] = React.useState('')
  const [rendering, setRendering] = React.useState(false)

  const render = async () => {
    if (!templateId) return
    setRendering(true)
    try {
      await postJson('/api/render', { imageId: image.id, templateId, persist: true })
      toast.success('Creative rendered')
      // The parent revalidates on focus; force it now so the new creative shows.
      window.location.reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Render failed')
    } finally {
      setRendering(false)
    }
  }

  return (
    <div className="space-y-3">
      <Panel>
        <PanelHeader
          title="Generate an image from this photo"
          description="Applies a template to this one photo and saves the result — no batch needed."
          action={
            <div className="flex items-center gap-2">
              <Select
                aria-label="Template"
                value={templateId}
                onChange={e => setTemplateId(e.target.value)}
                className="w-48"
              >
                <option value="">Choose a template…</option>
                {templates.map(template => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </Select>
              <Button
                variant="primary"
                onClick={render}
                disabled={!templateId || rendering}
              >
                {rendering ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                {rendering ? 'Generating…' : 'Generate image'}
              </Button>
            </div>
          }
        />
      </Panel>

      {creatives.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<Sparkles size={24} />}
            title="No creatives for this shot"
            description="Render one above, or run a bulk generation from the Generate page."
          />
        </Panel>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {creatives.map(creative => (
            <Panel key={creative.id} className="overflow-hidden">
              <div className="bg-[var(--color-canvas)]">
                <img
                  src={creative.url}
                  alt={creative.templateName}
                  className="block h-auto w-full"
                  loading="lazy"
                />
              </div>
              <div className="space-y-1.5 px-3 py-2.5">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate text-xs font-medium">{creative.templateName}</p>
                  <a
                    href={creative.url}
                    download
                    className="shrink-0 text-[var(--color-ink-subtle)] transition-colors hover:text-[var(--color-ink)]"
                    aria-label="Download"
                  >
                    <Download size={13} />
                  </a>
                </div>

                <p className="numeric text-[11px] text-[var(--color-ink-subtle)]">
                  {creative.width} × {creative.height} · {formatBytes(creative.byteSize)} ·{' '}
                  {creative.renderMs}ms
                </p>

                {creative.framing && (
                  <div className="flex flex-wrap items-center gap-1">
                    <Badge tone={creative.framing.usedFallback ? 'warning' : 'neutral'}>
                      {creative.framing.strategyLabel}
                    </Badge>
                    {creative.framing.violations.length > 0 && (
                      <Badge tone="warning">
                        {creative.framing.violations.length} constraint
                        {creative.framing.violations.length === 1 ? '' : 's'}
                      </Badge>
                    )}
                  </div>
                )}

                <p className="text-[10px] text-[var(--color-ink-subtle)]">
                  {timeAgo(creative.createdAt)}
                </p>
              </div>
            </Panel>
          ))}
        </div>
      )}
    </div>
  )
}
