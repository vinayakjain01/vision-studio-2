/**
 * Vision Debug panel.
 *
 * Everything the engine derived from one image, presented so a framing decision
 * can be explained rather than guessed at: landmarks over the photo, the masks
 * it produced, the crop a chosen template resolves to, per-anchor confidences
 * and sources, and the quality warnings.
 *
 * The design principle throughout is that every number shown is traceable to
 * how it was produced — each anchor names the rule that derived it, each crop
 * names the strategy that won and lists the constraints it hit. A confidence
 * score with no explanation tells an operator that something is wrong but not
 * what to do about it.
 */

'use client'

import * as React from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import { AlertTriangle, Info, Loader2, RefreshCw, Ruler, ScanFace, XCircle } from 'lucide-react'
import { fetcher, postJson } from '@/lib/api'
import { solveFraming } from '@/framing/solver'
import type { FramingResult } from '@/framing/types'
import {
  LandmarkOverlay,
  LandmarkLegend,
  DEFAULT_TOGGLES,
  type OverlayToggles,
} from './landmark-overlay'
import {
  Badge,
  Button,
  DataList,
  Panel,
  PanelHeader,
  Progress,
  Select,
  Toggle,
} from '@/components/ui/primitives'
import { cn, formatBytes, humanize, percent } from '@/lib/utils'
import type { AnchorName } from '@/vision/types'
import type { ProductImageDetail } from '@/app/api/products/[productId]/route'
import type { TemplateRecord } from '@/db/types'

type MaskView = 'none' | 'person' | 'garment' | 'cutout'

export function VisionDebugPanel({
  image,
  onReanalyzed,
}: {
  image: ProductImageDetail
  onReanalyzed?: () => void
}) {
  const [toggles, setToggles] = React.useState<OverlayToggles>(DEFAULT_TOGGLES)
  const [maskView, setMaskView] = React.useState<MaskView>('none')
  const [maskOpacity, setMaskOpacity] = React.useState(0.65)
  const [templateId, setTemplateId] = React.useState<string>('')
  const [hoveredAnchor, setHoveredAnchor] = React.useState<AnchorName | null>(null)
  const [compare, setCompare] = React.useState(false)
  const [reanalyzing, setReanalyzing] = React.useState(false)

  const { data: templateData } = useSWR<{ templates: TemplateRecord[] }>(
    '/api/templates?active=true',
    fetcher
  )
  // Memoised so the framing solve below is not re-run on every render just
  // because the fallback array is a fresh reference each time.
  const templates = React.useMemo(() => templateData?.templates ?? [], [templateData])

  const vision = image.vision

  const reanalyze = async () => {
    setReanalyzing(true)
    try {
      // `force` — the operator is asking for a fresh run, not the cached result.
      await postJson('/api/vision/reanalyze', { imageId: image.id, force: true })
      toast.success('Re-analysis queued')
      onReanalyzed?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not queue re-analysis')
    } finally {
      setReanalyzing(false)
    }
  }

  // Solve the chosen template's framing locally — same function the renderer
  // uses, so the crop drawn here is the crop that will be produced.
  const framing: FramingResult | null = React.useMemo(() => {
    if (!vision || !templateId) return null
    const template = templates.find(t => t.id === templateId)
    if (!template) return null

    const person =
      vision.primaryPersonIndex !== null ? vision.persons[vision.primaryPersonIndex] : null

    return solveFraming(
      {
        image: vision.image,
        anchors: vision.anchors,
        shotType: vision.shot.type,
        subjectBox: vision.segmentation.person?.bbox ?? person?.box ?? vision.garment.box ?? null,
      },
      template.document.framing,
      { width: template.document.canvas.width, height: template.document.canvas.height }
    )
  }, [vision, templateId, templates])

  const maskUrl =
    maskView === 'person'
      ? image.assets.personMask
      : maskView === 'garment'
        ? image.assets.garmentMask
        : maskView === 'cutout'
          ? image.assets.cutout
          : null

  if (!vision) {
    return (
      <Panel>
        <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
          <ScanFace size={24} className="text-[var(--color-ink-subtle)]" />
          <p className="text-sm">No analysis for this image yet.</p>
          <p className="max-w-md text-xs text-[var(--color-ink-subtle)]">
            Landmarks, masks and framing become available once the Vision Engine has processed it.
          </p>
          <Button variant="outline" onClick={reanalyze} disabled={reanalyzing}>
            {reanalyzing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            Analyse now
          </Button>
        </div>
      </Panel>
    )
  }

  const person =
    vision.primaryPersonIndex !== null ? vision.persons[vision.primaryPersonIndex] : null
  const face = vision.primaryFaceIndex !== null ? vision.faces[vision.primaryFaceIndex] : null

  const anchorEntries = (Object.entries(vision.anchors) as [AnchorName, NonNullable<typeof vision.anchors[AnchorName]>][])
    .sort((a, b) => a[1].y - b[1].y)

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
      {/* ── Image with overlays ────────────────────────────────────────────── */}
      <div className="space-y-3">
        <Panel className="overflow-hidden">
          <div className="relative bg-[var(--color-canvas)]">
            {compare && framing ? (
              <BeforeAfter image={image} framing={framing} />
            ) : (
              <div className="relative mx-auto" style={{ maxWidth: '100%' }}>
                <img
                  src={image.originalUrl}
                  alt={image.fileName}
                  className="block h-auto w-full"
                  style={{ maxHeight: '70vh', objectFit: 'contain' }}
                />

                {maskUrl && (
                  <img
                    src={maskUrl}
                    alt=""
                    className={cn(
                      'pointer-events-none absolute inset-0 h-full w-full object-contain',
                      maskView === 'cutout' && 'alpha-checker'
                    )}
                    style={{
                      opacity: maskOpacity,
                      // Masks are greyscale; screen blending makes the set
                      // region read as a bright wash over the photo rather than
                      // hiding it, so the boundary is judgeable against the
                      // actual pixels.
                      mixBlendMode: maskView === 'cutout' ? 'normal' : 'screen',
                    }}
                  />
                )}

                <LandmarkOverlay
                  image={vision.image}
                  persons={vision.persons}
                  primaryPersonIndex={vision.primaryPersonIndex}
                  faces={vision.faces}
                  primaryFaceIndex={vision.primaryFaceIndex}
                  anchors={vision.anchors}
                  personMaskBox={vision.segmentation.person?.bbox ?? null}
                  garmentBox={vision.garment.box}
                  crop={framing?.crop ?? null}
                  toggles={toggles}
                  highlightAnchor={hoveredAnchor}
                />
              </div>
            )}
          </div>
        </Panel>

        {/* Controls */}
        <Panel>
          <div className="grid gap-4 px-4 py-3 sm:grid-cols-2">
            <div className="space-y-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-subtle)]">
                Overlays
              </p>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                {(
                  [
                    ['skeleton', 'Skeleton'],
                    ['keypoints', 'Keypoints'],
                    ['anchors', 'Anchors'],
                    ['anchorLabels', 'Anchor labels'],
                    ['faceBox', 'Face box'],
                    ['faceLandmarks', 'Face points'],
                    ['personBox', 'Person box'],
                    ['maskBounds', 'Mask bounds'],
                    ['garmentBox', 'Garment box'],
                    ['cropBox', 'Crop box'],
                  ] as [keyof OverlayToggles, string][]
                ).map(([key, label]) => (
                  <label key={key} className="flex cursor-pointer items-center gap-1.5 text-[11px]">
                    <input
                      type="checkbox"
                      checked={toggles[key]}
                      onChange={event => setToggles(t => ({ ...t, [key]: event.target.checked }))}
                      className="h-3 w-3 accent-[var(--color-accent)]"
                    />
                    <span className="text-[var(--color-ink-muted)]">{label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <div className="space-y-1.5">
                <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-subtle)]">
                  Mask
                </p>
                <Select value={maskView} onChange={e => setMaskView(e.target.value as MaskView)}>
                  <option value="none">Off</option>
                  <option value="person" disabled={!image.assets.personMask}>
                    Person matte {!image.assets.personMask && '(unavailable)'}
                  </option>
                  <option value="garment" disabled={!image.assets.garmentMask}>
                    Garment mask {!image.assets.garmentMask && '(unavailable)'}
                  </option>
                  <option value="cutout" disabled={!image.assets.cutout}>
                    Cutout {!image.assets.cutout && '(unavailable)'}
                  </option>
                </Select>
              </div>

              {maskView !== 'none' && (
                <div className="space-y-1">
                  <label className="flex items-baseline justify-between text-[11px] text-[var(--color-ink-subtle)]">
                    Opacity
                    <span className="numeric">{Math.round(maskOpacity * 100)}%</span>
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={maskOpacity}
                    onChange={e => setMaskOpacity(Number(e.target.value))}
                    className="w-full"
                  />
                </div>
              )}

              <div className="space-y-1.5">
                <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-subtle)]">
                  Framing preview
                </p>
                <Select value={templateId} onChange={e => setTemplateId(e.target.value)}>
                  <option value="">No template</option>
                  {templates.map(template => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </Select>
              </div>

              {framing && (
                <Toggle
                  label="Before / after"
                  checked={compare}
                  onChange={setCompare}
                  hint="Original beside the framed result."
                />
              )}
            </div>
          </div>

          <div className="border-t border-[var(--color-border)] px-4 py-2">
            <LandmarkLegend />
          </div>
        </Panel>

        {/* Framing result */}
        {framing && <FramingReport framing={framing} />}
      </div>

      {/* ── Sidebar ────────────────────────────────────────────────────────── */}
      <div className="space-y-3">
        <Panel>
          <PanelHeader
            title="Quality"
            description={`${vision.provider} · ${vision.durationMs}ms`}
            action={
              <Button size="sm" variant="ghost" onClick={reanalyze} disabled={reanalyzing}>
                {reanalyzing ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <RefreshCw size={12} />
                )}
                Re-analyse
              </Button>
            }
          />
          <div className="space-y-3 px-4 py-3">
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-[var(--color-ink-muted)]">Overall</span>
                <span className="numeric text-sm font-semibold">
                  {percent(vision.quality.overall)}
                </span>
              </div>
              <Progress value={vision.quality.overall} />
            </div>

            <DataList
              rows={[
                { label: 'Detection', value: percent(vision.quality.detection) },
                { label: 'Landmarks', value: percent(vision.quality.landmarks) },
                { label: 'Segmentation', value: percent(vision.quality.segmentation) },
              ]}
            />

            {vision.quality.warnings.length > 0 && (
              <div className="space-y-1.5 border-t border-[var(--color-border)] pt-3">
                {vision.quality.warnings.map((warning, index) => (
                  <div key={index} className="flex items-start gap-1.5">
                    {warning.severity === 'error' ? (
                      <XCircle size={12} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
                    ) : warning.severity === 'warning' ? (
                      <AlertTriangle size={12} className="mt-0.5 shrink-0 text-[var(--color-warning)]" />
                    ) : (
                      <Info size={12} className="mt-0.5 shrink-0 text-[var(--color-ink-subtle)]" />
                    )}
                    <p className="text-[11px] leading-snug text-[var(--color-ink-muted)]">
                      {warning.message}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Classification" />
          <div className="px-4 py-3">
            <DataList
              rows={[
                { label: 'Shot type', value: humanize(vision.shot.type) },
                { label: 'Confidence', value: percent(vision.shot.confidence) },
                { label: 'Garment', value: humanize(vision.garment.type) },
                { label: 'Sleeves', value: humanize(vision.garment.sleeveLength) },
                { label: 'Neckline', value: humanize(vision.garment.neckline) },
                {
                  label: 'Body coverage',
                  value: percent(vision.garment.bodyCoverage),
                },
                {
                  label: 'Hem',
                  value: vision.garment.hemCropped
                    ? 'cropped at frame edge'
                    : vision.garment.hemY !== null
                      ? `${Math.round(vision.garment.hemY)}px`
                      : '—',
                },
              ]}
            />
            <p className="mt-2 border-t border-[var(--color-border)] pt-2 text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
              {vision.shot.reasoning}
            </p>
          </div>
        </Panel>

        <Panel>
          <PanelHeader
            title="Anchors"
            description="Hover a row to highlight it on the image."
            action={<Badge>{anchorEntries.length}</Badge>}
          />
          <div className="max-h-80 overflow-y-auto">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-[var(--color-surface)]">
                <tr className="text-left text-[var(--color-ink-subtle)]">
                  <th className="px-3 py-1.5 font-medium">Anchor</th>
                  <th className="px-2 py-1.5 text-right font-medium">y%</th>
                  <th className="px-2 py-1.5 text-right font-medium">conf</th>
                  <th className="px-3 py-1.5 font-medium">source</th>
                </tr>
              </thead>
              <tbody>
                {anchorEntries.map(([name, anchor]) => (
                  <tr
                    key={name}
                    onMouseEnter={() => setHoveredAnchor(name)}
                    onMouseLeave={() => setHoveredAnchor(null)}
                    className="cursor-default border-t border-[var(--color-border)] transition-colors hover:bg-[var(--color-surface-raised)]"
                  >
                    <td className="px-3 py-1.5 font-mono">{name}</td>
                    <td className="numeric px-2 py-1.5 text-right">
                      {((anchor.y / vision.image.height) * 100).toFixed(1)}
                    </td>
                    <td
                      className={cn(
                        'numeric px-2 py-1.5 text-right',
                        anchor.confidence < 0.4 && 'text-[var(--color-warning)]'
                      )}
                    >
                      {anchor.confidence.toFixed(2)}
                    </td>
                    <td className="px-3 py-1.5 text-[var(--color-ink-subtle)]">{anchor.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Detections" />
          <div className="px-4 py-3">
            <DataList
              rows={[
                {
                  label: 'People',
                  value: `${vision.persons.length}${person ? ` · ${person.score.toFixed(2)}` : ''}`,
                },
                {
                  label: 'Keypoints',
                  value: person ? `${person.visibleKeypointCount} / 17` : '—',
                },
                {
                  label: 'Faces',
                  value: `${vision.faces.length}${face ? ` · ${face.score.toFixed(2)}` : ''}`,
                },
                {
                  label: 'Head roll',
                  value: face?.roll != null ? `${face.roll.toFixed(1)}°` : '—',
                },
                {
                  label: 'Person matte',
                  value: vision.segmentation.person
                    ? `${percent(vision.segmentation.person.coverage)} of frame`
                    : 'unavailable',
                },
                {
                  label: 'Garment mask',
                  value: vision.segmentation.garment
                    ? `${percent(vision.segmentation.garment.coverage)} of frame`
                    : 'unavailable',
                },
              ]}
            />
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Source" />
          <div className="px-4 py-3">
            <DataList
              rows={[
                { label: 'File', value: <span className="font-mono">{image.fileName}</span> },
                { label: 'Dimensions', value: `${image.width} × ${image.height}` },
                { label: 'Size', value: formatBytes(image.byteSize) },
                { label: 'Type', value: image.mimeType },
                { label: 'Alpha', value: image.hasAlpha ? 'yes' : 'no' },
                ...(image.colorSpace ? [{ label: 'Colour space', value: image.colorSpace }] : []),
                ...(image.exifOrientation
                  ? [{ label: 'EXIF orientation', value: String(image.exifOrientation) }]
                  : []),
                ...(image.cameraMake || image.cameraModel
                  ? [
                      {
                        label: 'Camera',
                        value: [image.cameraMake, image.cameraModel].filter(Boolean).join(' '),
                      },
                    ]
                  : []),
                ...(image.capturedAt
                  ? [{ label: 'Captured', value: new Date(image.capturedAt).toLocaleDateString() }]
                  : []),
                {
                  label: 'Content hash',
                  value: <span className="font-mono">{image.sourceHash.slice(0, 12)}…</span>,
                },
              ]}
            />
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Engine" />
          <div className="px-4 py-3">
            <DataList
              rows={[
                ...Object.entries(vision.modelVersions).map(([id, version]) => ({
                  label: id,
                  value: <span className="font-mono text-[10px]">{version}</span>,
                })),
                ...Object.entries(vision.timings).map(([stage, ms]) => ({
                  label: `${stage} time`,
                  value: `${ms}ms`,
                })),
              ]}
            />
          </div>
        </Panel>
      </div>
    </div>
  )
}

// ─── Framing report ──────────────────────────────────────────────────────────

function FramingReport({ framing }: { framing: FramingResult }) {
  return (
    <Panel>
      <PanelHeader
        title={
          <span className="flex items-center gap-1.5">
            <Ruler size={13} /> Resolved framing
          </span>
        }
        description={framing.strategyLabel}
        action={
          framing.usedFallback ? <Badge tone="warning">fallback</Badge> : <Badge tone="positive">primary rule</Badge>
        }
      />

      <div className="grid gap-4 px-4 py-3 sm:grid-cols-2">
        <DataList
          rows={[
            {
              label: 'Crop',
              value: `${Math.round(framing.crop.x)}, ${Math.round(framing.crop.y)} · ${Math.round(framing.crop.width)} × ${Math.round(framing.crop.height)}`,
            },
            { label: 'Magnification', value: `${framing.upscale.toFixed(2)}×` },
            { label: 'Canvas', value: `${framing.canvas.width} × ${framing.canvas.height}` },
            { label: 'Strategy', value: <span className="font-mono">{framing.strategyId}</span> },
          ]}
        />

        <div>
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-subtle)]">
            Anchor placement
          </p>
          {framing.placements.length === 0 ? (
            <p className="text-[11px] text-[var(--color-ink-subtle)]">
              This strategy references no anchors.
            </p>
          ) : (
            <ul className="space-y-1">
              {framing.placements.map(placement => (
                <li key={placement.anchor} className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-[11px] text-[var(--color-ink-muted)]">
                    {placement.anchor}
                  </span>
                  <span className="numeric text-[11px]">
                    {placement.target ? (
                      <>
                        y {Math.round(placement.canvas.y)}
                        <span className="text-[var(--color-ink-subtle)]">
                          {' '}
                          / {Math.round(placement.target.y)}
                        </span>
                        {placement.error && Math.abs(placement.error.y) > 1 && (
                          <span className="ml-1 text-[var(--color-warning)]">
                            {placement.error.y > 0 ? '+' : ''}
                            {Math.round(placement.error.y)}px
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-[var(--color-ink-subtle)]">
                        y {Math.round(placement.canvas.y)}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {framing.violations.length > 0 && (
        <div className="space-y-1.5 border-t border-[var(--color-border)] px-4 py-3">
          {framing.violations.map((violation, index) => (
            <div key={index} className="flex items-start gap-1.5">
              {violation.severity === 'warning' ? (
                <AlertTriangle size={12} className="mt-0.5 shrink-0 text-[var(--color-warning)]" />
              ) : (
                <Info size={12} className="mt-0.5 shrink-0 text-[var(--color-ink-subtle)]" />
              )}
              <p className="text-[11px] leading-snug text-[var(--color-ink-muted)]">
                {violation.message}
              </p>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}

// ─── Before / after ──────────────────────────────────────────────────────────

/**
 * Original beside the framed result.
 *
 * The right-hand side is built from the same crop the renderer will use, so
 * this is a true preview of the framing decision, not an approximation.
 */
function BeforeAfter({
  image,
  framing,
}: {
  image: ProductImageDetail
  framing: FramingResult
}) {
  const crop = framing.crop
  const scalePct = (image.width / crop.width) * 100
  const leftPct = (-crop.x / crop.width) * 100
  const topPct = (-crop.y / crop.height) * 100
  const heightPct = (image.height / crop.height) * 100

  return (
    <div className="grid grid-cols-2 gap-px bg-[var(--color-border)]">
      <figure className="bg-[var(--color-canvas)]">
        <img
          src={image.originalUrl}
          alt="Original"
          className="mx-auto block h-auto w-full"
          style={{ maxHeight: '70vh', objectFit: 'contain' }}
        />
        <figcaption className="px-3 py-1.5 text-[11px] text-[var(--color-ink-subtle)]">
          Original · {image.width} × {image.height}
        </figcaption>
      </figure>

      <figure className="bg-[var(--color-canvas)]">
        <div
          className="relative mx-auto overflow-hidden"
          style={{
            aspectRatio: `${framing.canvas.width} / ${framing.canvas.height}`,
            maxHeight: '70vh',
          }}
        >
          <img
            src={image.originalUrl}
            alt="Framed"
            className="absolute max-w-none"
            style={{
              left: `${leftPct}%`,
              top: `${topPct}%`,
              width: `${scalePct}%`,
              height: `${heightPct}%`,
            }}
          />
        </div>
        <figcaption className="px-3 py-1.5 text-[11px] text-[var(--color-ink-subtle)]">
          Framed · {framing.canvas.width} × {framing.canvas.height} · {framing.upscale.toFixed(2)}×
        </figcaption>
      </figure>
    </div>
  )
}
