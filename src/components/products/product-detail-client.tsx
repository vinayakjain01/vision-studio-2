'use client'

import * as React from 'react'
import useSWR from 'swr'
import { AlertTriangle, ImageOff, Loader2 } from 'lucide-react'
import { fetcher } from '@/lib/api'
import { Alert, Badge, Panel, Spinner, Tabs } from '@/components/ui/primitives'
import { VisionDebugPanel } from '@/components/vision/vision-debug-panel'
import { CreativeGallery } from '@/components/products/creative-gallery'
import { ProductGeneratePanel } from '@/components/products/product-generate-panel'
import { humanize } from '@/lib/utils'
import type { ProductImageDetail } from '@/app/api/products/[productId]/route'
import type { ProductRecord } from '@/db/types'
import type { FramingResult } from '@/framing/types'

interface Response {
  product: ProductRecord
  images: ProductImageDetail[]
  creatives: {
    id: string
    imageId: string
    templateId: string
    templateName: string
    url: string
    width: number
    height: number
    byteSize: number
    framing: FramingResult | null
    renderMs: number
    createdAt: string
  }[]
}

export function ProductDetailClient({ productId }: { productId: string }) {
  const { data, isLoading, mutate } = useSWR<Response>(`/api/products/${productId}`, fetcher, {
    refreshInterval: latest =>
      latest?.images.some(i => i.visionStatus === 'pending' || i.visionStatus === 'processing')
        ? 2500
        : 0,
  })

  const [selectedImageId, setSelectedImageId] = React.useState<string | null>(null)
  const [tab, setTab] = React.useState<'vision' | 'creatives'>('creatives')

  const selected = React.useMemo(() => {
    if (!data) return null
    return data.images.find(i => i.id === selectedImageId) ?? data.images[0] ?? null
  }, [data, selectedImageId])

  if (isLoading && !data) {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-[var(--color-ink-subtle)]">
        <Spinner /> Loading product…
      </div>
    )
  }

  if (!data || data.images.length === 0) {
    return (
      <Panel>
        <div className="flex flex-col items-center gap-2 py-14 text-center">
          <ImageOff size={22} className="text-[var(--color-ink-subtle)]" />
          <p className="text-sm">This product has no images.</p>
        </div>
      </Panel>
    )
  }

  const creativesForImage = selected
    ? data.creatives.filter(c => c.imageId === selected.id)
    : []

  return (
    <div className="space-y-4">
      <ProductGeneratePanel
        productId={productId}
        imageCount={data.images.length}
        hasCreatives={data.creatives.length > 0}
        onGenerated={() => mutate()}
      />

      {/* Shot strip — only shown when the product has more than one image. */}
      {data.images.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {data.images.map(image => (
            <button
              key={image.id}
              onClick={() => setSelectedImageId(image.id)}
              className={
                'relative h-20 w-16 shrink-0 overflow-hidden rounded border transition-colors ' +
                (selected?.id === image.id
                  ? 'border-[var(--color-accent)]'
                  : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]')
              }
            >
              <img src={image.originalUrl} alt={image.fileName} className="h-full w-full object-cover" />
              {image.visionStatus === 'processing' && (
                <span className="absolute inset-0 grid place-items-center bg-black/50">
                  <Loader2 size={12} className="animate-spin text-[var(--color-accent)]" />
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {selected && (
        <>
          {selected.visionStatus !== 'ready' && (
            <Alert
              tone={selected.visionStatus === 'failed' ? 'danger' : 'warning'}
              title={
                selected.visionStatus === 'processing'
                  ? 'Analysis in progress'
                  : selected.visionStatus === 'pending'
                    ? 'Queued for analysis'
                    : selected.visionStatus === 'unavailable'
                      ? 'Analysis unavailable'
                      : 'Analysis failed'
              }
            >
              {selected.visionStatus === 'unavailable'
                ? 'The vision models were not installed when this image was processed. Install them and re-run analysis from the Import page.'
                : selected.visionStatus === 'failed'
                  ? 'This image could not be analysed. It will render as a plain centred fit until the problem is resolved.'
                  : 'Landmarks and framing become available once analysis finishes.'}
            </Alert>
          )}

          {selected.visionStale && selected.vision && (
            <Alert tone="warning" title="Analysis is from an older engine version">
              These landmarks were produced by {selected.vision.engineVersion}. Re-run analysis to
              refresh them against the current models.
            </Alert>
          )}

          <div className="flex items-center justify-between gap-3">
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { value: 'creatives', label: 'Images', count: creativesForImage.length },
                { value: 'vision', label: 'What was detected' },
              ]}
            />

            <div className="flex items-center gap-2">
              {selected.vision && (
                <>
                  <Badge tone="neutral">{humanize(selected.vision.shot.type)}</Badge>
                  <Badge tone="neutral">{humanize(selected.vision.garment.type)}</Badge>
                  {selected.vision.quality.warnings.some(w => w.severity !== 'info') && (
                    <Badge tone="warning">
                      <AlertTriangle size={10} />
                      {selected.vision.quality.warnings.filter(w => w.severity !== 'info').length}
                    </Badge>
                  )}
                </>
              )}
            </div>
          </div>

          {tab === 'vision' ? (
            <VisionDebugPanel image={selected} onReanalyzed={() => mutate()} />
          ) : (
            <CreativeGallery creatives={creativesForImage} image={selected} />
          )}
        </>
      )}
    </div>
  )
}
