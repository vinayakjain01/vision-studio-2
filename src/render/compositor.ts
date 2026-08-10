/**
 * Server-side compositor.
 *
 * Renders one creative: solve the framing, draw the background, draw the
 * cropped subject, draw the layer stack, encode.
 *
 * ── One framing implementation ───────────────────────────────────────────────
 * The crop comes from `solveFraming()` in `src/framing/solver.ts` — the exact
 * function the browser preview calls. This module never computes a crop of its
 * own. Two renderers with two framing implementations drift, and a preview that
 * disagrees with the output is worse than no preview; keeping the geometry in
 * one isomorphic module is what prevents that. What differs here is only the
 * drawing surface: `@napi-rs/canvas` instead of CSS.
 *
 * ── Supersampling ────────────────────────────────────────────────────────────
 * Everything is drawn at `supersample`× the output size and downscaled once at
 * the end. Canvas has no anti-aliasing for image edges or rotated layers, so a
 * 1× render shows visible stair-stepping on any rotated badge or curved corner.
 *
 * Server-only.
 */

import { createCanvas, loadImage, GlobalFonts, type Canvas, type SKRSContext2D } from '@napi-rs/canvas'
import fs from 'fs'
import path from 'path'
import { solveFraming, sourceToCanvas } from '@/framing/solver'
import type { CropBox, FramingResult, FramingSubject } from '@/framing/types'
import type {
  BadgeLayer,
  BackgroundSettings,
  EllipseLayer,
  ImageLayer,
  Layer,
  RectangleLayer,
  TemplateDocument,
  TemplateVariableValues,
  TextLayer,
} from '@/templates/types'
import { resolveTemplateVariables } from '@/templates/types'
import type { VisionMetadata } from '@/vision/types'
import { config } from '@/config'
import { resolvePath } from '@/storage/media-store'
import sharp from 'sharp'
import crypto from 'crypto'

// ─── Fonts ───────────────────────────────────────────────────────────────────

let fontsRegistered = false

/**
 * Register bundled fonts once per process.
 *
 * Registered under their real family names. Craftify registers Noto Sans under
 * the family name "Inter", which makes every text layer render at the wrong
 * metrics while appearing to work — the label says Inter, the glyph advances
 * are Noto's, and wrapping computed from one does not match the other.
 */
function ensureFonts(): void {
  if (fontsRegistered) return
  fontsRegistered = true

  const fontDir = path.join(process.cwd(), 'public', 'fonts')
  if (!fs.existsSync(fontDir)) return

  for (const file of fs.readdirSync(fontDir)) {
    if (!/\.(ttf|otf|woff2?)$/i.test(file)) continue
    try {
      GlobalFonts.registerFromPath(path.join(fontDir, file))
    } catch (err) {
      console.warn(`[render] could not register font ${file}:`, (err as Error).message)
    }
  }
}

/** Families guaranteed to resolve. Falls back through the system stack. */
function fontStack(family: string): string {
  return `"${family}", "DejaVu Sans", "Liberation Sans", Arial, sans-serif`
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface RenderInput {
  /** Original image bytes. */
  source: Buffer
  /** Analysis for this image. Null renders a plain centred fit. */
  vision: VisionMetadata | null
  template: TemplateDocument
  variables: Partial<TemplateVariableValues>
  /** Longest output edge. Defaults to the configured maximum. */
  maxDimension?: number
  supersample?: number
  format?: 'jpeg' | 'png'
  quality?: number
  /**
   * The AI-Extended background, already generated and canvas-sized — bytes
   * of whatever `buildInpaintTarget()` + the inpaint service produced for this
   * exact (photo, framing) combination, read back from the derived-asset
   * cache by the caller (`handleRenderJob` in `src/jobs/worker.ts`).
   *
   * This module does not call the inpaint service itself, on purpose: it is
   * a pure, fast, synchronous-apart-from-image-decode compositor, and a
   * network round trip to a GPU host has no business inside it. Only
   * consulted when `template.background.mode === 'ai_extend'`; ignored, not
   * an error, for every other mode. If that mode IS set but this is absent —
   * the background-fill job has not produced one yet, or never needed to —
   * the same clamped-stretch safety net every other background mode uses
   * applies instead, so a render is never blocked on it.
   */
  precomputedBackground?: Buffer | null
}

export interface RenderOutput {
  buffer: Buffer
  mimeType: string
  width: number
  height: number
  framing: FramingResult
  durationMs: number
}

export async function renderCreative(input: RenderInput): Promise<RenderOutput> {
  const started = performance.now()
  ensureFonts()

  const { template } = input
  const outputSize = fitWithin(
    template.canvas.width,
    template.canvas.height,
    input.maxDimension ?? config.render.outputMaxDim
  )

  const supersample = Math.max(1, Math.min(3, input.supersample ?? config.render.supersample))
  const renderW = Math.round(outputSize.width * supersample)
  const renderH = Math.round(outputSize.height * supersample)

  const image = await loadImage(input.source)
  const sourceSize = { width: image.width, height: image.height }

  // Framing is solved against the TEMPLATE canvas, not the render surface.
  // Both share an aspect ratio, and the crop is in source pixels, so the result
  // is resolution-independent — the same crop at any output size.
  const subject = toFramingSubject(input.vision, sourceSize)

  // No eligibility gate here: a shot type this template has no matching
  // strategy for still gets a creative — `selectStrategy` falls through to the
  // chain's anchor-free last resort (a plain centred fit), and that fallback is
  // recorded in `framing.usedFallback`/`violations` for the UI to surface, not
  // treated as a reason to withhold output. Every photo gets an image; some
  // just get the generic fit instead of landmark framing.
  const framing = solveFraming(subject, template.framing, {
    width: template.canvas.width,
    height: template.canvas.height,
  })

  // Just a buffer decode — the actual generation already happened in the
  // `background_fill` job, if this template needed it at all. See the
  // `precomputedBackground` doc comment on `RenderInput` for why that call
  // never happens in here.
  const precomputedBackground = input.precomputedBackground
    ? await loadImage(input.precomputedBackground)
    : null

  const canvas = createCanvas(renderW, renderH)
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  drawBackground(ctx, template.background, renderW, renderH, image, framing.crop, precomputedBackground)

  // Layers below the subject, then the subject, then layers above it.
  const layers = [...template.layers]
    .filter(l => l.visible)
    .sort((a, b) => a.zIndex - b.zIndex)

  const below = layers.filter(l => l.zIndex < template.subjectZIndex)
  const above = layers.filter(l => l.zIndex >= template.subjectZIndex)

  for (const layer of below) {
    await drawLayer(ctx, layer, renderW, renderH, input.variables, framing, template)
  }

  drawSubject(ctx, image, framing.crop, renderW, renderH)

  for (const layer of above) {
    await drawLayer(ctx, layer, renderW, renderH, input.variables, framing, template)
  }

  const finalCanvas =
    supersample === 1 ? canvas : downscale(canvas, outputSize.width, outputSize.height)

  const format = input.format ?? 'jpeg'
  const buffer =
    format === 'png'
      ? await finalCanvas.encode('png')
      : await finalCanvas.encode('jpeg', input.quality ?? config.render.jpegQuality)

  return {
    buffer,
    mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
    width: outputSize.width,
    height: outputSize.height,
    framing,
    durationMs: Math.round(performance.now() - started),
  }
}

/**
 * Build the solver's input from an analysis.
 *
 * With no analysis there are no anchors, and every strategy chain falls through
 * to its anchor-free backstop — a centred fit. That is the correct behaviour
 * for an image still queued for analysis, and it is why the fallback rule in a
 * preset must never require anchors.
 */
export function toFramingSubject(
  vision: VisionMetadata | null,
  sourceSize: { width: number; height: number }
): FramingSubject {
  if (!vision) {
    return {
      image: sourceSize,
      anchors: {},
      shotType: 'unknown',
      subjectBox: null,
    }
  }

  const primaryPerson =
    vision.primaryPersonIndex !== null ? vision.persons[vision.primaryPersonIndex] : null

  return {
    image: vision.image,
    anchors: vision.anchors,
    shotType: vision.shot.type,
    subjectBox:
      vision.segmentation.person?.bbox ?? primaryPerson?.box ?? vision.garment.box ?? null,
  }
}

// ─── Background ──────────────────────────────────────────────────────────────

function drawBackground(
  ctx: SKRSContext2D,
  background: BackgroundSettings,
  width: number,
  height: number,
  image: Awaited<ReturnType<typeof loadImage>>,
  crop: CropBox,
  precomputedBackground: Awaited<ReturnType<typeof loadImage>> | null
): void {
  switch (background.mode) {
    case 'ai_extend': {
      ctx.fillStyle = background.color
      ctx.fillRect(0, 0, width, height)
      if (precomputedBackground) {
        // Already canvas-sized — it was generated FROM this exact canvas (see
        // `buildInpaintTarget`), so this is a plain scale-to-fit, not the
        // crop-region remapping the other modes need.
        ctx.save()
        ctx.drawImage(precomputedBackground as any, 0, 0, width, height)
        ctx.restore()
        return
      }
      // The background-fill job hasn't produced one yet (or never needed
      // to — no overflow). Same clamped-stretch safety net every other mode
      // uses, so this is never a blank gap while that job is in flight.
      drawStretchedClamped(ctx, image, crop, width, height)
      return
    }
    case 'gradient': {
      const angle = ((background.gradientAngle % 360) * Math.PI) / 180
      // Project the canvas diagonal onto the gradient axis so the ramp spans
      // the full canvas at any angle.
      const cx = width / 2
      const cy = height / 2
      const halfSpan = (Math.abs(width * Math.sin(angle)) + Math.abs(height * Math.cos(angle))) / 2
      const dx = Math.sin(angle) * halfSpan
      const dy = -Math.cos(angle) * halfSpan
      const gradient = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy)
      gradient.addColorStop(0, background.gradientFrom)
      gradient.addColorStop(1, background.gradientTo)
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, width, height)
      return
    }

    case 'blur_extend': {
      // Fill first: the blurred copy may not cover every pixel once zoomed.
      ctx.fillStyle = background.color
      ctx.fillRect(0, 0, width, height)
      drawBlurredFill(ctx, image, crop, width, height, background)
      return
    }

    case 'edge_extend': {
      ctx.fillStyle = background.color
      ctx.fillRect(0, 0, width, height)
      // Stretch the crop's own pixels to fill — cheaper than a blur and enough
      // when the backdrop is a plain seamless.
      drawStretchedClamped(ctx, image, crop, width, height)
      return
    }

    case 'solid':
    default:
      ctx.fillStyle = background.color
      ctx.fillRect(0, 0, width, height)
  }
}

/**
 * Stretch an image's crop region to fill the destination exactly, even when
 * the crop extends past the image's real bounds (overflow policy `allow`,
 * or a generative-fill call that failed and fell back to the plain source).
 *
 * `ctx.drawImage` does not clip an out-of-range source rectangle the way a
 * caller might expect — it silently draws nothing for the portion outside
 * the image, leaving whatever the base fill painted showing through as a
 * hard-edged blank band. This draws only the valid intersection, stretched
 * across the FULL destination, so a background layer always covers the
 * canvas: distorted is an acceptable trade for a backdrop fallback, a
 * leftover flat-colour gap is not — that gap is the exact defect every mode
 * in this switch exists to avoid.
 */
function drawStretchedClamped(
  ctx: SKRSContext2D,
  image: Awaited<ReturnType<typeof loadImage>>,
  crop: CropBox,
  width: number,
  height: number
): void {
  const sx = Math.max(0, crop.x)
  const sy = Math.max(0, crop.y)
  const sRight = Math.min(image.width, crop.x + crop.width)
  const sBottom = Math.min(image.height, crop.y + crop.height)
  const sw = sRight - sx
  const sh = sBottom - sy
  if (sw <= 0 || sh <= 0) return

  ctx.save()
  ctx.drawImage(image as any, sx, sy, sw, sh, 0, 0, width, height)
  ctx.restore()
}

/**
 * Blurred, zoomed copy of the crop behind the subject.
 *
 * Canvas has no blur primitive, so the blur is done by downscaling to a small
 * offscreen canvas and drawing it back up with smoothing on. That is a genuine
 * low-pass filter — the downscale averages neighbourhoods — and costs a
 * fraction of a separable convolution over a 4000px canvas.
 */
function drawBlurredFill(
  ctx: SKRSContext2D,
  image: Awaited<ReturnType<typeof loadImage>>,
  crop: CropBox,
  width: number,
  height: number,
  background: BackgroundSettings
): void {
  // Blur radius drives how far down we go: a bigger radius means a smaller
  // intermediate, hence more averaging per output pixel.
  const divisor = Math.max(2, Math.min(64, background.blurRadius))
  const smallW = Math.max(2, Math.round(width / divisor))
  const smallH = Math.max(2, Math.round(height / divisor))

  const small = createCanvas(smallW, smallH)
  const smallCtx = small.getContext('2d')
  smallCtx.imageSmoothingEnabled = true
  smallCtx.imageSmoothingQuality = 'high'
  drawStretchedClamped(smallCtx, image, crop, smallW, smallH)

  const zoom = Math.max(1, background.blurZoom)
  const drawW = width * zoom
  const drawH = height * zoom

  ctx.save()
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(
    small as any,
    (width - drawW) / 2,
    (height - drawH) / 2,
    drawW,
    drawH
  )
  ctx.restore()
}

// ─── Subject ─────────────────────────────────────────────────────────────────

interface PlacedRect {
  /** Destination rectangle, canvas pixels. */
  x: number
  y: number
  width: number
  height: number
  /** The matching intersected SOURCE rectangle, source pixels. */
  sourceX: number
  sourceY: number
  sourceWidth: number
  sourceHeight: number
}

/**
 * Where `drawSubject` places the photo on the canvas — the intersection of
 * the crop with the real image, mapped to its proportional slice of the
 * destination. Pulled out on its own because `buildInpaintTarget` below
 * needs the EXACT same rectangle for its mask: the mask marks "protect" over
 * precisely the pixels the photo actually occupies, and computing that
 * separately would risk the two drifting apart by a rounding error at the
 * one boundary where it would actually show.
 */
function placedRect(
  image: Awaited<ReturnType<typeof loadImage>>,
  crop: CropBox,
  width: number,
  height: number
): PlacedRect | null {
  const sx = Math.max(0, crop.x)
  const sy = Math.max(0, crop.y)
  const sRight = Math.min(image.width, crop.x + crop.width)
  const sBottom = Math.min(image.height, crop.y + crop.height)

  const sw = sRight - sx
  const sh = sBottom - sy
  if (sw <= 0 || sh <= 0) return null

  const scaleX = width / crop.width
  const scaleY = height / crop.height

  return {
    x: (sx - crop.x) * scaleX,
    y: (sy - crop.y) * scaleY,
    width: sw * scaleX,
    height: sh * scaleY,
    // Carried through so the caller can re-derive the matching source rect
    // without recomputing the intersection.
    sourceX: sx,
    sourceY: sy,
    sourceWidth: sw,
    sourceHeight: sh,
  }
}

/**
 * Draw the framed crop.
 *
 * The crop may extend past the source (overflow policy `allow`), and Canvas
 * clips a negative source rect rather than padding it. So the intersection with
 * the real image is computed and mapped to its proportional slice of the
 * destination — the exposed remainder keeps whatever the background painted,
 * which is exactly the intent.
 */
function drawSubject(
  ctx: SKRSContext2D,
  image: Awaited<ReturnType<typeof loadImage>>,
  crop: CropBox,
  width: number,
  height: number
): void {
  const placed = placedRect(image, crop, width, height)
  if (!placed) return

  ctx.drawImage(
    image as any,
    placed.sourceX,
    placed.sourceY,
    placed.sourceWidth,
    placed.sourceHeight,
    placed.x,
    placed.y,
    placed.width,
    placed.height
  )
}

// ─── Inpaint target (AI Extend) ─────────────────────────────────────────────

/**
 * How much of the canvas a photo's solved crop leaves outside itself, without
 * paying for the padded-image/mask encode `buildInpaintTarget` does. Used to
 * decide WHETHER a `background_fill` job is even needed and to compute its
 * cache key — both need only the number, not the pixels — before committing
 * to building them.
 */
export async function computeOverflow(
  source: Buffer,
  vision: VisionMetadata | null,
  template: TemplateDocument
): Promise<FramingResult['overflow']> {
  const image = await loadImage(source)
  const subject = toFramingSubject(vision, { width: image.width, height: image.height })
  const framing = solveFraming(subject, template.framing, {
    width: template.canvas.width,
    height: template.canvas.height,
  })
  return framing.overflow
}

/** True when there is enough overflow to be worth generating a fill for. */
export function hasOverflow(overflow: FramingResult['overflow']): boolean {
  return overflow.left > 0.5 || overflow.top > 0.5 || overflow.right > 0.5 || overflow.bottom > 0.5
}

/**
 * The derived-asset "kind" (see `src/storage/media-store.ts`) an AI-Extend
 * background is cached under: the source photo hash is the content-address
 * root, and this is everything else that changes what gets generated for it
 * — the exact padding needed (a photo's framing can change independently of
 * its own pixels) and the prompt (a template's `backdropPrompt` can change
 * without the photo or the padding changing at all). Same inputs, same key,
 * on both the write side (`background_fill` job) and the read side (a render
 * job deciding whether it needs to wait on one) — computed here once so the
 * two can never drift apart from re-deriving it slightly differently.
 */
export function inpaintCacheKind(overflow: FramingResult['overflow'], prompt: string): string {
  const left = Math.max(0, Math.round(overflow.left))
  const top = Math.max(0, Math.round(overflow.top))
  const right = Math.max(0, Math.round(overflow.right))
  const bottom = Math.max(0, Math.round(overflow.bottom))
  const promptFingerprint = crypto
    .createHash('sha256')
    .update(prompt || '')
    .digest('hex')
    .slice(0, 12)
  return `aiextend_${left}_${top}_${right}_${bottom}_${promptFingerprint}`
}

export interface InpaintTarget {
  /** Canvas-sized JPEG: the photo placed per the template's own framing, blank white elsewhere. */
  paddedImage: Buffer
  /** Canvas-sized, feathered grayscale PNG mask: white = generate, black = protect. */
  mask: Buffer
  /** From the same `solveFraming()` call — callers use this as part of the cache key. */
  overflow: FramingResult['overflow']
  width: number
  height: number
}

/**
 * Build the two images `services/inpaint-service` needs: the photo placed
 * exactly where this template's own framing puts it, and a mask marking
 * everywhere else as generate-me. Returns `null` when the crop already fills
 * the canvas — there is nothing to inpaint, so no service call is worth
 * making.
 *
 * Runs the SAME `solveFraming()` this module always uses for the real render
 * (see the module doc comment — one framing implementation, not two that can
 * disagree), so what the model is asked to extend from is pixel-identical to
 * where the photo actually ends up. Solving it independently here, even
 * correctly, would drift out of sync with the render the moment either one's
 * inputs changed without the other being re-run.
 */
export async function buildInpaintTarget(
  source: Buffer,
  vision: VisionMetadata | null,
  template: TemplateDocument,
  featherPx = 12
): Promise<InpaintTarget | null> {
  const image = await loadImage(source)
  const subject = toFramingSubject(vision, { width: image.width, height: image.height })
  const framing = solveFraming(subject, template.framing, {
    width: template.canvas.width,
    height: template.canvas.height,
  })

  const { left, top, right, bottom } = framing.overflow
  if (left <= 0.5 && top <= 0.5 && right <= 0.5 && bottom <= 0.5) return null

  const width = template.canvas.width
  const height = template.canvas.height

  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  drawSubject(ctx, image, framing.crop, width, height)
  const paddedImage = await canvas.encode('jpeg', 95)

  const maskCanvas = createCanvas(width, height)
  const maskCtx = maskCanvas.getContext('2d')
  maskCtx.fillStyle = '#ffffff'
  maskCtx.fillRect(0, 0, width, height)
  const placed = placedRect(image, framing.crop, width, height)
  if (placed) {
    maskCtx.fillStyle = '#000000'
    maskCtx.fillRect(placed.x, placed.y, placed.width, placed.height)
  }
  const hardMask = await maskCanvas.encode('png')

  // A hard cutoff reads as a visible seam even when the generated content is
  // a good match. Canvas has no blur primitive (see `drawBlurredFill`
  // above), so the softening is done with `sharp`, already a dependency —
  // a real Gaussian blur here, turning the cutoff into a gradient the
  // pipeline blends across instead of a line it has to match exactly.
  const mask = await sharp(hardMask)
    .grayscale()
    .blur(Math.max(0.3, featherPx / 3))
    .png()
    .toBuffer()

  return { paddedImage, mask, overflow: framing.overflow, width, height }
}

// ─── Layers ──────────────────────────────────────────────────────────────────

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * A layer's pixel rectangle.
 *
 * Percentages resolve against the canvas. When `anchorTo` is set they instead
 * resolve as an OFFSET from where that landmark landed after framing — so a
 * badge pinned to `shoulder_right` tracks the model across a catalog instead of
 * sitting at a fixed spot that sometimes lands on her face.
 */
function layerRect(
  layer: Layer,
  width: number,
  height: number,
  framing: FramingResult,
  template: TemplateDocument
): Rect {
  const w = (layer.width / 100) * width
  const h = (layer.height / 100) * height

  if (layer.anchorTo) {
    const placement = framing.placements.find(p => p.anchor === layer.anchorTo)
    if (placement) {
      // Placement coordinates are in TEMPLATE canvas space; scale to the render
      // surface, which is supersampled.
      const scaleX = width / template.canvas.width
      const scaleY = height / template.canvas.height
      return {
        x: placement.canvas.x * scaleX + (layer.x / 100) * width,
        y: placement.canvas.y * scaleY + (layer.y / 100) * height,
        width: w,
        height: h,
      }
    }
  }

  return { x: (layer.x / 100) * width, y: (layer.y / 100) * height, width: w, height: h }
}

async function drawLayer(
  ctx: SKRSContext2D,
  layer: Layer,
  width: number,
  height: number,
  variables: Partial<TemplateVariableValues>,
  framing: FramingResult,
  template: TemplateDocument
): Promise<void> {
  const rect = layerRect(layer, width, height, framing, template)

  ctx.save()
  ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity))

  if (layer.rotation !== 0) {
    const cx = rect.x + rect.width / 2
    const cy = rect.y + rect.height / 2
    ctx.translate(cx, cy)
    ctx.rotate((layer.rotation * Math.PI) / 180)
    ctx.translate(-cx, -cy)
  }

  try {
    switch (layer.type) {
      case 'text':
        drawText(ctx, layer, rect, width, height, variables)
        break
      case 'badge':
        drawBadge(ctx, layer, rect, width, height, variables)
        break
      case 'rectangle':
        drawRectangle(ctx, layer, rect, width)
        break
      case 'ellipse':
        drawEllipse(ctx, layer, rect, width)
        break
      case 'image':
        await drawImageLayer(ctx, layer, rect, width)
        break
    }
  } catch (err) {
    // One broken layer — a missing asset, an unparseable colour — must not
    // abandon a whole bulk run. Skip it and keep the creative.
    console.warn(`[render] layer ${layer.id} (${layer.type}) failed:`, (err as Error).message)
  }

  ctx.restore()
}

function roundedRectPath(
  ctx: SKRSContext2D,
  rect: Rect,
  radius: number
): void {
  const r = Math.max(0, Math.min(radius, Math.min(rect.width, rect.height) / 2))
  ctx.beginPath()
  ctx.moveTo(rect.x + r, rect.y)
  ctx.lineTo(rect.x + rect.width - r, rect.y)
  ctx.quadraticCurveTo(rect.x + rect.width, rect.y, rect.x + rect.width, rect.y + r)
  ctx.lineTo(rect.x + rect.width, rect.y + rect.height - r)
  ctx.quadraticCurveTo(
    rect.x + rect.width,
    rect.y + rect.height,
    rect.x + rect.width - r,
    rect.y + rect.height
  )
  ctx.lineTo(rect.x + r, rect.y + rect.height)
  ctx.quadraticCurveTo(rect.x, rect.y + rect.height, rect.x, rect.y + rect.height - r)
  ctx.lineTo(rect.x, rect.y + r)
  ctx.quadraticCurveTo(rect.x, rect.y, rect.x + r, rect.y)
  ctx.closePath()
}

function drawRectangle(ctx: SKRSContext2D, layer: RectangleLayer, rect: Rect, width: number): void {
  const radius = (layer.borderRadiusPct / 100) * width
  roundedRectPath(ctx, rect, radius)
  ctx.fillStyle = layer.fill
  ctx.fill()
  if (layer.strokeColor && layer.strokeWidthPct > 0) {
    ctx.strokeStyle = layer.strokeColor
    ctx.lineWidth = (layer.strokeWidthPct / 100) * width
    ctx.stroke()
  }
}

function drawEllipse(ctx: SKRSContext2D, layer: EllipseLayer, rect: Rect, width: number): void {
  ctx.beginPath()
  ctx.ellipse(
    rect.x + rect.width / 2,
    rect.y + rect.height / 2,
    rect.width / 2,
    rect.height / 2,
    0,
    0,
    Math.PI * 2
  )
  ctx.fillStyle = layer.fill
  ctx.fill()
  if (layer.strokeColor && layer.strokeWidthPct > 0) {
    ctx.strokeStyle = layer.strokeColor
    ctx.lineWidth = (layer.strokeWidthPct / 100) * width
    ctx.stroke()
  }
}

async function drawImageLayer(
  ctx: SKRSContext2D,
  layer: ImageLayer,
  rect: Rect,
  width: number
): Promise<void> {
  if (!layer.assetKey) return

  const asset = await loadImage(resolvePath('assets', layer.assetKey))

  const radius = (layer.borderRadiusPct / 100) * width
  if (radius > 0) {
    roundedRectPath(ctx, rect, radius)
    ctx.clip()
  }

  const fitted = fitRect(asset.width, asset.height, rect, layer.fit)
  ctx.drawImage(asset as any, fitted.x, fitted.y, fitted.width, fitted.height)
}

function fitRect(
  naturalW: number,
  naturalH: number,
  rect: Rect,
  fit: 'contain' | 'cover' | 'fill'
): Rect {
  if (fit === 'fill' || naturalW === 0 || naturalH === 0) return rect

  const scale =
    fit === 'cover'
      ? Math.max(rect.width / naturalW, rect.height / naturalH)
      : Math.min(rect.width / naturalW, rect.height / naturalH)

  const w = naturalW * scale
  const h = naturalH * scale
  return {
    x: rect.x + (rect.width - w) / 2,
    y: rect.y + (rect.height - h) / 2,
    width: w,
    height: h,
  }
}

// ─── Text ────────────────────────────────────────────────────────────────────

function drawText(
  ctx: SKRSContext2D,
  layer: TextLayer,
  rect: Rect,
  width: number,
  height: number,
  variables: Partial<TemplateVariableValues>
): void {
  let content = resolveTemplateVariables(layer.content, variables)
  if (layer.uppercase) content = content.toUpperCase()
  if (!content) return

  const fontSize = (layer.fontSizePct / 100) * height
  const padding = (layer.paddingPct / 100) * width

  ctx.font = `${layer.fontWeight === 'bold' ? 'bold ' : ''}${fontSize}px ${fontStack(layer.fontFamily)}`
  ctx.textBaseline = 'top'
  ctx.fillStyle = layer.color

  const maxWidth = Math.max(1, rect.width - padding * 2)
  const lines = layer.wrap
    ? wrapText(ctx, content, maxWidth, layer.letterSpacing)
    : content.split('\n')

  const lineHeight = fontSize * layer.lineHeight
  const blockHeight = lines.length * lineHeight

  if (layer.backgroundColor) {
    ctx.save()
    ctx.fillStyle = layer.backgroundColor
    roundedRectPath(
      ctx,
      {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: Math.max(rect.height, blockHeight + padding * 2),
      },
      (layer.borderRadiusPct / 100) * width
    )
    ctx.fill()
    ctx.restore()
    ctx.fillStyle = layer.color
  }

  let y = rect.y + padding
  for (const line of lines) {
    const lineWidth = measureLine(ctx, line, layer.letterSpacing)
    const x =
      layer.align === 'center'
        ? rect.x + (rect.width - lineWidth) / 2
        : layer.align === 'right'
          ? rect.x + rect.width - padding - lineWidth
          : rect.x + padding

    drawLine(ctx, line, x, y, layer.letterSpacing)
    y += lineHeight
  }
}

/**
 * Word wrap.
 *
 * Craftify's compositor omits this: `fillText` with a `maxWidth` argument
 * horizontally COMPRESSES overflowing text rather than wrapping it, so long
 * product names render squashed. Measuring and breaking is a few lines and
 * produces the layout the editor previews.
 */
function wrapText(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
  letterSpacing: number
): string[] {
  const lines: string[] = []

  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      lines.push('')
      continue
    }

    let current = words[0]
    for (let i = 1; i < words.length; i++) {
      const candidate = `${current} ${words[i]}`
      if (measureLine(ctx, candidate, letterSpacing) <= maxWidth) {
        current = candidate
      } else {
        lines.push(current)
        current = words[i]
      }
    }
    lines.push(current)
  }

  return lines
}

/**
 * Measure with letter spacing applied.
 *
 * `measureText` does not know about tracking, so the spacing contribution is
 * added explicitly — otherwise wrapping is computed for one width and drawn at
 * another, and tracked headings overflow their box.
 */
function measureLine(ctx: SKRSContext2D, text: string, letterSpacing: number): number {
  const base = ctx.measureText(text).width
  if (letterSpacing === 0 || text.length < 2) return base
  return base + letterSpacing * (text.length - 1)
}

function drawLine(
  ctx: SKRSContext2D,
  text: string,
  x: number,
  y: number,
  letterSpacing: number
): void {
  if (letterSpacing === 0) {
    ctx.fillText(text, x, y)
    return
  }
  // Per-glyph so the tracking actually applies.
  let cursor = x
  for (const char of text) {
    ctx.fillText(char, cursor, y)
    cursor += ctx.measureText(char).width + letterSpacing
  }
}

function drawBadge(
  ctx: SKRSContext2D,
  layer: BadgeLayer,
  rect: Rect,
  width: number,
  height: number,
  variables: Partial<TemplateVariableValues>
): void {
  let content = resolveTemplateVariables(layer.content, variables)
  if (layer.uppercase) content = content.toUpperCase()

  ctx.fillStyle = layer.fill
  if (layer.shape === 'circle') {
    const radius = Math.min(rect.width, rect.height) / 2
    ctx.beginPath()
    ctx.arc(rect.x + rect.width / 2, rect.y + rect.height / 2, radius, 0, Math.PI * 2)
    ctx.fill()
  } else {
    const radius = layer.shape === 'pill' ? rect.height / 2 : (2 / 100) * width
    roundedRectPath(ctx, rect, radius)
    ctx.fill()
  }

  if (!content) return

  const fontSize = (layer.fontSizePct / 100) * height
  ctx.font = `${layer.fontWeight === 'bold' ? 'bold ' : ''}${fontSize}px ${fontStack(layer.fontFamily)}`
  ctx.fillStyle = layer.color
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(content, rect.x + rect.width / 2, rect.y + rect.height / 2)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
}

// ─── Output ──────────────────────────────────────────────────────────────────

function downscale(source: Canvas, width: number, height: number): Canvas {
  const target = createCanvas(width, height)
  const ctx = target.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source as any, 0, 0, width, height)
  return target
}

function fitWithin(
  width: number,
  height: number,
  maxDimension: number
): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxDimension) return { width, height }
  const scale = maxDimension / longest
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

export { sourceToCanvas }
