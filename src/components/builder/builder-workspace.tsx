/**
 * Template builder.
 *
 * Three columns: framing and layer controls on the left, one live preview in the
 * middle, layer properties on the right.
 *
 * ── One preview, many photos ─────────────────────────────────────────────────
 * The centre shows a single photo, picked from a dropdown, at a size worth
 * judging. A template that looks right on one full-body shot routinely falls
 * apart on the close-up three rows down, so the sample still spans several shot
 * types — but stepping through them beats eight thumbnails too small to assess.
 * The footer says how many of the sample fell back to a later rule, which is the
 * cross-catalog signal that actually needs surfacing.
 *
 * Framing is solved for every sample photo here in the parent, synchronously via
 * the shared solver, so dragging a slider updates the preview at frame rate with
 * no server round trip and the footer count stays consistent with what is shown.
 */

'use client'

import * as React from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { toast } from 'sonner'
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Loader2,
  Plus,
  Save,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { fetcher, patchJson } from '@/lib/api'
import {
  ASPECT_RATIOS,
  createLayer,
  type AspectRatioId,
  type Layer,
  type LayerType,
  type TemplateDocument,
} from '@/templates/types'
import type { FramingResult, FramingSubject } from '@/framing/types'
import { solveFraming, achievableVerticalRange, isShotTypeApplicable, shotTypeUniverse } from '@/framing/solver'
import { LivePreview } from '@/components/preview/template-preview'
import { FramingControls } from './framing-controls'
import { LayerProperties } from './layer-properties'
import { BackgroundControls } from './background-controls'
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Panel,
  Select,
  Tabs,
  Toggle,
} from '@/components/ui/primitives'
import { cn, humanize } from '@/lib/utils'
import type { TemplateRecord } from '@/db/types'
import type { PreviewSubject } from '@/app/api/preview/subjects/route'
import type { ProductSummary } from '@/app/api/products/route'

type LeftTab = 'framing' | 'layers' | 'canvas'

export function TemplateBuilder({ template }: { template: TemplateRecord }) {
  const [doc, setDoc] = React.useState<TemplateDocument>(template.document)
  const [name, setName] = React.useState(template.name)
  const [dirty, setDirty] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [tab, setTab] = React.useState<LeftTab>('framing')
  const [selectedLayerId, setSelectedLayerId] = React.useState<string | null>(null)
  // Off by default: the first thing a new user should see is the photograph as
  // it will be delivered, not a diagram drawn over it. Landmarks are a
  // diagnostic, available on demand.
  const [showOverlay, setShowOverlay] = React.useState(false)
  const [showDetails, setShowDetails] = React.useState(false)
  const [focusedSubjectId, setFocusedSubjectId] = React.useState<string | null>(null)
  // Which folder's photos the centre preview draws from. Null until the
  // product list loads, at which point it defaults to the first one —
  // deliberately picked, not a sample scattered across the whole catalog.
  const [selectedProductId, setSelectedProductId] = React.useState<string | null>(null)

  const { data: productsData, isLoading: productsLoading } = useSWR<{ products: ProductSummary[] }>(
    '/api/products?limit=500',
    fetcher
  )
  const products = productsData?.products ?? []
  const effectiveProductId = selectedProductId ?? products[0]?.id ?? null

  const { data: subjectData, isLoading: subjectsLoading } = useSWR<{
    subjects: PreviewSubject[]
    availableReady: number
  }>(effectiveProductId ? `/api/preview/subjects?productId=${effectiveProductId}` : null, fetcher)

  // Memoised so the identity is stable between renders — the framing solve below
  // keys off it, and a fresh `[]` each render would invalidate that every time.
  const subjects = React.useMemo(() => subjectData?.subjects ?? [], [subjectData])

  const selectFolder = (productId: string) => {
    setSelectedProductId(productId)
    setFocusedSubjectId(null)
  }

  /**
   * Framing solved for every preview subject, here in the parent.
   *
   * Framing is DERIVED from (subject, framing spec, canvas), all of which this
   * component already owns — so it is computed directly rather than reported
   * upward from each preview. An earlier version had `LivePreview` call an
   * `onFramingChange` callback from an effect and stored the results in state;
   * that is an infinite loop by construction. `solveFraming` returns a fresh
   * object every call, so no reference-equality guard in the setter can ever
   * hold, and each resulting state commit re-renders the parent, which produces
   * new props, which re-solves, which fires the effect again.
   *
   * Computing here also means one solve per subject instead of one in the child
   * plus one in the parent, and guarantees the aggregate summary below describes
   * exactly what is on screen.
   */
  const framingSubjects = React.useMemo(
    () =>
      subjects.map(subject => ({
        preview: subject,
        subject: {
          image: subject.image,
          anchors: subject.anchors,
          shotType: subject.shotType,
          subjectBox: subject.subjectBox,
        } satisfies FramingSubject,
      })),
    [subjects]
  )

  const framings = React.useMemo(() => {
    const canvas = { width: doc.canvas.width, height: doc.canvas.height }
    const out: Record<string, FramingResult> = {}
    for (const entry of framingSubjects) {
      out[entry.preview.imageId] = solveFraming(entry.subject, doc.framing, canvas)
    }
    return out
  }, [framingSubjects, doc.framing, doc.canvas.width, doc.canvas.height])

  const update = React.useCallback((patch: Partial<TemplateDocument>) => {
    setDoc(prev => ({ ...prev, ...patch }))
    setDirty(true)
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      await patchJson(`/api/templates/${template.id}`, { name, document: doc })
      setDirty(false)
      toast.success('Template saved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  // Warn before losing unsaved edits.
  React.useEffect(() => {
    if (!dirty) return
    const handler = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  // Ctrl/Cmd+S saves, as in any editor.
  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 's') {
        event.preventDefault()
        if (dirty && !saving) void save()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  })

  const selectedLayer = doc.layers.find(l => l.id === selectedLayerId) ?? null

  // Falls back to the first photo until one is picked, and also whenever the
  // selected id is no longer in the list (the sample changes as analysis lands).
  const focusedSubject = subjects.find(s => s.imageId === focusedSubjectId) ?? subjects[0] ?? null
  const focusedFraming = focusedSubject ? framings[focusedSubject.imageId] : null
  const focusedFramingSubject = focusedSubject
    ? framingSubjects.find(e => e.preview.imageId === focusedSubject.imageId)?.subject ?? null
    : null

  // How far the vertical control can actually move THIS photo. Recomputed with
  // the framing so the band on the slider always matches what is on screen.
  const verticalRange = React.useMemo(
    () =>
      focusedFramingSubject
        ? achievableVerticalRange(focusedFramingSubject, doc.framing, {
            width: doc.canvas.width,
            height: doc.canvas.height,
          })
        : null,
    [focusedFramingSubject, doc.framing, doc.canvas.width, doc.canvas.height]
  )

  // Whether THIS template's primary rule applies to the focused photo's shot
  // type. It still renders either way — `solveFraming` always falls through to
  // the chain's anchor-free last resort (a plain fit) rather than refusing —
  // this only surfaces which case is which, so an operator sees "this photo
  // gets the generic fit, not landmark framing" instead of noticing only after
  // generating a batch and finding a "fallback" badge.
  const shotMismatch =
    focusedSubject && !isShotTypeApplicable(focusedSubject.shotType, doc.framing)
      ? { applicable: shotTypeUniverse(doc.framing), shotType: focusedSubject.shotType }
      : null

  const subjectIndex = focusedSubject
    ? subjects.findIndex(s => s.imageId === focusedSubject.imageId)
    : -1

  const stepSubject = (direction: -1 | 1) => {
    const next = subjectIndex + direction
    if (next < 0 || next >= subjects.length) return
    setFocusedSubjectId(subjects[next].imageId)
  }

  const addLayer = (type: LayerType) => {
    const layer = createLayer(type, doc.layers.length + 1)
    update({ layers: [...doc.layers, layer] })
    setSelectedLayerId(layer.id)
    setTab('layers')
  }

  const updateLayer = (id: string, patch: Partial<Layer>) => {
    update({
      layers: doc.layers.map(l => (l.id === id ? ({ ...l, ...patch } as Layer) : l)),
    })
  }

  const removeLayer = (id: string) => {
    update({ layers: doc.layers.filter(l => l.id !== id) })
    if (selectedLayerId === id) setSelectedLayerId(null)
  }

  // Constraint violations across the whole preview sample — the signal that a
  // template is over-specified for part of the catalog.
  const violationSummary = React.useMemo(() => {
    const counts = new Map<string, number>()
    let fallbacks = 0
    for (const framing of Object.values(framings)) {
      if (framing.usedFallback) fallbacks++
      for (const violation of framing.violations) {
        if (violation.severity !== 'warning') continue
        counts.set(violation.code, (counts.get(violation.code) ?? 0) + 1)
      }
    }
    return { counts: [...counts.entries()], fallbacks, total: Object.keys(framings).length }
  }, [framings])

  return (
    <div className="flex h-screen flex-col">
      {/* Toolbar */}
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5">
        <Link
          href="/templates"
          className="text-[var(--color-ink-subtle)] transition-colors hover:text-[var(--color-ink)]"
          aria-label="Back to templates"
        >
          <ArrowLeft size={16} />
        </Link>

        <input
          value={name}
          onChange={e => {
            setName(e.target.value)
            setDirty(true)
          }}
          className="min-w-0 max-w-72 flex-1 bg-transparent text-sm font-semibold outline-none"
        />

        <span className="numeric text-[11px] text-[var(--color-ink-subtle)]">
          {doc.canvas.width} × {doc.canvas.height}
        </span>

        <div className="ml-auto flex items-center gap-3">
          <Toggle label="Show landmarks" checked={showOverlay} onChange={setShowOverlay} />
          <Toggle label="Technical details" checked={showDetails} onChange={setShowDetails} />

          <Button variant="primary" size="sm" onClick={save} disabled={!dirty || saving}>
            {saving ? (
              <Loader2 size={13} className="animate-spin" />
            ) : dirty ? (
              <Save size={13} />
            ) : (
              <Check size={13} />
            )}
            {dirty ? 'Save' : 'Saved'}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Left rail */}
        <aside className="flex w-80 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
          <div className="border-b border-[var(--color-border)] px-3 py-2">
            <Tabs
              value={tab}
              onChange={setTab}
              className="w-full"
              tabs={[
                { value: 'framing', label: 'Framing' },
                { value: 'layers', label: 'Layers', count: doc.layers.length },
                { value: 'canvas', label: 'Canvas' },
              ]}
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {tab === 'framing' && (
              <FramingControls
                spec={doc.framing}
                onChange={framing => update({ framing })}
                subjectAnchors={focusedSubject?.anchors}
                subjectShotType={focusedSubject?.shotType}
                activeStrategyId={focusedFraming?.strategyId ?? null}
                activeFraming={focusedFraming}
                verticalRange={verticalRange}
                background={doc.background}
                onBackgroundChange={background => update({ background })}
              />
            )}

            {tab === 'layers' && (
              <LayerList
                layers={doc.layers}
                selectedId={selectedLayerId}
                onSelect={setSelectedLayerId}
                onAdd={addLayer}
                onUpdate={updateLayer}
                onRemove={removeLayer}
                subjectZIndex={doc.subjectZIndex}
              />
            )}

            {tab === 'canvas' && (
              <CanvasControls doc={doc} onChange={update} />
            )}
          </div>
        </aside>

        {/* Preview — one folder chosen first, then one photo within it. */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--color-canvas)]">
          {productsLoading ? (
            <div className="flex flex-1 items-center justify-center gap-2 text-sm text-[var(--color-ink-subtle)]">
              <Loader2 size={15} className="animate-spin" /> Loading products…
            </div>
          ) : products.length === 0 ? (
            <div className="p-4">
              <Panel>
                <EmptyState
                  icon={<ImageIcon size={24} />}
                  title="No analysed photos to preview against"
                  description="Import a folder and let the Vision Engine finish. The builder previews templates against real landmarks, so it needs at least one analysed photo."
                  action={
                    <Link
                      href="/import"
                      className="inline-flex items-center rounded-md bg-[var(--color-accent)] px-3.5 py-2 text-sm font-medium text-[var(--color-accent-ink)]"
                    >
                      Import a folder
                    </Link>
                  }
                />
              </Panel>
            </div>
          ) : (
            <>
              {/* Folder selector — always shown once there is at least one
                  product, so switching folders never requires leaving the
                  preview state below. */}
              <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
                <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-subtle)]">
                  Folder
                </span>
                <Select
                  aria-label="Preview folder"
                  value={effectiveProductId ?? ''}
                  onChange={e => selectFolder(e.target.value)}
                  className="h-8 max-w-96 flex-1 text-xs"
                >
                  {products.map(product => (
                    <option key={product.id} value={product.id}>
                      {product.name} ({product.imageCount} photo{product.imageCount === 1 ? '' : 's'})
                    </option>
                  ))}
                </Select>
              </div>

              {subjectsLoading ? (
                <div className="flex flex-1 items-center justify-center gap-2 text-sm text-[var(--color-ink-subtle)]">
                  <Loader2 size={15} className="animate-spin" /> Loading this folder&apos;s photos…
                </div>
              ) : subjects.length === 0 ? (
                <div className="p-4">
                  <Panel>
                    <EmptyState
                      icon={<ImageIcon size={24} />}
                      title="No analysed photos in this folder yet"
                      description="Pick a different folder above, or wait for the Vision Engine to finish analysing this one."
                    />
                  </Panel>
                </div>
              ) : (
                <>
                  {/* Photo selector, scoped to the folder chosen above. */}
                  <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-subtle)]">
                      Photo
                    </span>

                    <Select
                      aria-label="Preview photo"
                      value={focusedSubject?.imageId ?? ''}
                      onChange={e => setFocusedSubjectId(e.target.value)}
                      className="h-8 max-w-80 flex-1 text-xs"
                    >
                      {subjects.map(subject => {
                        const f = framings[subject.imageId]
                        return (
                          <option key={subject.imageId} value={subject.imageId}>
                            {subject.fileName} — {humanize(subject.shotType)}
                            {f?.usedFallback ? '  (backup rule)' : ''}
                          </option>
                        )
                      })}
                    </Select>

                    <div className="flex items-center gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        aria-label="Previous photo"
                        disabled={subjectIndex <= 0}
                        onClick={() => stepSubject(-1)}
                      >
                        <ChevronLeft size={14} />
                      </Button>
                      <span className="numeric w-12 text-center text-[11px] text-[var(--color-ink-subtle)]">
                        {subjectIndex + 1}/{subjects.length}
                      </span>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        aria-label="Next photo"
                        disabled={subjectIndex >= subjects.length - 1}
                        onClick={() => stepSubject(1)}
                      >
                        <ChevronRight size={14} />
                      </Button>
                    </div>

                    <div className="ml-auto flex items-center gap-1.5">
                      {focusedFraming && showDetails && (
                        <>
                          <Badge tone={focusedFraming.usedFallback ? 'warning' : 'positive'}>
                            {focusedFraming.strategyLabel}
                          </Badge>
                          <span className="numeric text-[11px] text-[var(--color-ink-subtle)]">
                            {focusedFraming.upscale.toFixed(2)}× zoom
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  {shotMismatch && (
                    <div className="shrink-0 border-b border-[var(--color-warning)]/30 bg-[color-mix(in_oklch,var(--color-warning)_10%,transparent)] px-4 py-2">
                      <p className="flex items-center gap-1.5 text-[11px] text-[var(--color-warning)]">
                        <TriangleAlert size={12} className="shrink-0" />
                        This template&apos;s main rule is for{' '}
                        {shotMismatch.applicable.map(t => t.replace(/_/g, ' ')).join(' or ')} photos —
                        this one is {shotMismatch.shotType.replace(/_/g, ' ')}. It will still generate,
                        using this fallback framing shown below instead of landmark framing.
                      </p>
                    </div>
                  )}

                  {/* The preview itself, sized to fit the available space. */}
                  <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-5">
                    {focusedSubject && focusedFramingSubject && (
                      <div
                        className="panel overflow-hidden shadow-2xl"
                        style={{
                          // Bound by height so a tall 9:16 canvas still fits without
                          // scrolling, and by width so a landscape one does too.
                          maxHeight: '100%',
                          aspectRatio: `${doc.canvas.width} / ${doc.canvas.height}`,
                          height: 'min(100%, 74vh)',
                        }}
                      >
                        <LivePreview
                          key={focusedSubject.imageId}
                          subject={focusedFramingSubject}
                          // Already solved above; passing it in avoids a second
                          // identical solve inside the preview.
                          framing={focusedFraming ?? undefined}
                          imageUrl={focusedSubject.imageUrl}
                          template={doc}
                          variables={{
                            product_name: focusedSubject.productName,
                            file_name: focusedSubject.fileName,
                            shot_type: focusedSubject.shotType,
                          }}
                          showOverlay={showOverlay}
                          // Dots and guide lines, no text. Eighteen anchor names
                          // overlap into illegible mush at preview scale, and the
                          // right rail already lists them with their offsets — the
                          // Vision Debug panel is where labelled anchors belong.
                          overlayToggles={{ anchorLabels: false, keypoints: false }}
                          garmentBox={focusedSubject.garmentBox}
                          className="h-full w-full"
                        />
                      </div>
                    )}
                  </div>

                  {/* Consistency across the rest of this folder's photos. Kept to
                      one line — the cross-photo signal matters, several large
                      previews to convey it did not. */}
                  {showDetails && violationSummary.total > 1 && violationSummary.fallbacks > 0 && (
                    <div className="shrink-0 border-t border-[var(--color-border)] px-4 py-2">
                      <p className="flex items-center gap-1.5 text-[11px] text-[var(--color-warning)]">
                        <TriangleAlert size={12} className="shrink-0" />
                        {violationSummary.fallbacks} of {violationSummary.total} preview photos use a
                        backup rule. Step through them to check the framing holds.
                      </p>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </main>

        {/* Right rail — only shown when there is something to edit or inspect.
            Pixel crops, magnification factors and per-anchor offsets are for
            diagnosing a template, not for building one, so they sit behind an
            explicit "Technical details" switch rather than greeting the user. */}
        {(selectedLayer || showDetails) && (
          <aside className="w-72 shrink-0 overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-surface)] p-3">
            {selectedLayer ? (
              <LayerProperties
                layer={selectedLayer}
                onChange={patch => updateLayer(selectedLayer.id, patch)}
                onRemove={() => removeLayer(selectedLayer.id)}
              />
            ) : focusedFraming && focusedSubject ? (
              <FocusedFramingSummary framing={focusedFraming} subject={focusedSubject} />
            ) : (
              <p className="px-1 py-8 text-center text-[11px] text-[var(--color-ink-subtle)]">
                Nothing to inspect yet.
              </p>
            )}
          </aside>
        )}
      </div>
    </div>
  )
}

// ─── Right-rail framing summary ──────────────────────────────────────────────

function FocusedFramingSummary({
  framing,
  subject,
}: {
  framing: FramingResult
  subject: PreviewSubject
}) {
  return (
    <div className="space-y-3">
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-subtle)]">
          Selected preview
        </p>
        <p className="mt-1 truncate text-xs font-medium">{subject.productName}</p>
        <p className="text-[11px] text-[var(--color-ink-subtle)]">
          {humanize(subject.shotType)} · {subject.image.width}×{subject.image.height}
        </p>
      </div>

      <div className="space-y-1 border-t border-[var(--color-border)] pt-3">
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] text-[var(--color-ink-subtle)]">Rule</span>
          <span className="text-[11px] font-medium">{framing.strategyLabel}</span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] text-[var(--color-ink-subtle)]">Magnification</span>
          <span className="numeric text-[11px] font-medium">{framing.upscale.toFixed(2)}×</span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] text-[var(--color-ink-subtle)]">Crop</span>
          <span className="numeric text-[11px]">
            {Math.round(framing.crop.width)}×{Math.round(framing.crop.height)}
          </span>
        </div>
      </div>

      {framing.placements.length > 0 && (
        <div className="border-t border-[var(--color-border)] pt-3">
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-subtle)]">
            Anchors
          </p>
          <ul className="space-y-1">
            {framing.placements.map(placement => (
              <li key={placement.anchor} className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-[10px] text-[var(--color-ink-muted)]">
                  {placement.anchor}
                </span>
                <span className="numeric text-[10px]">
                  {placement.error && Math.abs(placement.error.y) > 1 ? (
                    <span className="text-[var(--color-warning)]">
                      {Math.round(placement.error.y) > 0 ? '+' : ''}
                      {Math.round(placement.error.y)}px off
                    </span>
                  ) : (
                    <span className="text-[var(--color-positive)]">on target</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {framing.violations.length > 0 && (
        <div className="space-y-1.5 border-t border-[var(--color-border)] pt-3">
          {framing.violations.map((violation, index) => (
            <p
              key={index}
              className={cn(
                'text-[10px] leading-snug',
                violation.severity === 'warning'
                  ? 'text-[var(--color-warning)]'
                  : 'text-[var(--color-ink-subtle)]'
              )}
            >
              {violation.message}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Layer list ──────────────────────────────────────────────────────────────

const LAYER_TYPES: { type: LayerType; label: string }[] = [
  { type: 'text', label: 'Text' },
  { type: 'badge', label: 'Badge' },
  { type: 'rectangle', label: 'Rectangle' },
  { type: 'ellipse', label: 'Ellipse' },
  { type: 'image', label: 'Image' },
]

function LayerList({
  layers,
  selectedId,
  onSelect,
  onAdd,
  onUpdate,
  onRemove,
  subjectZIndex,
}: {
  layers: Layer[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onAdd: (type: LayerType) => void
  onUpdate: (id: string, patch: Partial<Layer>) => void
  onRemove: (id: string) => void
  subjectZIndex: number
}) {
  const sorted = [...layers].sort((a, b) => b.zIndex - a.zIndex)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1">
        {LAYER_TYPES.map(entry => (
          <Button key={entry.type} size="sm" variant="outline" onClick={() => onAdd(entry.type)}>
            <Plus size={12} /> {entry.label}
          </Button>
        ))}
      </div>

      {layers.length === 0 ? (
        <p className="px-1 py-6 text-center text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
          No layers. The framed photograph renders on its own — add text or graphics to composite
          over it.
        </p>
      ) : (
        <ul className="space-y-1">
          {sorted.map(layer => (
            <li key={layer.id}>
              <div
                className={cn(
                  'flex items-center gap-1.5 rounded-md border px-2 py-1.5 transition-colors',
                  selectedId === layer.id
                    ? 'border-[var(--color-accent)] bg-[color-mix(in_oklch,var(--color-accent)_8%,transparent)]'
                    : 'border-[var(--color-border)] bg-[var(--color-surface-raised)] hover:border-[var(--color-border-strong)]'
                )}
              >
                <button
                  onClick={() => onUpdate(layer.id, { visible: !layer.visible })}
                  className="text-[var(--color-ink-subtle)] hover:text-[var(--color-ink)]"
                  aria-label={layer.visible ? 'Hide layer' : 'Show layer'}
                >
                  {layer.visible ? <Eye size={12} /> : <EyeOff size={12} />}
                </button>

                <button
                  onClick={() => onSelect(layer.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate text-[11px] font-medium">{layer.name}</span>
                  <span className="block text-[10px] text-[var(--color-ink-subtle)]">
                    {layer.type}
                    {layer.anchorTo && ` · pinned to ${layer.anchorTo}`}
                    {layer.zIndex < subjectZIndex && ' · behind photo'}
                  </span>
                </button>

                <button
                  onClick={() => onRemove(layer.id)}
                  className="text-[var(--color-ink-subtle)] hover:text-[var(--color-danger)]"
                  aria-label="Delete layer"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ─── Canvas controls ─────────────────────────────────────────────────────────

function CanvasControls({
  doc,
  onChange,
}: {
  doc: TemplateDocument
  onChange: (patch: Partial<TemplateDocument>) => void
}) {
  return (
    <div className="space-y-4">
      <Field label="Canvas size">
        <Select
          value={doc.canvas.aspectRatio}
          onChange={e => {
            const id = e.target.value as AspectRatioId
            const preset = ASPECT_RATIOS.find(a => a.id === id)
            if (!preset) {
              onChange({ canvas: { ...doc.canvas, aspectRatio: 'custom' } })
              return
            }
            onChange({
              canvas: { width: preset.width, height: preset.height, aspectRatio: preset.id },
            })
          }}
        >
          {ASPECT_RATIOS.map(ratio => (
            <option key={ratio.id} value={ratio.id}>
              {ratio.label} — {ratio.width}×{ratio.height}
            </option>
          ))}
          <option value="custom">Custom</option>
        </Select>
      </Field>

      {doc.canvas.aspectRatio === 'custom' && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Width">
            <Input
              type="number"
              value={doc.canvas.width}
              min={64}
              max={8192}
              onChange={e =>
                onChange({ canvas: { ...doc.canvas, width: Number(e.target.value) || 1080 } })
              }
            />
          </Field>
          <Field label="Height">
            <Input
              type="number"
              value={doc.canvas.height}
              min={64}
              max={8192}
              onChange={e =>
                onChange({ canvas: { ...doc.canvas, height: Number(e.target.value) || 1350 } })
              }
            />
          </Field>
        </div>
      )}

      <div className="border-t border-[var(--color-border)] pt-4">
        <BackgroundControls
          background={doc.background}
          onChange={background => onChange({ background })}
        />
      </div>
    </div>
  )
}
