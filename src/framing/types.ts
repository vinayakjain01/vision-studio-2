/**
 * ════════════════════════════════════════════════════════════════════════════
 * Framing — the contract between a template and an image
 * ════════════════════════════════════════════════════════════════════════════
 *
 * A framing spec answers three questions, each in terms of anchors rather than
 * pixels or percentages of the source:
 *
 *   1. WHERE does a landmark sit on the canvas?   "head_top at 12% from the top"
 *   2. HOW BIG is the subject?                    "head_top→feet spans 80% of height"
 *   3. WHERE horizontally?                        "shoulder_center at 50%"
 *
 * From those three, exactly one crop rectangle follows. That is the substance
 * of "landmark-based framing instead of resize": the template does not describe
 * a transform, it describes a *result*, and the solver derives whatever
 * transform each individual photo needs to produce it. Two photos shot at
 * different distances, with the model at different heights in frame, yield
 * different crops and identical output framing.
 *
 * ── This module is isomorphic ────────────────────────────────────────────────
 * Pure TypeScript, no Node built-ins, no DOM. The browser preview and the
 * server compositor call the SAME `solveFraming()`. There is no second
 * implementation to keep in sync, which is the failure mode this design
 * exists to avoid — a preview and a render that drift apart are worse than no
 * preview at all.
 */

import type { AnchorName, Anchors, Box, ShotType, Size } from '@/vision/types'

// ─── Spec ────────────────────────────────────────────────────────────────────

/** Vertical placement: pin one anchor to a fraction of canvas height. */
export interface VerticalPlacement {
  anchor: AnchorName
  /** 0–100, percentage of canvas height measured from the top. */
  targetPct: number
}

/** Horizontal placement: pin one anchor to a fraction of canvas width. */
export interface HorizontalPlacement {
  anchor: AnchorName
  /** 0–100, percentage of canvas width measured from the left. */
  targetPct: number
}

/**
 * Scale, expressed as "this landmark span should occupy this much of the
 * canvas".
 *
 * `span` is the one that produces consistent output across a varied catalog:
 * head-to-feet at 80% frames a tall model and a short one identically. `subject`
 * uses the detected subject box instead of two named anchors, for shots with no
 * skeleton. `fixed` bypasses landmarks entirely and is the escape hatch.
 */
export type ScaleStrategy =
  | {
      mode: 'span'
      from: AnchorName
      to: AnchorName
      /** 0–100. The from→to distance becomes this percentage of canvas height. */
      spanPct: number
    }
  | {
      mode: 'subject'
      /** 0–100. The subject box height becomes this percentage of canvas height. */
      heightPct: number
    }
  | {
      mode: 'fixed'
      /** Source pixels per canvas pixel. 1 = no scaling. */
      sourcePerCanvasPixel: number
    }

/** What to do when the derived crop extends past the source image edge. */
export type OverflowPolicy =
  /** Slide the crop back inside. Preserves scale, breaks the anchor target. */
  | 'clamp'
  /** Shrink the crop until it fits. Preserves the anchor target, breaks scale. */
  | 'shrink'
  /** Leave it. The renderer fills the exposed area from `backgroundFill`. */
  | 'allow'

export interface FramingConstraints {
  /**
   * Hard ceiling on magnification: canvas pixels per source pixel. 1.5 means
   * source pixels are never drawn at more than 150% of native size. Exceeding
   * it visibly softens output in bulk runs where nobody inspects every frame.
   */
  maxUpscale: number
  /**
   * Floor on magnification, guarding the opposite failure: a spec that would
   * zoom so far out the subject becomes tiny in the frame.
   */
  minUpscale: number
  overflow: OverflowPolicy
  /**
   * Anchors that must remain inside the canvas after solving. A "head at 12%"
   * template usually also wants the hem to stay visible; listing it here makes
   * the solver shrink rather than silently cut it off.
   */
  keepInside: AnchorName[]
  /** Padding, in percent of canvas size, enforced around `keepInside` anchors. */
  keepInsidePaddingPct: number
}

export const DEFAULT_CONSTRAINTS: FramingConstraints = {
  maxUpscale: 1.5,
  minUpscale: 0.05,
  /**
   * Keep the requested framing and let the background fill whatever the photo
   * does not cover.
   *
   * This was `shrink` while the only things available to fill that gap were a
   * flat colour, a blurred copy or a stretched edge — all of which look worse
   * than simply zooming out until the photo covers the canvas, so zooming out
   * was the right default. With `ai_extend` now the default background (see
   * DEFAULT_BACKGROUND) the trade reverses: the gap gets a real continuation
   * of the studio, so honouring the template's actual framing costs nothing
   * and every photo comes out at the size the template asked for instead of
   * whatever each source photo's own proportions allowed.
   *
   * The pairing matters — `allow` with a plain background is the one
   * combination that produces visible empty space, which is why the two
   * defaults changed together.
   */
  overflow: 'allow',
  keepInside: [],
  keepInsidePaddingPct: 0,
}

/**
 * One framing attempt.
 *
 * Strategies are tried in order; the first whose `requires` anchors are all
 * present above `minConfidence` is used. The last strategy in a chain must be
 * anchor-free, so a spec always resolves to something.
 */
export interface FramingStrategy {
  id: string
  /** Shown in the builder and the debug panel. */
  label: string
  /** Anchors that must exist for this strategy to be eligible. */
  requires: AnchorName[]
  /** Minimum anchor confidence for `requires` to count as satisfied. */
  minConfidence: number
  /** Restrict to particular shot types. Empty means any. */
  shotTypes: ShotType[]
  vertical: VerticalPlacement | null
  horizontal: HorizontalPlacement | null
  scale: ScaleStrategy
}

export interface FramingSpec {
  /** Tried in order. Must be non-empty. */
  strategies: FramingStrategy[]
  constraints: FramingConstraints
  /**
   * Rotate the image so the eye line is level before framing. Off by default:
   * a deliberate head tilt is a styling choice, and levelling it is destructive.
   */
  levelEyeLine: boolean
}

// ─── Result ──────────────────────────────────────────────────────────────────

/**
 * A crop rectangle in SOURCE-image pixels. May extend outside the image when
 * the overflow policy is `allow`; `overflow` below reports by how much.
 */
export interface CropBox {
  x: number
  y: number
  width: number
  height: number
}

export interface AnchorPlacement {
  anchor: AnchorName
  /** Position in source pixels. */
  source: { x: number; y: number }
  /** Where it landed on the canvas, in canvas pixels. */
  canvas: { x: number; y: number }
  /** Where the spec asked for it, in canvas pixels. Null if unconstrained. */
  target: { x: number; y: number } | null
  /** Signed canvas-pixel error, target minus actual. Non-zero after a clamp. */
  error: { x: number; y: number } | null
  confidence: number
}

export type ConstraintViolationCode =
  | 'max_upscale_clamped'
  | 'min_upscale_clamped'
  | 'crop_clamped_to_source'
  | 'crop_shrunk_to_fit'
  | 'crop_overflows_source'
  | 'keep_inside_violated'
  | 'anchor_missing'
  | 'fallback_used'

export interface ConstraintViolation {
  code: ConstraintViolationCode
  severity: 'info' | 'warning'
  message: string
  /** How much the constraint was missed by, in canvas pixels or as a ratio. */
  magnitude?: number
}

export interface FramingResult {
  /** The crop to take from the source, in source pixels. */
  crop: CropBox
  /** Canvas pixels per source pixel. >1 means the source is magnified. */
  upscale: number
  /** Which strategy produced this, and why. */
  strategyId: string
  strategyLabel: string
  /** True when the chosen strategy was not the first — the primary was ineligible. */
  usedFallback: boolean
  /** Where every referenced anchor ended up. Drives the debug overlay. */
  placements: AnchorPlacement[]
  violations: ConstraintViolation[]
  /** How far the crop extends past each source edge, in source pixels. 0 when inside. */
  overflow: { left: number; top: number; right: number; bottom: number }
  /** Canvas the crop was solved against. */
  canvas: Size
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

/**
 * Everything the solver needs about an image. Note this is a small subset of
 * `VisionMetadata` — the solver is deliberately decoupled from the full
 * document so the preview can run it against a trimmed payload sent over the
 * wire.
 */
export interface FramingSubject {
  image: Size
  anchors: Anchors
  shotType: ShotType
  /** Tight box around the subject, source pixels. Used by `scale.mode: 'subject'`. */
  subjectBox: Box | null
}

// ─── Presets ─────────────────────────────────────────────────────────────────

/**
 * Ready-made chains for the framings a fashion catalog actually needs. The
 * builder offers these as starting points; every field stays editable.
 *
 * Each chain degrades deliberately: a full-body spec that cannot find feet
 * falls back to hips, then to the subject box, then to a plain contained fit.
 * The output stays consistent across a catalog because the fallbacks target the
 * same visual result, not because every image detected perfectly.
 */
export const FRAMING_PRESETS: Record<string, { name: string; description: string; spec: FramingSpec }> = {
  full_body_editorial: {
    name: 'Full body — editorial',
    description:
      'Head near the top, feet near the bottom, subject centred. The standard look-book frame.',
    spec: {
      levelEyeLine: false,
      constraints: {
        ...DEFAULT_CONSTRAINTS,
        maxUpscale: 1.4,
        // Both ends of the figure are guarded, not just the crown: a boundary
        // fix that keeps the head on target must not be free to push the feet
        // out the bottom in the process.
        keepInside: ['head_top', 'feet', 'knee_center'],
        keepInsidePaddingPct: 1,
      },
      strategies: [
        {
          id: 'head_to_feet',
          label: 'Head to feet',
          requires: ['head_top', 'feet'],
          minConfidence: 0.35,
          shotTypes: ['full_body'],
          vertical: { anchor: 'head_top', targetPct: 8 },
          horizontal: { anchor: 'subject_center', targetPct: 50 },
          scale: { mode: 'span', from: 'head_top', to: 'feet', spanPct: 84 },
        },
        {
          id: 'head_to_knees',
          label: 'Head to knees',
          requires: ['head_top', 'knee_center'],
          minConfidence: 0.35,
          // A real body shot missing only feet — not a close-up or product
          // shot that happens to have stray anchors. Restricting this keeps the
          // chain from being pressed into service on an incompatible photo; see
          // `isShotTypeApplicable` in the solver.
          shotTypes: ['full_body', 'three_quarter', 'half_body'],
          vertical: { anchor: 'head_top', targetPct: 10 },
          horizontal: { anchor: 'subject_center', targetPct: 50 },
          scale: { mode: 'span', from: 'head_top', to: 'knee_center', spanPct: 72 },
        },
        {
          id: 'subject_fit',
          label: 'Fit subject',
          requires: [],
          minConfidence: 0,
          shotTypes: [],
          vertical: null,
          horizontal: { anchor: 'subject_center', targetPct: 50 },
          scale: { mode: 'subject', heightPct: 88 },
        },
      ],
    },
  },

  portrait_beauty: {
    name: 'Portrait — beauty',
    description: 'Eye line on the upper third, head filling the frame. For crops above the waist.',
    spec: {
      levelEyeLine: false,
      constraints: {
        ...DEFAULT_CONSTRAINTS,
        maxUpscale: 2.0,
        keepInside: ['head_top', 'chin'],
        keepInsidePaddingPct: 2,
      },
      strategies: [
        {
          id: 'eye_line_third',
          label: 'Eye line on upper third',
          requires: ['eye_line', 'chin'],
          minConfidence: 0.4,
          shotTypes: ['portrait', 'close_up', 'half_body'],
          vertical: { anchor: 'eye_line', targetPct: 36 },
          horizontal: { anchor: 'eye_line', targetPct: 50 },
          scale: { mode: 'span', from: 'head_top', to: 'chin', spanPct: 34 },
        },
        {
          id: 'head_shoulders',
          label: 'Head and shoulders',
          requires: ['head_top', 'shoulder_center'],
          minConfidence: 0.35,
          shotTypes: ['portrait', 'close_up', 'half_body'],
          vertical: { anchor: 'head_top', targetPct: 14 },
          horizontal: { anchor: 'shoulder_center', targetPct: 50 },
          scale: { mode: 'span', from: 'head_top', to: 'shoulder_center', spanPct: 42 },
        },
        {
          id: 'subject_fit',
          label: 'Fit subject',
          requires: [],
          minConfidence: 0,
          shotTypes: [],
          vertical: null,
          horizontal: { anchor: 'subject_center', targetPct: 50 },
          scale: { mode: 'subject', heightPct: 80 },
        },
      ],
    },
  },

  garment_focus: {
    name: 'Garment focus',
    description:
      'Frames the clothing rather than the person — neckline to hem, head allowed to crop.',
    spec: {
      levelEyeLine: false,
      constraints: {
        ...DEFAULT_CONSTRAINTS,
        maxUpscale: 1.6,
        keepInside: ['garment_top', 'garment_hem'],
        keepInsidePaddingPct: 2,
      },
      strategies: [
        {
          id: 'neckline_to_hem',
          label: 'Neckline to hem',
          requires: ['garment_top', 'garment_hem'],
          minConfidence: 0.3,
          shotTypes: [],
          vertical: { anchor: 'garment_top', targetPct: 10 },
          horizontal: { anchor: 'subject_center', targetPct: 50 },
          scale: { mode: 'span', from: 'garment_top', to: 'garment_hem', spanPct: 80 },
        },
        {
          id: 'shoulders_to_hips',
          label: 'Shoulders to hips',
          requires: ['shoulder_center', 'hip_center'],
          minConfidence: 0.35,
          shotTypes: [],
          vertical: { anchor: 'shoulder_center', targetPct: 18 },
          horizontal: { anchor: 'shoulder_center', targetPct: 50 },
          scale: { mode: 'span', from: 'shoulder_center', to: 'hip_center', spanPct: 55 },
        },
        {
          id: 'subject_fit',
          label: 'Fit subject',
          requires: [],
          minConfidence: 0,
          shotTypes: [],
          vertical: null,
          horizontal: { anchor: 'subject_center', targetPct: 50 },
          scale: { mode: 'subject', heightPct: 90 },
        },
      ],
    },
  },

  flat_lay: {
    name: 'Flat lay / product',
    description: 'Centres the subject with even margins. For shots with no person.',
    spec: {
      levelEyeLine: false,
      constraints: {
        ...DEFAULT_CONSTRAINTS,
        maxUpscale: 1.2,
        // Deliberately NOT the `allow` default. A flat lay is a product on a
        // sweep with even margins around it — the whole look is the margin,
        // so zooming out until the piece fits is the intent rather than a
        // compromise, and there is no studio environment to continue. Kept
        // explicit so it reads as a choice, not a leftover.
        overflow: 'shrink',
        keepInside: [],
        keepInsidePaddingPct: 0,
      },
      strategies: [
        {
          id: 'subject_centered',
          label: 'Subject centred',
          requires: [],
          minConfidence: 0,
          shotTypes: [],
          vertical: { anchor: 'subject_center', targetPct: 50 },
          horizontal: { anchor: 'subject_center', targetPct: 50 },
          scale: { mode: 'subject', heightPct: 82 },
        },
      ],
    },
  },
}

export const DEFAULT_FRAMING_PRESET = 'full_body_editorial'

export function clonePreset(id: string): FramingSpec {
  const preset = FRAMING_PRESETS[id] ?? FRAMING_PRESETS[DEFAULT_FRAMING_PRESET]
  return JSON.parse(JSON.stringify(preset.spec)) as FramingSpec
}
