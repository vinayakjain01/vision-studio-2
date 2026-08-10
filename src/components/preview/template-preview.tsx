/**
 * Live preview.
 *
 * Renders a template against a subject entirely in the browser, and re-renders
 * synchronously on every control change.
 *
 * ── Why it is instant ────────────────────────────────────────────────────────
 * The framing comes from `solveFraming()` — the same isomorphic function the
 * server compositor calls — running against anchors already in memory. Nothing
 * here fetches, debounces, or waits on a server render. Dragging the "head at
 * N%" slider is a `useMemo` over a few dozen arithmetic operations, so the
 * preview tracks the pointer at frame rate.
 *
 * ── Why it matches the output ────────────────────────────────────────────────
 * The crop rectangle is authoritative and shared, so subject placement is
 * pixel-equivalent to the server's by construction, not by two implementations
 * agreeing. What CSS approximates is layer rasterisation — text metrics,
 * blur, supersampled edges. Those differ in the last pixel, never in framing,
 * and the builder offers a real server render for a final check.
 *
 * The subject is drawn by absolutely positioning the full image inside a
 * clipping box and scaling it, which is exactly the transform the crop encodes:
 *   scale       = canvasWidth / crop.width
 *   translation = -crop.x * scale, -crop.y * scale
 */

'use client'

import * as React from 'react'
import { solveFraming } from '@/framing/solver'
import type { FramingResult, FramingSubject } from '@/framing/types'
import type {
  BadgeLayer,
  ImageLayer,
  Layer,
  TemplateDocument,
  TemplateVariableValues,
  TextLayer,
} from '@/templates/types'
import { resolveTemplateVariables } from '@/templates/types'
import { mediaUrlFor } from '@/lib/media'
import { cn } from '@/lib/utils'
import { LandmarkOverlay, type OverlayToggles } from '@/components/vision/landmark-overlay'
import type { Box, FaceDetection, PersonDetection } from '@/vision/types'

export interface LivePreviewProps {
  subject: FramingSubject
  imageUrl: string
  template: TemplateDocument
  variables?: Partial<TemplateVariableValues>
  /** Draw the landmark overlay in canvas space over the framed result. */
  showOverlay?: boolean
  overlayToggles?: Partial<OverlayToggles>
  persons?: PersonDetection[]
  faces?: FaceDetection[]
  garmentBox?: Box | null
  className?: string
  /**
   * Pre-solved framing. Supply it when the parent already needs the result for
   * its own purposes — an aggregate summary, say — so the same crop is not
   * solved twice.
   *
   * Deliberately an input rather than an `onFramingChange` output. Reporting the
   * result upward from an effect and storing it in parent state is an infinite
   * loop: `solveFraming` returns a fresh object each call, so no
   * reference-equality guard in the setter can hold, and every resulting state
   * commit re-renders the parent into new props that re-solve and fire the
   * effect again. Framing is derived data — the owner of the inputs should own
   * the computation.
   */
  framing?: FramingResult
}

export function LivePreview({
  subject,
  imageUrl,
  template,
  variables = {},
  showOverlay = false,
  overlayToggles,
  persons = [],
  faces = [],
  garmentBox = null,
  className,
  framing: providedFraming,
}: LivePreviewProps) {
  const canvas = template.canvas

  // The single computation the whole preview depends on. Solved locally when the
  // caller did not supply a result, so the component stays usable standalone.
  const framing = React.useMemo(
    () =>
      providedFraming ??
      solveFraming(subject, template.framing, { width: canvas.width, height: canvas.height }),
    [providedFraming, subject, template.framing, canvas.width, canvas.height]
  )

  const layers = React.useMemo(
    () => [...template.layers].filter(l => l.visible).sort((a, b) => a.zIndex - b.zIndex),
    [template.layers]
  )

  const below = layers.filter(l => l.zIndex < template.subjectZIndex)
  const above = layers.filter(l => l.zIndex >= template.subjectZIndex)

  // Percentages of the canvas, so the preview is resolution-independent and the
  // container can be any size.
  const crop = framing.crop
  const scalePct = (subject.image.width / crop.width) * 100
  const leftPct = (-crop.x / crop.width) * 100
  const topPct = (-crop.y / crop.height) * 100
  const heightPct = (subject.image.height / crop.height) * 100

  return (
    <div
      className={cn('relative overflow-hidden', className)}
      style={{
        aspectRatio: `${canvas.width} / ${canvas.height}`,
        // Establishes the query container that layer font sizes resolve `cqh`
        // against. Without `container-type: size` the unit falls back to the
        // viewport and text scales with the window instead of the canvas.
        containerType: 'size',
      }}
    >
      <BackgroundLayer template={template} imageUrl={imageUrl} framing={framing} subject={subject} />

      {below.map(layer => (
        <LayerView
          key={layer.id}
          layer={layer}
          canvas={canvas}
          framing={framing}
          variables={variables}
        />
      ))}

      {/* The framed subject. */}
      <div className="absolute inset-0 overflow-hidden">
        <img
          src={imageUrl}
          alt=""
          draggable={false}
          className="absolute max-w-none select-none"
          style={{
            left: `${leftPct}%`,
            top: `${topPct}%`,
            width: `${scalePct}%`,
            height: `${heightPct}%`,
          }}
        />

        {showOverlay && (
          <div
            className="absolute"
            style={{
              left: `${leftPct}%`,
              top: `${topPct}%`,
              width: `${scalePct}%`,
              height: `${heightPct}%`,
            }}
          >
            <LandmarkOverlay
              image={subject.image}
              anchors={subject.anchors}
              persons={persons}
              primaryPersonIndex={persons.length > 0 ? 0 : null}
              faces={faces}
              primaryFaceIndex={faces.length > 0 ? 0 : null}
              garmentBox={garmentBox}
              // The crop IS the frame here, so drawing it again would just dim
              // everything the operator is looking at.
              toggles={{ cropBox: false, ...overlayToggles }}
            />
          </div>
        )}
      </div>

      {above.map(layer => (
        <LayerView
          key={layer.id}
          layer={layer}
          canvas={canvas}
          framing={framing}
          variables={variables}
        />
      ))}
    </div>
  )
}

// ─── Background ──────────────────────────────────────────────────────────────

function BackgroundLayer({
  template,
  imageUrl,
  framing,
  subject,
}: {
  template: TemplateDocument
  imageUrl: string
  framing: FramingResult
  subject: FramingSubject
}) {
  const bg = template.background

  if (bg.mode === 'gradient') {
    return (
      <div
        className="absolute inset-0"
        style={{
          background: `linear-gradient(${bg.gradientAngle}deg, ${bg.gradientFrom}, ${bg.gradientTo})`,
        }}
      />
    )
  }

  if (bg.mode === 'blur_extend' || bg.mode === 'edge_extend') {
    const crop = framing.crop
    const scalePct = (subject.image.width / crop.width) * 100
    const leftPct = (-crop.x / crop.width) * 100
    const topPct = (-crop.y / crop.height) * 100
    const heightPct = (subject.image.height / crop.height) * 100

    return (
      <div className="absolute inset-0 overflow-hidden" style={{ background: bg.color }}>
        <div
          className="absolute inset-0"
          style={{
            transform: `scale(${bg.mode === 'blur_extend' ? bg.blurZoom : 1})`,
            filter: bg.mode === 'blur_extend' ? `blur(${bg.blurRadius}px)` : undefined,
          }}
        >
          <img
            src={imageUrl}
            alt=""
            draggable={false}
            className="absolute max-w-none select-none"
            style={{
              left: `${leftPct}%`,
              top: `${topPct}%`,
              width: `${scalePct}%`,
              height: `${heightPct}%`,
            }}
          />
        </div>
      </div>
    )
  }

  return <div className="absolute inset-0" style={{ background: bg.color }} />
}

// ─── Layers ──────────────────────────────────────────────────────────────────

function LayerView({
  layer,
  canvas,
  framing,
  variables,
}: {
  layer: Layer
  canvas: TemplateDocument['canvas']
  framing: FramingResult
  variables: Partial<TemplateVariableValues>
}) {
  // Landmark-pinned layers offset from where the anchor landed, mirroring
  // `layerRect` in the server compositor.
  let originX = 0
  let originY = 0
  if (layer.anchorTo) {
    const placement = framing.placements.find(p => p.anchor === layer.anchorTo)
    if (placement) {
      originX = (placement.canvas.x / canvas.width) * 100
      originY = (placement.canvas.y / canvas.height) * 100
    }
  }

  const style: React.CSSProperties = {
    position: 'absolute',
    left: `${originX + layer.x}%`,
    top: `${originY + layer.y}%`,
    width: `${layer.width}%`,
    height: `${layer.height}%`,
    opacity: layer.opacity,
    transform: layer.rotation ? `rotate(${layer.rotation}deg)` : undefined,
    zIndex: layer.zIndex + 1,
  }

  switch (layer.type) {
    case 'text':
      return <TextLayerView layer={layer} style={style} canvas={canvas} variables={variables} />
    case 'badge':
      return <BadgeLayerView layer={layer} style={style} canvas={canvas} variables={variables} />
    case 'rectangle':
      return (
        <div
          style={{
            ...style,
            background: layer.fill,
            borderRadius: `${(layer.borderRadiusPct / 100) * canvas.width}px`,
            border:
              layer.strokeColor && layer.strokeWidthPct > 0
                ? `${(layer.strokeWidthPct / 100) * canvas.width}px solid ${layer.strokeColor}`
                : undefined,
          }}
        />
      )
    case 'ellipse':
      return (
        <div
          style={{
            ...style,
            background: layer.fill,
            borderRadius: '50%',
            border:
              layer.strokeColor && layer.strokeWidthPct > 0
                ? `${(layer.strokeWidthPct / 100) * canvas.width}px solid ${layer.strokeColor}`
                : undefined,
          }}
        />
      )
    case 'image':
      return <ImageLayerView layer={layer} style={style} canvas={canvas} />
  }
}

function TextLayerView({
  layer,
  style,
  canvas,
  variables,
}: {
  layer: TextLayer
  style: React.CSSProperties
  canvas: TemplateDocument['canvas']
  variables: Partial<TemplateVariableValues>
}) {
  let content = resolveTemplateVariables(layer.content, variables)
  if (layer.uppercase) content = content.toUpperCase()

  return (
    <div
      style={{
        ...style,
        // Font size is a percentage of canvas HEIGHT, matching the compositor.
        // `cqh` resolves that against the preview container, so the text scales
        // with the preview exactly as it will with the output.
        fontSize: `${layer.fontSizePct}cqh`,
        fontFamily: layer.fontFamily,
        fontWeight: layer.fontWeight === 'bold' ? 700 : 400,
        color: layer.color,
        textAlign: layer.align,
        lineHeight: layer.lineHeight,
        letterSpacing: `${layer.letterSpacing}px`,
        whiteSpace: layer.wrap ? 'pre-wrap' : 'pre',
        overflowWrap: layer.wrap ? 'break-word' : 'normal',
        background: layer.backgroundColor ?? undefined,
        padding: `${(layer.paddingPct / 100) * canvas.width}px`,
        borderRadius: `${(layer.borderRadiusPct / 100) * canvas.width}px`,
      }}
    >
      {content}
    </div>
  )
}

function BadgeLayerView({
  layer,
  style,
  canvas,
  variables,
}: {
  layer: BadgeLayer
  style: React.CSSProperties
  canvas: TemplateDocument['canvas']
  variables: Partial<TemplateVariableValues>
}) {
  let content = resolveTemplateVariables(layer.content, variables)
  if (layer.uppercase) content = content.toUpperCase()

  return (
    <div
      style={{
        ...style,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: layer.fill,
        color: layer.color,
        fontFamily: layer.fontFamily,
        fontSize: `${layer.fontSizePct}cqh`,
        fontWeight: layer.fontWeight === 'bold' ? 700 : 400,
        borderRadius:
          layer.shape === 'circle'
            ? '50%'
            : layer.shape === 'pill'
              ? '9999px'
              : `${(2 / 100) * canvas.width}px`,
      }}
    >
      {content}
    </div>
  )
}

function ImageLayerView({
  layer,
  style,
  canvas,
}: {
  layer: ImageLayer
  style: React.CSSProperties
  canvas: TemplateDocument['canvas']
}) {
  if (!layer.assetKey) {
    return (
      <div
        style={{
          ...style,
          border: '1px dashed var(--color-border-strong)',
          borderRadius: 4,
        }}
      />
    )
  }

  return (
    <img
      src={mediaUrlFor('assets', layer.assetKey)}
      alt=""
      draggable={false}
      style={{
        ...style,
        objectFit: layer.fit,
        borderRadius: `${(layer.borderRadiusPct / 100) * canvas.width}px`,
      }}
    />
  )
}
