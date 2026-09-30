/**
 * What touches each padding-region edge of an AI-Extend fill, classified from
 * the garment and person masks the vision engine already produced.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * AI Extend used to treat every padding edge identically — "empty studio
 * background to extend" — regardless of what the crop actually cut through on
 * that side. On a half-body or three-quarter shot the crop routinely ends
 * mid-garment (wide-leg pants at the knee, a long tunic at the thigh), not at
 * the edge of the subject. Handed no evidence otherwise, the fill request
 * asked Cloudinary to invent "backdrop" there, and Cloudinary — reasonably,
 * given a prompt that never mentioned a garment — generated bare legs where
 * embroidered fabric should have continued. The fabric-to-skin transition was
 * abrupt and looked exactly like what it was: two unrelated things stitched
 * together.
 *
 * The fix is not a smarter model. It is telling the existing one what is
 * actually there, per edge, before it generates anything.
 *
 * ── Reusing what already exists ──────────────────────────────────────────────
 * No new detector. Every photo already carries `garment_mask.png` and
 * `person_mask.png` in the derived-asset store (see `analysis/garment.ts` and
 * `VisionEngine.persistMasks`) — a garment-class mask and a whole-person
 * (skin + hair + clothing) matte, both produced during vision analysis. Skin
 * has no mask of its own, so it is derived here as the geometric difference:
 * person-positive AND NOT garment-positive. That is an approximation (it also
 * catches hair and, at the neckline, a sliver of exposed neck), but it needs
 * to answer one question only — "is skin visible here, as opposed to
 * garment or nothing" — and for that it is accurate enough to act on.
 *
 * Pure function: given the two mask grids and the padding geometry, returns a
 * classification and nothing else. No I/O, no Cloudinary, no compositor
 * state — `buildAiExtendTarget` in `compositor.ts` is what reads the PNGs off
 * disk and hands them in.
 */

export type BoundaryContent = 'garment' | 'skin' | 'background'

export interface EdgeContent {
  top: BoundaryContent | null
  left: BoundaryContent | null
  right: BoundaryContent | null
  bottom: BoundaryContent | null
}

/** A decoded mask: single channel, 0–255, one probability byte per cell. */
export interface MaskGrid {
  data: Uint8Array
  width: number
  height: number
}

export interface ClassifyEdgesInput {
  /** Real photo dimensions, source pixels — what the masks scale against. */
  imageWidth: number
  imageHeight: number
  /**
   * The rectangle of the photo this crop actually uses, in SOURCE pixel
   * coordinates (`placedRect`'s `sourceX/Y/Width/Height` in compositor.ts).
   * Classification looks only inside this rectangle: a garment elsewhere in
   * the photo but outside the crop has nothing to do with what the fill
   * needs to continue.
   */
  usedSourceX: number
  usedSourceY: number
  usedSourceWidth: number
  usedSourceHeight: number
  /**
   * Which edges have padding to fill at all, in the same units
   * `hasOverflow()` reads — an edge below its threshold is left `null`
   * (nothing to classify, nothing to fill).
   */
  overflow: { left: number; top: number; right: number; bottom: number }
  /** `null` when the mask was never produced or persistence failed. */
  garmentMask: MaskGrid | null
  personMask: MaskGrid | null
}

/**
 * A padding edge counts as bordering GARMENT once the strip of photo
 * immediately inside that edge is meaningfully covered by garment pixels —
 * NOT a majority of the strip's full width, which turns out to be the wrong
 * bar to clear.
 *
 * Measured directly against a real photo in this catalog: a floor-length
 * gown, `hemCropped: true`, hem genuinely at the source image's bottom
 * edge — visually exactly the reference case. Its bottom-edge band scored
 * 46.4% garment and 0.4% skin. Not a synthetic edge case: the gap between
 * the two is the ordinary side margin of studio floor visible beside any
 * garment that does not fill the crop's full width, which is most of them.
 * A 50%-of-the-whole-strip bar — demanding the garment dominate the padding
 * that gets generated for the FLOOR beside it too — was failing on the
 * single real photo that most resembles the bug this exists to fix.
 *
 * 0.3 clears that measurement with headroom while staying far above stray
 * mask noise (a handful of misclassified pixels scores nowhere near this).
 * The real safety margin against a false positive is `SKIN_PRESENT` below,
 * not this number — garment coverage on its own only ever competes against
 * "how much of this edge is empty floor", which is a low-stakes mistake
 * (floor generated where fabric should continue, not skin), while the skin
 * veto is what stands between this and the actual failure mode.
 */
const GARMENT_DOMINANT = 0.3

/**
 * ANY meaningful skin presence in that same strip vetoes a garment call,
 * even when garment is still nominally the majority. This is deliberately
 * the more sensitive of the two thresholds: mistaking a genuine hem-and-skin
 * transition for "more garment" reproduces the original bug (skin generated
 * as fabric, or a hard edge where a soft one belongs), while the reverse
 * mistake just falls back to the body-continuation path this task confirms
 * already works correctly. When in doubt, prefer the path already known to
 * be safe.
 */
const SKIN_PRESENT = 0.12

/** A separate, lower bar for calling an edge "skin" outright (no garment). */
const SKIN_DOMINANT = 0.12

/** Binarization threshold, matching `config.vision.maskBinaryThreshold`'s default. */
const MASK_THRESHOLD = 0.5 * 255

/** Edges with less than this many render-surface px of overflow are skipped. */
const OVERFLOW_EPSILON = 0.5

/**
 * The strip of the photo sampled next to an edge, as a fraction of the
 * crop's cross dimension — thin enough to be "at the edge", not a large
 * fraction of the photo that would dilute a real transition with content
 * further inside the frame.
 */
const BAND_FRACTION = 0.06
const BAND_MIN_PX = 24
const BAND_MAX_PX = 260

function bandThickness(crossDimension: number): number {
  return Math.max(BAND_MIN_PX, Math.min(BAND_MAX_PX, Math.round(crossDimension * BAND_FRACTION)))
}

function sampleGrid(grid: MaskGrid, x: number, y: number, scaleX: number, scaleY: number): boolean {
  const gx = Math.min(grid.width - 1, Math.max(0, Math.round(x / scaleX)))
  const gy = Math.min(grid.height - 1, Math.max(0, Math.round(y / scaleY)))
  return grid.data[gy * grid.width + gx] >= MASK_THRESHOLD
}

interface BandRect {
  x: number
  y: number
  width: number
  height: number
}

function classifyBand(
  band: BandRect,
  garmentMask: MaskGrid | null,
  personMask: MaskGrid | null,
  imageWidth: number,
  imageHeight: number
): BoundaryContent {
  if (!garmentMask && !personMask) return 'background'
  if (band.width <= 0 || band.height <= 0) return 'background'

  const gScaleX = garmentMask ? imageWidth / garmentMask.width : 1
  const gScaleY = garmentMask ? imageHeight / garmentMask.height : 1
  const pScaleX = personMask ? imageWidth / personMask.width : 1
  const pScaleY = personMask ? imageHeight / personMask.height : 1

  // Sampled as a grid across the band rather than every pixel — the masks are
  // already coarse (128x128 / 352x512), so anything finer than the mask's own
  // resolution measures noise, not signal.
  const cols = Math.max(6, Math.min(48, Math.round(band.width)))
  const rows = Math.max(6, Math.min(48, Math.round(band.height)))

  let total = 0
  let garmentHits = 0
  let skinHits = 0

  for (let i = 0; i < cols; i++) {
    const x = band.x + ((i + 0.5) / cols) * band.width
    for (let j = 0; j < rows; j++) {
      const y = band.y + ((j + 0.5) / rows) * band.height
      total++
      const isGarment = garmentMask ? sampleGrid(garmentMask, x, y, gScaleX, gScaleY) : false
      if (isGarment) {
        garmentHits++
        continue
      }
      // Skin is not its own mask — it is "person, but not garment": the
      // matte minus the clothing region. Also catches hair and a neckline
      // sliver of neck, which is an acceptable false-positive here since
      // both correctly argue AGAINST treating this edge as plain backdrop.
      const isPerson = personMask ? sampleGrid(personMask, x, y, pScaleX, pScaleY) : false
      if (isPerson) skinHits++
    }
  }

  if (total === 0) return 'background'
  const garmentFrac = garmentHits / total
  const skinFrac = skinHits / total

  if (garmentFrac >= GARMENT_DOMINANT && skinFrac < SKIN_PRESENT) return 'garment'
  if (skinFrac >= SKIN_DOMINANT) return 'skin'
  return 'background'
}

/**
 * Classify all four padding edges in one pass.
 *
 * Independent per edge, deliberately — a photo can have a garment cut at the
 * bottom while the sides border pure studio background, and the reference
 * bug is specifically the top/bottom vs. left/right distinction on a
 * half-body shot: the bottom edge cuts fabric, the sides usually do not.
 */
export function classifyPaddingEdges(input: ClassifyEdgesInput): EdgeContent {
  const { imageWidth, imageHeight, usedSourceX, usedSourceY, usedSourceWidth, usedSourceHeight, overflow } =
    input

  const result: EdgeContent = { top: null, left: null, right: null, bottom: null }
  if (usedSourceWidth <= 0 || usedSourceHeight <= 0) return result

  if (overflow.top > OVERFLOW_EPSILON) {
    const thickness = Math.min(usedSourceHeight, bandThickness(usedSourceHeight))
    result.top = classifyBand(
      { x: usedSourceX, y: usedSourceY, width: usedSourceWidth, height: thickness },
      input.garmentMask,
      input.personMask,
      imageWidth,
      imageHeight
    )
  }

  if (overflow.bottom > OVERFLOW_EPSILON) {
    const thickness = Math.min(usedSourceHeight, bandThickness(usedSourceHeight))
    result.bottom = classifyBand(
      { x: usedSourceX, y: usedSourceY + usedSourceHeight - thickness, width: usedSourceWidth, height: thickness },
      input.garmentMask,
      input.personMask,
      imageWidth,
      imageHeight
    )
  }

  if (overflow.left > OVERFLOW_EPSILON) {
    const thickness = Math.min(usedSourceWidth, bandThickness(usedSourceWidth))
    result.left = classifyBand(
      { x: usedSourceX, y: usedSourceY, width: thickness, height: usedSourceHeight },
      input.garmentMask,
      input.personMask,
      imageWidth,
      imageHeight
    )
  }

  if (overflow.right > OVERFLOW_EPSILON) {
    const thickness = Math.min(usedSourceWidth, bandThickness(usedSourceWidth))
    result.right = classifyBand(
      { x: usedSourceX + usedSourceWidth - thickness, y: usedSourceY, width: thickness, height: usedSourceHeight },
      input.garmentMask,
      input.personMask,
      imageWidth,
      imageHeight
    )
  }

  return result
}

/** True when any edge needs the garment-continuation prompt. */
export function hasGarmentEdge(edges: EdgeContent): boolean {
  return edges.top === 'garment' || edges.left === 'garment' || edges.right === 'garment' || edges.bottom === 'garment'
}
