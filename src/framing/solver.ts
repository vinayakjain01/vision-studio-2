/**
 * The framing solver.
 *
 * Given a subject's anchors and a framing spec, produce the crop rectangle.
 * Pure, synchronous, allocation-light — it runs on every slider drag in the
 * browser and on every image in a bulk render, from the same code.
 *
 * ── The derivation ───────────────────────────────────────────────────────────
 * Let the canvas be W×H. A crop of `ch` source pixels tall maps onto H canvas
 * pixels, so the magnification is  u = H / ch.
 *
 * SCALE. A landmark span of `d` source pixels should occupy `s` (a fraction) of
 * the canvas height:
 *       d · u = s · H      →      d · H / ch = s · H      →      ch = d / s
 * The canvas height cancels: the crop height depends only on the measured span
 * and the requested fraction. That is why the same spec produces matching
 * framing on a 1:1 tile and a 9:16 story.
 *
 *       cw = ch · (W / H)
 *
 * VERTICAL. Anchor A at source y_A should land at fraction t of canvas height,
 * i.e. at source offset t · ch inside the crop:
 *       cy = y_A − t · ch
 *
 * HORIZONTAL, identically:
 *       cx = x_B − t_h · cw
 *
 * Three equations, one rectangle, no iteration. Constraints are then applied as
 * explicit adjustments, each of which records what it changed — so a crop is
 * never silently different from what the template asked for.
 *
 * ── Determinism ──────────────────────────────────────────────────────────────
 * No randomness, no clock, no floating-point accumulation over unordered
 * collections. The same subject and spec always give the same crop, on any
 * machine, in the browser or on the server.
 */

import type { AnchorName, Anchors, ShotType } from '@/vision/types'
import {
  DEFAULT_CONSTRAINTS,
  type AnchorPlacement,
  type ConstraintViolation,
  type CropBox,
  type FramingResult,
  type FramingSpec,
  type FramingStrategy,
  type FramingSubject,
  type ScaleStrategy,
} from './types'
import type { Size } from '@/vision/types'

/** Smallest crop we will ever produce, in source pixels. Guards divide-by-zero. */
const MIN_CROP_DIMENSION = 8

export function solveFraming(
  subject: FramingSubject,
  spec: FramingSpec,
  canvas: Size
): FramingResult {
  const constraints = { ...DEFAULT_CONSTRAINTS, ...spec.constraints }
  const violations: ConstraintViolation[] = []

  const { strategy, index } = selectStrategy(subject, spec, violations)
  const usedFallback = index > 0

  if (usedFallback) {
    violations.push({
      code: 'fallback_used',
      severity: 'info',
      message: `Primary framing was not applicable to this image; used "${strategy.label}" instead.`,
    })
  }

  // ── 1. Crop height from the scale strategy ───────────────────────────────
  let cropHeight = resolveCropHeight(subject, strategy.scale, canvas, violations)
  cropHeight = Math.max(MIN_CROP_DIMENSION, cropHeight)

  // ── 2. Clamp magnification ───────────────────────────────────────────────
  // u = canvas.height / cropHeight, so bounding u bounds cropHeight inversely.
  const minCropHeight = canvas.height / constraints.maxUpscale
  const maxCropHeight = canvas.height / Math.max(1e-6, constraints.minUpscale)

  if (cropHeight < minCropHeight) {
    violations.push({
      code: 'max_upscale_clamped',
      severity: 'warning',
      message: `Requested framing needs ${(canvas.height / cropHeight).toFixed(2)}× magnification; capped at ${constraints.maxUpscale}×. The subject will appear smaller than specified.`,
      magnitude: canvas.height / cropHeight / constraints.maxUpscale,
    })
    cropHeight = minCropHeight
  } else if (cropHeight > maxCropHeight) {
    violations.push({
      code: 'min_upscale_clamped',
      severity: 'info',
      message: `Requested framing zooms out past the ${constraints.minUpscale}× floor; clamped.`,
    })
    cropHeight = maxCropHeight
  }

  let cropWidth = cropHeight * (canvas.width / canvas.height)

  // ── 3. Position ──────────────────────────────────────────────────────────
  let cropX = resolveCropX(subject, strategy, cropWidth)
  let cropY = resolveCropY(subject, strategy, cropHeight)

  // ── 4. Keep required anchors inside the canvas ───────────────────────────
  // Applied before the source-bounds policy: it can only shrink or shift the
  // crop, and doing it first means the bounds policy sees the final size.
  const kept = enforceKeepInside(
    subject,
    constraints,
    { x: cropX, y: cropY, width: cropWidth, height: cropHeight },
    canvas,
    violations
  )
  cropX = kept.x
  cropY = kept.y
  cropWidth = kept.width
  cropHeight = kept.height

  // ── 5. Source-bounds policy ──────────────────────────────────────────────
  const bounded = applyOverflowPolicy(
    { x: cropX, y: cropY, width: cropWidth, height: cropHeight },
    subject.image,
    canvas,
    constraints.overflow,
    violations,
    // `shrink` changes the crop size, which invalidates the position derived in
    // step 3 (cy depends on cropHeight). Hand the policy a way to re-derive
    // position at the new size so the anchor target survives the resize —
    // that is the whole distinction between `shrink` and `clamp`.
    (width, height) => ({
      x: resolveCropX(subject, strategy, width),
      y: resolveCropY(subject, strategy, height),
    })
  )

  const crop = bounded.crop
  const upscale = canvas.height / Math.max(MIN_CROP_DIMENSION, crop.height)

  return {
    crop,
    upscale,
    strategyId: strategy.id,
    strategyLabel: strategy.label,
    usedFallback,
    placements: describePlacements(subject, strategy, crop, canvas),
    violations,
    overflow: bounded.overflow,
    canvas,
  }
}

// ─── Strategy selection ──────────────────────────────────────────────────────

function selectStrategy(
  subject: FramingSubject,
  spec: FramingSpec,
  violations: ConstraintViolation[]
): { strategy: FramingStrategy; index: number } {
  const strategies = spec.strategies

  if (strategies.length === 0) {
    // A spec with no strategies is a programming error, not a data condition.
    // Produce something rather than throwing inside a render loop.
    return {
      strategy: {
        id: 'implicit_fit',
        label: 'Fit subject',
        requires: [],
        minConfidence: 0,
        shotTypes: [],
        vertical: null,
        horizontal: { anchor: 'subject_center', targetPct: 50 },
        scale: { mode: 'subject', heightPct: 90 },
      },
      index: 0,
    }
  }

  for (let i = 0; i < strategies.length; i++) {
    const strategy = strategies[i]

    if (strategy.shotTypes.length > 0 && !strategy.shotTypes.includes(subject.shotType)) {
      continue
    }

    const missing = strategy.requires.filter(
      name => !hasAnchor(subject.anchors, name, strategy.minConfidence)
    )
    // Anchors named in vertical/horizontal/scale are needed even when the
    // author forgot to list them in `requires`.
    const implicit = implicitAnchors(strategy).filter(
      name => !hasAnchor(subject.anchors, name, strategy.minConfidence)
    )
    const allMissing = Array.from(new Set([...missing, ...implicit]))

    if (allMissing.length === 0) {
      return { strategy, index: i }
    }

    if (i === 0) {
      violations.push({
        code: 'anchor_missing',
        severity: 'info',
        message: `"${strategy.label}" needs ${allMissing.join(', ')}, which ${allMissing.length === 1 ? 'was' : 'were'} not detected confidently in this image.`,
      })
    }
  }

  // Nothing was eligible. Use the last strategy regardless — it is the chain's
  // designated backstop, and a spec that reaches here still has to render.
  return { strategy: strategies[strategies.length - 1], index: strategies.length - 1 }
}

function implicitAnchors(strategy: FramingStrategy): AnchorName[] {
  const names: AnchorName[] = []
  if (strategy.vertical) names.push(strategy.vertical.anchor)
  if (strategy.horizontal) names.push(strategy.horizontal.anchor)
  if (strategy.scale.mode === 'span') {
    names.push(strategy.scale.from, strategy.scale.to)
  }
  return names
}

function hasAnchor(anchors: Anchors, name: AnchorName, minConfidence: number): boolean {
  const anchor = anchors[name]
  return !!anchor && anchor.confidence >= minConfidence
}

/**
 * Which shot types a spec's strategy chain was actually written for.
 *
 * A strategy that leaves `shotTypes` empty is not claiming universality for the
 * whole template — it usually means "whatever anchors are missing from the
 * strategy above, catch here", e.g. the anchor-free last resort every chain
 * ends with (see `selectStrategy`). Only strategies that DID declare shot types
 * express the template author's actual intent, so the union of those — not of
 * every strategy — is what a photo's shot type is checked against. A spec
 * where no strategy declares any shot type (e.g. "garment focus", which frames
 * the clothing regardless of what body is in frame) is universally applicable
 * by design, and returns an empty set.
 */
export function shotTypeUniverse(spec: FramingSpec): ShotType[] {
  const restricted = spec.strategies.filter(s => s.shotTypes.length > 0)
  if (restricted.length === 0) return []
  return Array.from(new Set(restricted.flatMap(s => s.shotTypes)))
}

/**
 * Whether this template's stricter, shot-type-specific strategies cover this
 * kind of photo — not whether it will render at all. It always will:
 * `selectStrategy` falls through to the chain's anchor-free last resort (a
 * plain centred fit) for anything it doesn't recognise, so every photo gets a
 * creative. This is purely informational — the builder preview and the batch
 * plan use it to tell the operator "this one will get the generic fit, not
 * landmark framing" up front, rather than leaving them to notice only after
 * generating.
 */
export function isShotTypeApplicable(shotType: ShotType, spec: FramingSpec): boolean {
  const universe = shotTypeUniverse(spec)
  return universe.length === 0 || universe.includes(shotType)
}

// ─── Geometry ────────────────────────────────────────────────────────────────

function resolveCropHeight(
  subject: FramingSubject,
  scale: ScaleStrategy,
  canvas: Size,
  violations: ConstraintViolation[]
): number {
  switch (scale.mode) {
    case 'span': {
      const from = subject.anchors[scale.from]
      const to = subject.anchors[scale.to]
      if (from && to) {
        // Vertical distance only. Using Euclidean distance would make the crop
        // zoom out when the subject leans, which reads as the framing
        // "breathing" across a catalog of similar poses.
        const span = Math.abs(to.y - from.y)
        const fraction = clamp(scale.spanPct / 100, 0.01, 1)
        if (span > 0) return span / fraction
      }
      violations.push({
        code: 'anchor_missing',
        severity: 'warning',
        message: `Scale span ${scale.from}→${scale.to} could not be measured; fell back to subject height.`,
      })
      return subjectHeightFallback(subject, 85)
    }

    case 'subject':
      return subjectHeightFallback(subject, scale.heightPct)

    case 'fixed':
      return canvas.height * Math.max(0.01, scale.sourcePerCanvasPixel)
  }
}

function subjectHeightFallback(subject: FramingSubject, heightPct: number): number {
  const fraction = clamp(heightPct / 100, 0.01, 1)
  const box = subject.subjectBox
  const height = box ? box.bottom - box.top : subject.image.height
  return Math.max(MIN_CROP_DIMENSION, height) / fraction
}

function resolveCropY(
  subject: FramingSubject,
  strategy: FramingStrategy,
  cropHeight: number
): number {
  const placement = strategy.vertical
  if (placement) {
    const anchor = subject.anchors[placement.anchor]
    if (anchor) {
      return anchor.y - (clamp(placement.targetPct / 100, 0, 1) * cropHeight)
    }
  }
  // No vertical constraint: centre on the subject, else on the image.
  const centre =
    subject.anchors.subject_center?.y ??
    (subject.subjectBox
      ? (subject.subjectBox.top + subject.subjectBox.bottom) / 2
      : subject.image.height / 2)
  return centre - cropHeight / 2
}

function resolveCropX(
  subject: FramingSubject,
  strategy: FramingStrategy,
  cropWidth: number
): number {
  const placement = strategy.horizontal
  if (placement) {
    const anchor = subject.anchors[placement.anchor]
    if (anchor) {
      return anchor.x - (clamp(placement.targetPct / 100, 0, 1) * cropWidth)
    }
  }
  const centre =
    subject.anchors.subject_center?.x ??
    (subject.subjectBox
      ? (subject.subjectBox.left + subject.subjectBox.right) / 2
      : subject.image.width / 2)
  return centre - cropWidth / 2
}

// ─── Constraints ─────────────────────────────────────────────────────────────

/**
 * Make sure every `keepInside` anchor stays within the canvas.
 *
 * Shifting is tried first because it preserves scale, which is what keeps a
 * catalog consistent. Only when an anchor cannot be brought inside by shifting
 * — the required span simply does not fit — does the crop grow, and that is
 * recorded as a violation so the operator can see which images compromised.
 */
function enforceKeepInside(
  subject: FramingSubject,
  constraints: typeof DEFAULT_CONSTRAINTS,
  crop: CropBox,
  canvas: Size,
  violations: ConstraintViolation[]
): CropBox {
  if (constraints.keepInside.length === 0) return crop

  const padY = (constraints.keepInsidePaddingPct / 100) * crop.height
  const padX = (constraints.keepInsidePaddingPct / 100) * crop.width

  const points = constraints.keepInside
    .map(name => ({ name, anchor: subject.anchors[name] }))
    .filter((entry): entry is { name: AnchorName; anchor: NonNullable<Anchors[AnchorName]> } =>
      entry.anchor != null
    )

  if (points.length === 0) return crop

  let { x, y, width, height } = crop

  // Two passes: shifting to satisfy the top may violate the bottom, and one
  // re-check is enough to detect that the span genuinely does not fit.
  for (let pass = 0; pass < 2; pass++) {
    let minY = Infinity
    let maxY = -Infinity
    let minX = Infinity
    let maxX = -Infinity

    for (const { anchor } of points) {
      if (anchor.y < minY) minY = anchor.y
      if (anchor.y > maxY) maxY = anchor.y
      if (anchor.x < minX) minX = anchor.x
      if (anchor.x > maxX) maxX = anchor.x
    }

    const requiredHeight = maxY - minY + padY * 2
    const requiredWidth = maxX - minX + padX * 2

    if (requiredHeight > height || requiredWidth > width) {
      const scaleUp = Math.max(requiredHeight / height, requiredWidth / width)
      // Re-centre on the anchor group as we grow, so the growth is symmetric.
      const centreX = (minX + maxX) / 2
      const centreY = (minY + maxY) / 2
      width *= scaleUp
      height *= scaleUp
      x = centreX - width / 2
      y = centreY - height / 2

      violations.push({
        code: 'keep_inside_violated',
        severity: 'warning',
        message: `Zoomed out ${((scaleUp - 1) * 100).toFixed(0)}% so ${constraints.keepInside.join(', ')} stay in frame.`,
        magnitude: scaleUp,
      })
      continue
    }

    // Shift only.
    let shiftY = 0
    if (minY - padY < y) shiftY = minY - padY - y
    else if (maxY + padY > y + height) shiftY = maxY + padY - (y + height)

    let shiftX = 0
    if (minX - padX < x) shiftX = minX - padX - x
    else if (maxX + padX > x + width) shiftX = maxX + padX - (x + width)

    if (shiftX === 0 && shiftY === 0) break

    x += shiftX
    y += shiftY
  }

  return { x, y, width, height }
}

function applyOverflowPolicy(
  crop: CropBox,
  source: Size,
  canvas: Size,
  policy: 'clamp' | 'shrink' | 'allow',
  violations: ConstraintViolation[],
  reposition: (width: number, height: number) => { x: number; y: number }
): { crop: CropBox; overflow: FramingResult['overflow'] } {
  const measure = (c: CropBox) => ({
    left: Math.max(0, -c.x),
    top: Math.max(0, -c.y),
    right: Math.max(0, c.x + c.width - source.width),
    bottom: Math.max(0, c.y + c.height - source.height),
  })

  const overflow = measure(crop)
  const overflows =
    overflow.left > 0.5 || overflow.top > 0.5 || overflow.right > 0.5 || overflow.bottom > 0.5

  if (!overflows) return { crop, overflow }

  if (policy === 'allow') {
    violations.push({
      code: 'crop_overflows_source',
      severity: 'info',
      message: 'The crop extends beyond the source image; exposed areas are filled by the template background.',
    })
    return { crop, overflow }
  }

  if (policy === 'shrink') {
    // Shrink until the crop fits inside the source, re-deriving the position
    // from the anchors at each new size. Two rounds converge: the first sizes
    // the crop to the source, the second absorbs any residual overhang the
    // repositioning reintroduced (an anchor near an edge can push the smaller
    // crop back out on the opposite side).
    let width = crop.width
    let height = crop.height
    let x = crop.x
    let y = crop.y
    let totalScale = 1

    for (let pass = 0; pass < 2; pass++) {
      const fitScale = Math.min(1, source.width / width, source.height / height)
      if (fitScale >= 0.999 && pass > 0) break

      width *= fitScale
      height *= fitScale
      totalScale *= fitScale

      // Re-solve position at the new size — this is what keeps the anchor on
      // its target through the resize.
      const repositioned = reposition(width, height)
      x = repositioned.x
      y = repositioned.y

      const over = measure({ x, y, width, height })
      if (over.left <= 0.5 && over.top <= 0.5 && over.right <= 0.5 && over.bottom <= 0.5) {
        break
      }
    }

    // The crop now fits dimensionally; slide it inside if the anchor placed it
    // partly off an edge. This is the only step that can move an anchor off
    // target, and only when the anchor itself sits too near the image border
    // for the requested framing to be satisfiable.
    const clampedX = clamp(x, 0, Math.max(0, source.width - width))
    const clampedY = clamp(y, 0, Math.max(0, source.height - height))

    if (totalScale < 0.999) {
      violations.push({
        code: 'crop_shrunk_to_fit',
        severity: 'warning',
        message: `Crop shrunk to ${(totalScale * 100).toFixed(0)}% to stay inside the source image; the subject appears smaller than specified.`,
        magnitude: totalScale,
      })
    }

    const shiftY = Math.abs(clampedY - y)
    const shiftX = Math.abs(clampedX - x)
    if (shiftX > 0.5 || shiftY > 0.5) {
      violations.push({
        code: 'crop_clamped_to_source',
        severity: 'warning',
        message: `Crop moved ${Math.round((shiftX / width) * canvas.width)}×${Math.round((shiftY / height) * canvas.height)}px (canvas space) after shrinking; the anchor sits too close to the image edge to hit its target exactly.`,
      })
    }

    const shrunk = { x: clampedX, y: clampedY, width, height }
    return { crop: shrunk, overflow: measure(shrunk) }
  }

  // 'clamp' — keep the size, slide it inside.
  //
  // When the crop is LARGER than the source on an axis it cannot be contained at
  // all, and there is nothing to slide. The anchor target is honoured on that
  // axis and the shortfall is reported as overflow for the renderer to fill from
  // the background.
  //
  // An earlier version centred on the over-sized axis instead. That silently
  // discarded the template's intent: on a 2:3 canvas fed a landscape photo the
  // vertical target was overridden on every image, so "head at 8%" and "head at
  // 45%" produced the identical crop and the control appeared broken. Honouring
  // the anchor keeps the request visible — asymmetric padding is a legible
  // signal that the framing asks for more height than the photo can supply,
  // where a centred crop looked deliberate.
  const widthFits = crop.width < source.width
  const heightFits = crop.height < source.height

  const x = widthFits ? clamp(crop.x, 0, source.width - crop.width) : crop.x
  const y = heightFits ? clamp(crop.y, 0, source.height - crop.height) : crop.y

  if (!widthFits || !heightFits) {
    const axes = [!widthFits && 'wider', !heightFits && 'taller'].filter(Boolean).join(' and ')
    violations.push({
      code: 'crop_overflows_source',
      severity: 'warning',
      message: `The requested framing is ${axes} than the source photo, so the background fills the remainder. Reduce the span percentage or use a canvas closer to the photo's aspect ratio to avoid this.`,
    })
  }

  const shiftedX = Math.abs(x - crop.x)
  const shiftedY = Math.abs(y - crop.y)
  if (shiftedX > 0.5 || shiftedY > 0.5) {
    // Report the shift in CANVAS pixels — that is the unit the operator sees.
    const canvasShiftY = (shiftedY / crop.height) * canvas.height
    const canvasShiftX = (shiftedX / crop.width) * canvas.width
    violations.push({
      code: 'crop_clamped_to_source',
      severity: 'warning',
      message: `Crop moved ${Math.round(canvasShiftX)}×${Math.round(canvasShiftY)}px (canvas space) to stay inside the source image; anchors are off their targets by that amount.`,
      magnitude: Math.max(canvasShiftX, canvasShiftY),
    })
  }

  const clamped = { x, y, width: crop.width, height: crop.height }
  return { crop: clamped, overflow: measure(clamped) }
}

// ─── Reporting ───────────────────────────────────────────────────────────────

/**
 * Where every anchor the strategy referenced actually ended up, with the
 * requested target beside it. This is what makes framing debuggable: the panel
 * draws both and the discrepancy is visible rather than inferred.
 */
function describePlacements(
  subject: FramingSubject,
  strategy: FramingStrategy,
  crop: CropBox,
  canvas: Size
): AnchorPlacement[] {
  const referenced = new Set<AnchorName>(implicitAnchors(strategy))
  for (const name of strategy.requires) referenced.add(name)

  const scaleX = canvas.width / Math.max(MIN_CROP_DIMENSION, crop.width)
  const scaleY = canvas.height / Math.max(MIN_CROP_DIMENSION, crop.height)

  const placements: AnchorPlacement[] = []

  for (const name of referenced) {
    const anchor = subject.anchors[name]
    if (!anchor) continue

    const canvasPoint = {
      x: (anchor.x - crop.x) * scaleX,
      y: (anchor.y - crop.y) * scaleY,
    }

    let target: { x: number; y: number } | null = null
    if (strategy.vertical?.anchor === name || strategy.horizontal?.anchor === name) {
      target = {
        x:
          strategy.horizontal?.anchor === name
            ? (strategy.horizontal.targetPct / 100) * canvas.width
            : canvasPoint.x,
        y:
          strategy.vertical?.anchor === name
            ? (strategy.vertical.targetPct / 100) * canvas.height
            : canvasPoint.y,
      }
    }

    placements.push({
      anchor: name,
      source: { x: anchor.x, y: anchor.y },
      canvas: canvasPoint,
      target,
      error: target ? { x: target.x - canvasPoint.x, y: target.y - canvasPoint.y } : null,
      confidence: anchor.confidence,
    })
  }

  // Stable output order — the debug panel renders this as a list.
  placements.sort((a, b) => a.anchor.localeCompare(b.anchor))
  return placements
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/**
 * The range of vertical target percentages that actually move the crop on a
 * given photo.
 *
 * A crop smaller than the source can only slide between the source's edges. Once
 * it is flush against the top or the bottom, raising or lowering the anchor
 * target changes nothing — the window cannot travel past the edge of the
 * photograph. On a landscape source with a portrait canvas that dead zone can be
 * most of the slider, which makes a perfectly correct control look broken.
 *
 * Derivation. With crop height `ch`, source height `H` and the anchor at
 * `anchorY`, the solver places the crop at `cy = anchorY − t·ch`, and `clamp`
 * requires `0 ≤ cy ≤ H − ch`. Rearranging for `t`:
 *
 *     (anchorY − (H − ch)) / ch   ≤   t   ≤   anchorY / ch
 *
 * Returns null when the value is unconstrained — the crop is taller than the
 * source (it overflows, so any target is honourable) or the policy is not
 * `clamp`.
 */
export function achievableVerticalRange(
  subject: FramingSubject,
  spec: FramingSpec,
  canvas: Size
): { minPct: number; maxPct: number } | null {
  const constraints = { ...DEFAULT_CONSTRAINTS, ...spec.constraints }
  if (constraints.overflow !== 'clamp') return null

  const violations: ConstraintViolation[] = []
  const { strategy } = selectStrategy(subject, spec, violations)
  if (!strategy.vertical) return null

  const anchor = subject.anchors[strategy.vertical.anchor]
  if (!anchor) return null

  // Solve once to obtain the crop height the current settings produce; it does
  // not depend on the vertical target.
  const solved = solveFraming(subject, spec, canvas)
  const ch = solved.crop.height
  const H = subject.image.height

  // Taller than the source: it overflows on this axis, so every target is met.
  if (ch >= H || ch <= 0) return null

  const minPct = ((anchor.y - (H - ch)) / ch) * 100
  const maxPct = (anchor.y / ch) * 100

  return {
    minPct: Math.max(0, Math.min(100, minPct)),
    maxPct: Math.max(0, Math.min(100, maxPct)),
  }
}

/**
 * Map a source-space point into canvas space under a solved crop. Used by the
 * debug overlay and by layer positioning that needs to follow a landmark.
 */
export function sourceToCanvas(
  point: { x: number; y: number },
  crop: CropBox,
  canvas: Size
): { x: number; y: number } {
  return {
    x: ((point.x - crop.x) / crop.width) * canvas.width,
    y: ((point.y - crop.y) / crop.height) * canvas.height,
  }
}

/** Inverse of `sourceToCanvas`. */
export function canvasToSource(
  point: { x: number; y: number },
  crop: CropBox,
  canvas: Size
): { x: number; y: number } {
  return {
    x: crop.x + (point.x / canvas.width) * crop.width,
    y: crop.y + (point.y / canvas.height) * crop.height,
  }
}
