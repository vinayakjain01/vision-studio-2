/**
 * Framing controls.
 *
 * The template builder's defining panel: instead of position/scale sliders, the
 * operator states a RESULT in terms of landmarks — "the head sits 8% down",
 * "head to feet fills 84% of the height" — and the solver derives whatever crop
 * each photo needs to produce it.
 *
 * ── Two modes ────────────────────────────────────────────────────────────────
 * SIMPLE shows the three or four sliders that decide how the output looks, in
 * plain language, for the main rule only. That is the whole job most of the
 * time.
 *
 * ADVANCED exposes the full strategy chain and the constraints. What a template
 * does on the images where the main rule does NOT apply is most of what
 * determines whether a bulk run looks consistent — but it is not what you reach
 * for first, and showing all of it up front made a simple task look hard.
 */

'use client'

import * as React from 'react'
import {
  ChevronDown,
  ChevronRight,
  GripVertical,
  Info,
  Plus,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { SHOT_TYPES, type AnchorName, type Anchors, type ShotType } from '@/vision/types'
import {
  FRAMING_PRESETS,
  clonePreset,
  type FramingResult,
  type FramingSpec,
  type FramingStrategy,
  type OverflowPolicy,
  type ScaleStrategy,
} from '@/framing/types'
import type { BackgroundMode, BackgroundSettings } from '@/templates/types'
import { Badge, Button, Field, Select, Slider } from '@/components/ui/primitives'
import { AiExtendStatus } from './ai-extend-status'
import { cn, humanize } from '@/lib/utils'

/** Anchors offered in the pickers, grouped so the list is navigable. */
const ANCHOR_GROUPS: { label: string; anchors: AnchorName[] }[] = [
  { label: 'Head', anchors: ['head_top', 'eye_line', 'chin', 'neck'] },
  {
    label: 'Torso',
    anchors: ['shoulder_center', 'shoulder_left', 'shoulder_right', 'chest', 'waist', 'hip_center'],
  },
  { label: 'Legs', anchors: ['knee_center', 'ankle_center', 'feet'] },
  { label: 'Garment', anchors: ['garment_top', 'garment_hem'] },
  { label: 'Subject', anchors: ['subject_center', 'subject_top', 'subject_bottom'] },
]

/**
 * Plain-language names for anchors.
 *
 * Simple mode reads "Head from top", not "head_top target %". The identifiers
 * stay visible in advanced mode, where the person editing a fallback chain
 * wants to see exactly which anchor is referenced.
 */
const ANCHOR_LABELS: Record<AnchorName, string> = {
  head_top: 'Head',
  eye_line: 'Eye line',
  chin: 'Chin',
  neck: 'Neck',
  shoulder_left: 'Left shoulder',
  shoulder_right: 'Right shoulder',
  shoulder_center: 'Shoulders',
  chest: 'Chest',
  waist: 'Waist',
  hip_center: 'Hips',
  knee_center: 'Knees',
  ankle_center: 'Ankles',
  feet: 'Feet',
  garment_top: 'Neckline',
  garment_hem: 'Hem',
  subject_center: 'Subject centre',
  subject_top: 'Subject top',
  subject_bottom: 'Subject bottom',
}

function anchorLabel(anchor: AnchorName): string {
  return ANCHOR_LABELS[anchor] ?? anchor
}

export interface FramingControlsProps {
  spec: FramingSpec
  onChange: (spec: FramingSpec) => void
  /** Anchors of the currently previewed subject, for availability hints. */
  subjectAnchors?: Anchors
  subjectShotType?: ShotType
  /** Strategy the solver actually chose for the preview subject. */
  activeStrategyId?: string | null
  /**
   * The solved result for the photo on screen.
   *
   * Simple mode reads its violations to explain, in place, why a slider is not
   * moving the preview — a constraint can legitimately absorb a control entirely
   * (magnification already at the cap, crop already at the photo's edge), and
   * without saying so the control just looks broken.
   */
  activeFraming?: FramingResult | null
  /**
   * Vertical target percentages that actually move the crop on the previewed
   * photo. Highlighted on the slider so a physically-limited control explains
   * itself instead of looking broken.
   */
  verticalRange?: { minPct: number; maxPct: number } | null
  /**
   * The template's background settings — NOT a framing concern, and owned by
   * the Canvas tab, but surfaced here anyway.
   *
   * The overflow policy below has an option that reads "Allow it (background
   * fills the gap)", and choosing it raises the obvious next question —
   * WHICH background? — whose answer lives on a different tab entirely. The
   * operator ends up staring at white space in the preview with no indication
   * that the setting which fixes it exists somewhere else. Mirroring just the
   * mode picker at the point the question arises is worth the prop drill; the
   * full set of background controls stays on Canvas.
   */
  background?: BackgroundSettings
  onBackgroundChange?: (background: BackgroundSettings) => void
}

export function FramingControls(props: FramingControlsProps) {
  const [advanced, setAdvanced] = React.useState(false)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-subtle)]">
          Framing
        </p>
        <button
          onClick={() => setAdvanced(v => !v)}
          className="text-[11px] text-[var(--color-accent)] transition-opacity hover:opacity-80"
        >
          {advanced ? 'Simple' : 'Advanced'}
        </button>
      </div>

      {advanced ? <AdvancedFraming {...props} /> : <SimpleFraming {...props} />}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// Simple mode
// ════════════════════════════════════════════════════════════════════════════

function SimpleFraming({
  spec,
  onChange,
  activeStrategyId,
  activeFraming,
  verticalRange,
}: FramingControlsProps) {
  /**
   * Simple mode edits the rule that is framing the photo CURRENTLY ON SCREEN,
   * not always the first one.
   *
   * Editing rule 1 while the preview is framed by rule 2 makes every slider look
   * broken: the numbers move, the image does not. Following the active rule means
   * dragging a slider always changes what the operator is looking at, and
   * switching preview photo switches which rule is being edited — which is the
   * honest mental model, since a chain exists precisely because different photos
   * need different rules.
   */
  const activeIndex = Math.max(
    0,
    spec.strategies.findIndex(s => s.id === activeStrategyId)
  )
  const primary = spec.strategies[activeIndex]
  const isBackupRule = activeIndex > 0
  const fallbackCount = Math.max(0, spec.strategies.length - 1)

  const updatePrimary = (patch: Partial<FramingStrategy>) => {
    onChange({
      ...spec,
      strategies: spec.strategies.map((s, i) => (i === activeIndex ? { ...s, ...patch } : s)),
    })
  }

  const presetId = React.useMemo(
    () =>
      Object.entries(FRAMING_PRESETS).find(
        ([, preset]) => preset.spec.strategies[0]?.id === spec.strategies[0]?.id
      )?.[0] ?? '',
    [spec.strategies]
  )

  if (!primary) {
    return (
      <p className="text-[11px] text-[var(--color-ink-subtle)]">
        This template has no framing rules. Choose a preset in Advanced mode.
      </p>
    )
  }

  const scale = primary.scale

  return (
    <div className="space-y-4">
      <Field label="Style" hint={FRAMING_PRESETS[presetId]?.description}>
        <Select
          aria-label="Framing style preset"
          value={presetId}
          onChange={event => {
            if (!event.target.value) return
            onChange(clonePreset(event.target.value))
          }}
        >
          {!presetId && <option value="">Custom</option>}
          {Object.entries(FRAMING_PRESETS).map(([id, preset]) => (
            <option key={id} value={id}>
              {preset.name}
            </option>
          ))}
        </Select>
      </Field>

      {/* Which rule these sliders control. Only worth saying when it is not the
          main one, because then the answer is surprising. */}
      {isBackupRule && (
        <p className="flex items-start gap-1.5 rounded-md border border-[color-mix(in_oklch,var(--color-warning)_30%,transparent)] bg-[color-mix(in_oklch,var(--color-warning)_8%,transparent)] px-2.5 py-2 text-[11px] leading-snug text-[var(--color-ink-muted)]">
          <Info size={12} className="mt-0.5 shrink-0 text-[var(--color-warning)]" />
          <span>
            This photo is framed by the backup rule <strong>{primary.label}</strong>, so the sliders
            below edit that rule. Pick a photo the main rule applies to in order to edit it instead.
          </span>
        </p>
      )}

      <div className="space-y-3.5 border-t border-[var(--color-border)] pt-4">
        {primary.vertical && (
          <Slider
            label={`${anchorLabel(primary.vertical.anchor)} from top`}
            value={primary.vertical.targetPct}
            min={0}
            max={60}
            step={0.5}
            unit="%"
            onChange={targetPct =>
              updatePrimary({ vertical: { ...primary.vertical!, targetPct } })
            }
            effectiveRange={verticalRange}
            hint={`Every photo is cropped so the ${anchorLabel(
              primary.vertical.anchor
            ).toLowerCase()} lands here.`}
          />
        )}

        {scale.mode === 'span' && (
          <Slider
            label={`${anchorLabel(scale.from)} to ${anchorLabel(scale.to).toLowerCase()}`}
            value={scale.spanPct}
            min={20}
            max={100}
            step={0.5}
            unit="% of height"
            onChange={spanPct => updatePrimary({ scale: { ...scale, spanPct } })}
            hint="Sets the subject's size. A tall model and a short one end up the same size in frame."
          />
        )}

        {scale.mode === 'subject' && (
          <Slider
            label="Subject size"
            value={scale.heightPct}
            min={20}
            max={100}
            step={0.5}
            unit="% of height"
            onChange={heightPct => updatePrimary({ scale: { ...scale, heightPct } })}
          />
        )}

        {primary.horizontal && (
          <Slider
            label={`${anchorLabel(primary.horizontal.anchor)} from left`}
            value={primary.horizontal.targetPct}
            min={0}
            max={100}
            step={0.5}
            unit="%"
            onChange={targetPct =>
              updatePrimary({ horizontal: { ...primary.horizontal!, targetPct } })
            }
            hint="50% centres the subject."
          />
        )}

        <Slider
          label="Maximum zoom"
          value={spec.constraints.maxUpscale}
          min={1}
          max={4}
          step={0.1}
          unit="×"
          onChange={maxUpscale =>
            onChange({ ...spec, constraints: { ...spec.constraints, maxUpscale } })
          }
          hint="Stops low-resolution photos being blown up until they soften."
        />
      </div>

      <ConstraintNotes framing={activeFraming} />

      {fallbackCount > 0 && (
        <p className="flex items-start gap-1.5 border-t border-[var(--color-border)] pt-3 text-[11px] leading-snug text-[var(--color-ink-subtle)]">
          <Info size={12} className="mt-0.5 shrink-0" />
          <span>
            This template has {spec.strategies.length} rules in total. The others cover photos where
            these landmarks were not detected — open <strong>Advanced</strong> to see the chain.
          </span>
        </p>
      )}
    </div>
  )
}

/**
 * Why the sliders may not be moving the preview.
 *
 * A constraint can absorb a control completely — if magnification is already at
 * the cap, dragging the span slider toward "bigger" changes nothing at all. The
 * solver reports each compromise; this restates the ones an operator can act on,
 * in terms of the control that would release them.
 */
function ConstraintNotes({ framing }: { framing?: FramingResult | null }) {
  if (!framing) return null

  const notes: string[] = []

  for (const violation of framing.violations) {
    switch (violation.code) {
      case 'max_upscale_clamped':
        notes.push(
          `Zoom is capped at ${framing.upscale.toFixed(2)}×, so making the subject larger has no effect. Raise "Maximum zoom" to allow it.`
        )
        break
      case 'crop_overflows_source':
        notes.push(
          'The frame is larger than this photo, so the background fills the edges. Lower the size slider, or use a canvas closer to the photo shape.'
        )
        break
      case 'crop_clamped_to_source':
        notes.push(
          'The crop hit the edge of the photo, so the landmark cannot sit exactly on target.'
        )
        break
      case 'crop_shrunk_to_fit':
        notes.push('The frame was zoomed out to stay inside the photo, so the subject looks smaller.')
        break
      case 'keep_inside_violated':
        notes.push('Zoomed out so the landmarks you asked to keep in frame stay visible.')
        break
    }
  }

  if (notes.length === 0) return null

  return (
    <div className="space-y-1.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] px-2.5 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-ink-subtle)]">
        On this photo
      </p>
      {[...new Set(notes)].map((note, index) => (
        <p
          key={index}
          className="flex items-start gap-1.5 text-[11px] leading-snug text-[var(--color-ink-muted)]"
        >
          <TriangleAlert size={11} className="mt-0.5 shrink-0 text-[var(--color-warning)]" />
          {note}
        </p>
      ))}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// Advanced mode
// ════════════════════════════════════════════════════════════════════════════

function AdvancedFraming({
  spec,
  onChange,
  subjectAnchors = {},
  subjectShotType,
  activeStrategyId,
  background,
  onBackgroundChange,
}: FramingControlsProps) {
  const [expanded, setExpanded] = React.useState<Set<number>>(() => new Set([0]))

  const update = (patch: Partial<FramingSpec>) => onChange({ ...spec, ...patch })

  const updateStrategy = (index: number, patch: Partial<FramingStrategy>) => {
    const strategies = spec.strategies.map((s, i) => (i === index ? { ...s, ...patch } : s))
    update({ strategies })
  }

  const addStrategy = () => {
    const strategy: FramingStrategy = {
      id: `strategy_${spec.strategies.length + 1}_${Math.random().toString(36).slice(2, 6)}`,
      label: `Rule ${spec.strategies.length + 1}`,
      requires: ['head_top'],
      minConfidence: 0.35,
      shotTypes: [],
      vertical: { anchor: 'head_top', targetPct: 10 },
      horizontal: { anchor: 'subject_center', targetPct: 50 },
      scale: { mode: 'span', from: 'head_top', to: 'feet', spanPct: 80 },
    }
    // Insert BEFORE the last entry: the final strategy is the anchor-free
    // backstop, and a new rule after it could never be reached.
    const strategies = [...spec.strategies]
    strategies.splice(Math.max(0, strategies.length - 1), 0, strategy)
    update({ strategies })
    setExpanded(new Set([Math.max(0, strategies.length - 2)]))
  }

  const removeStrategy = (index: number) => {
    if (spec.strategies.length <= 1) return
    update({ strategies: spec.strategies.filter((_, i) => i !== index) })
  }

  const moveStrategy = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= spec.strategies.length) return
    const strategies = [...spec.strategies]
    ;[strategies[index], strategies[target]] = [strategies[target], strategies[index]]
    update({ strategies })
  }

  const toggleExpanded = (index: number) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  return (
    <div className="space-y-4">
      <Field label="Start from a preset" hint="Replaces the whole chain below.">
        <Select
          value=""
          onChange={event => {
            if (!event.target.value) return
            onChange(clonePreset(event.target.value))
            setExpanded(new Set([0]))
          }}
        >
          <option value="">Choose a preset…</option>
          {Object.entries(FRAMING_PRESETS).map(([id, preset]) => (
            <option key={id} value={id}>
              {preset.name}
            </option>
          ))}
        </Select>
      </Field>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-subtle)]">
            Rule chain
          </p>
          <Button size="sm" variant="ghost" onClick={addStrategy}>
            <Plus size={13} /> Add rule
          </Button>
        </div>

        <p className="text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
          Tried top to bottom. The first rule whose landmarks were detected wins. The last rule is
          the fallback and must need no landmarks.
        </p>

        {spec.strategies.map((strategy, index) => {
          const isLast = index === spec.strategies.length - 1
          const missing = requiredAnchors(strategy).filter(
            name =>
              !subjectAnchors[name] || subjectAnchors[name]!.confidence < strategy.minConfidence
          )
          const shotMismatch =
            strategy.shotTypes.length > 0 &&
            subjectShotType != null &&
            !strategy.shotTypes.includes(subjectShotType)
          const applicable = missing.length === 0 && !shotMismatch
          const isActive = activeStrategyId === strategy.id

          return (
            <div
              key={strategy.id}
              className={cn(
                'rounded-md border transition-colors',
                isActive
                  ? 'border-[var(--color-accent)] bg-[color-mix(in_oklch,var(--color-accent)_7%,transparent)]'
                  : 'border-[var(--color-border)] bg-[var(--color-surface-raised)]'
              )}
            >
              <div className="flex items-center gap-1.5 px-2 py-2">
                <button
                  onClick={() => toggleExpanded(index)}
                  className="text-[var(--color-ink-subtle)] hover:text-[var(--color-ink)]"
                  aria-label={expanded.has(index) ? 'Collapse' : 'Expand'}
                >
                  {expanded.has(index) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>

                <input
                  value={strategy.label}
                  onChange={event => updateStrategy(index, { label: event.target.value })}
                  className="min-w-0 flex-1 bg-transparent text-xs font-medium text-[var(--color-ink)] outline-none"
                />

                {isActive && <Badge tone="accent">active</Badge>}
                {!isActive && !applicable && (
                  <Badge tone="neutral" className="opacity-70">
                    n/a here
                  </Badge>
                )}
                {isLast && <Badge tone="neutral">fallback</Badge>}

                <div className="flex items-center gap-0.5">
                  <button
                    onClick={() => moveStrategy(index, -1)}
                    disabled={index === 0}
                    className="p-0.5 text-[var(--color-ink-subtle)] hover:text-[var(--color-ink)] disabled:opacity-25"
                    aria-label="Move up"
                  >
                    <GripVertical size={13} />
                  </button>
                  <button
                    onClick={() => removeStrategy(index)}
                    disabled={spec.strategies.length <= 1}
                    className="p-0.5 text-[var(--color-ink-subtle)] hover:text-[var(--color-danger)] disabled:opacity-25"
                    aria-label="Delete rule"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>

              {expanded.has(index) && (
                <div className="space-y-3.5 border-t border-[var(--color-border)] px-3 py-3">
                  {missing.length > 0 && (
                    <p className="flex items-start gap-1.5 text-[11px] leading-snug text-[var(--color-warning)]">
                      <TriangleAlert size={12} className="mt-0.5 shrink-0" />
                      This preview subject is missing {missing.join(', ')}, so this rule is skipped
                      for it.
                    </p>
                  )}

                  <VerticalControl strategy={strategy} index={index} update={updateStrategy} />
                  <ScaleControl strategy={strategy} index={index} update={updateStrategy} />
                  <HorizontalControl strategy={strategy} index={index} update={updateStrategy} />

                  <div className="space-y-2 border-t border-[var(--color-border)] pt-3">
                    <Field
                      label="Only for shot types"
                      hint="Leave empty to allow any. Useful when a rule only makes sense for full-body shots."
                    >
                      <div className="flex flex-wrap gap-1">
                        {SHOT_TYPES.map(type => {
                          const on = strategy.shotTypes.includes(type)
                          return (
                            <button
                              key={type}
                              onClick={() =>
                                updateStrategy(index, {
                                  shotTypes: on
                                    ? strategy.shotTypes.filter(t => t !== type)
                                    : [...strategy.shotTypes, type],
                                })
                              }
                              className={cn(
                                'rounded border px-1.5 py-0.5 text-[10px] transition-colors',
                                on
                                  ? 'border-[var(--color-accent)] bg-[color-mix(in_oklch,var(--color-accent)_18%,transparent)] text-[var(--color-accent)]'
                                  : 'border-[var(--color-border)] text-[var(--color-ink-subtle)] hover:text-[var(--color-ink-muted)]'
                              )}
                            >
                              {humanize(type)}
                            </button>
                          )
                        })}
                      </div>
                    </Field>

                    <Slider
                      label="Minimum landmark confidence"
                      value={strategy.minConfidence}
                      min={0}
                      max={0.9}
                      step={0.05}
                      onChange={value => updateStrategy(index, { minConfidence: value })}
                      hint="Below this, a landmark counts as not detected and the rule is skipped."
                    />
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="space-y-3 border-t border-[var(--color-border)] pt-4">
        <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-subtle)]">
          Constraints
        </p>

        <Slider
          label="Maximum magnification"
          value={spec.constraints.maxUpscale}
          min={1}
          max={4}
          step={0.1}
          unit="×"
          onChange={value => update({ constraints: { ...spec.constraints, maxUpscale: value } })}
          hint="Never draw source pixels larger than this. Guards against soft output on low-resolution files."
        />

        <Field
          label="When the crop falls outside the photo"
          hint={OVERFLOW_HINTS[spec.constraints.overflow]}
        >
          <Select
            value={spec.constraints.overflow}
            onChange={event =>
              update({
                constraints: {
                  ...spec.constraints,
                  overflow: event.target.value as OverflowPolicy,
                },
              })
            }
          >
            <option value="clamp">Slide it back inside (keeps scale)</option>
            <option value="shrink">Zoom out until it fits (keeps the landmark on target)</option>
            <option value="allow">Allow it (background fills the gap)</option>
          </Select>
        </Field>

        {/* "Background fills the gap" — but WHICH background? That setting
            lives on the Canvas tab, which is not where anyone is looking when
            they pick this option and then see white space in the preview.
            Mirrored here, at the moment the question arises. */}
        {spec.constraints.overflow === 'allow' && background && onBackgroundChange && (
          <div className="space-y-2 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] p-2.5">
            <Field
              label="…and what fills it"
              hint={GAP_FILL_HINTS[background.mode]}
            >
              <Select
                value={background.mode}
                onChange={e =>
                  onBackgroundChange({ ...background, mode: e.target.value as BackgroundMode })
                }
              >
                <option value="solid">Solid colour — leaves flat empty space</option>
                <option value="gradient">Gradient</option>
                <option value="blur_extend">Blurred extend</option>
                <option value="edge_extend">Edge extend</option>
                <option value="ai_extend">AI Extend (fills canvas with AI)</option>
              </Select>
            </Field>

            {background.mode === 'ai_extend' && <AiExtendStatus />}

            <p className="text-[10px] leading-snug text-[var(--color-ink-subtle)]">
              Same setting as Background on the <strong>Canvas</strong> tab — colours, blur
              amount and the AI Extend backdrop prompt live there.
            </p>
          </div>
        )}

        <Field
          label="Always keep in frame"
          hint="The crop zooms out if needed so these landmarks stay visible."
        >
          <div className="flex flex-wrap gap-1">
            {(['head_top', 'chin', 'garment_hem', 'feet', 'hip_center'] as AnchorName[]).map(
              name => {
                const on = spec.constraints.keepInside.includes(name)
                return (
                  <button
                    key={name}
                    onClick={() =>
                      update({
                        constraints: {
                          ...spec.constraints,
                          keepInside: on
                            ? spec.constraints.keepInside.filter(a => a !== name)
                            : [...spec.constraints.keepInside, name],
                        },
                      })
                    }
                    className={cn(
                      'rounded border px-1.5 py-0.5 text-[10px] transition-colors',
                      on
                        ? 'border-[var(--color-accent)] bg-[color-mix(in_oklch,var(--color-accent)_18%,transparent)] text-[var(--color-accent)]'
                        : 'border-[var(--color-border)] text-[var(--color-ink-subtle)] hover:text-[var(--color-ink-muted)]'
                    )}
                  >
                    {name}
                  </button>
                )
              }
            )}
          </div>
        </Field>

        {spec.constraints.keepInside.length > 0 && (
          <Slider
            label="Padding around kept landmarks"
            value={spec.constraints.keepInsidePaddingPct}
            min={0}
            max={10}
            step={0.5}
            unit="%"
            onChange={value =>
              update({ constraints: { ...spec.constraints, keepInsidePaddingPct: value } })
            }
          />
        )}
      </div>
    </div>
  )
}

const OVERFLOW_HINTS: Record<OverflowPolicy, string> = {
  clamp:
    'Keeps the subject the requested size, but the landmark ends up off its target by however far the crop had to move.',
  shrink:
    'Keeps the landmark exactly on target by zooming out, so the subject appears smaller than asked for.',
  allow:
    'Leaves the crop where it is; the exposed area is filled by the template background — choose which below.',
}

/**
 * Written from the perspective of the gap specifically, not the background in
 * general (the Canvas tab's `MODE_HINTS` covers that). Someone reading these
 * has just chosen to allow overflow and is deciding what should appear in the
 * space it creates — "solid" being a real, legitimate answer is worth saying
 * plainly rather than implying every template ought to fill it.
 */
const GAP_FILL_HINTS: Record<BackgroundMode, string> = {
  solid: 'The gap stays a flat colour. Correct for catalogues that want clean empty margins.',
  gradient: 'The gap becomes part of a two-stop gradient across the whole canvas.',
  blur_extend: 'A blurred, zoomed copy of the photo fills the gap. Cheap and always available.',
  edge_extend: 'The photo’s own edge pixels stretch into the gap. Works on plain seamless backdrops.',
  ai_extend:
    // Matched to the sibling CatalogStudio project's own "Fit" control so the
    // same concept reads identically across both tools.
    'AI will generate natural background to fill empty canvas regions. The original product image is never modified.',
}

// ─── Sub-controls ────────────────────────────────────────────────────────────

function AnchorSelect({
  value,
  onChange,
  allowNone,
}: {
  value: AnchorName | null
  onChange: (value: AnchorName | null) => void
  allowNone?: boolean
}) {
  return (
    <Select
      value={value ?? ''}
      onChange={event => onChange((event.target.value || null) as AnchorName | null)}
    >
      {allowNone && <option value="">None (centre on subject)</option>}
      {ANCHOR_GROUPS.map(group => (
        <optgroup key={group.label} label={group.label}>
          {group.anchors.map(anchor => (
            <option key={anchor} value={anchor}>
              {anchor}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  )
}

function VerticalControl({
  strategy,
  index,
  update,
}: {
  strategy: FramingStrategy
  index: number
  update: (index: number, patch: Partial<FramingStrategy>) => void
}) {
  return (
    <div className="space-y-2">
      <Field
        label="Vertical anchor"
        hint="This landmark is pinned to a fixed height on the canvas, on every photo."
      >
        <AnchorSelect
          allowNone
          value={strategy.vertical?.anchor ?? null}
          onChange={anchor =>
            update(index, {
              vertical: anchor ? { anchor, targetPct: strategy.vertical?.targetPct ?? 10 } : null,
            })
          }
        />
      </Field>

      {strategy.vertical && (
        <Slider
          label={`${strategy.vertical.anchor} from top`}
          value={strategy.vertical.targetPct}
          min={0}
          max={100}
          step={0.5}
          unit="%"
          onChange={value =>
            update(index, { vertical: { ...strategy.vertical!, targetPct: value } })
          }
        />
      )}
    </div>
  )
}

function HorizontalControl({
  strategy,
  index,
  update,
}: {
  strategy: FramingStrategy
  index: number
  update: (index: number, patch: Partial<FramingStrategy>) => void
}) {
  return (
    <div className="space-y-2">
      <Field label="Horizontal anchor">
        <AnchorSelect
          allowNone
          value={strategy.horizontal?.anchor ?? null}
          onChange={anchor =>
            update(index, {
              horizontal: anchor
                ? { anchor, targetPct: strategy.horizontal?.targetPct ?? 50 }
                : null,
            })
          }
        />
      </Field>

      {strategy.horizontal && (
        <Slider
          label={`${strategy.horizontal.anchor} from left`}
          value={strategy.horizontal.targetPct}
          min={0}
          max={100}
          step={0.5}
          unit="%"
          onChange={value =>
            update(index, { horizontal: { ...strategy.horizontal!, targetPct: value } })
          }
        />
      )}
    </div>
  )
}

function ScaleControl({
  strategy,
  index,
  update,
}: {
  strategy: FramingStrategy
  index: number
  update: (index: number, patch: Partial<FramingStrategy>) => void
}) {
  const scale = strategy.scale

  const setMode = (mode: ScaleStrategy['mode']) => {
    if (mode === scale.mode) return
    const next: ScaleStrategy =
      mode === 'span'
        ? { mode: 'span', from: 'head_top', to: 'feet', spanPct: 80 }
        : mode === 'subject'
          ? { mode: 'subject', heightPct: 85 }
          : { mode: 'fixed', sourcePerCanvasPixel: 1 }
    update(index, { scale: next })
  }

  return (
    <div className="space-y-2 border-t border-[var(--color-border)] pt-3">
      <Field
        label="Scale"
        hint={
          scale.mode === 'span'
            ? 'The distance between two landmarks becomes a fixed share of the canvas — this is what makes a tall model and a short one frame identically.'
            : scale.mode === 'subject'
              ? 'The detected subject box becomes a fixed share of the canvas. Use where there is no skeleton.'
              : 'A fixed zoom, ignoring landmarks entirely.'
        }
      >
        <Select
          value={scale.mode}
          onChange={event => setMode(event.target.value as ScaleStrategy['mode'])}
        >
          <option value="span">Landmark span</option>
          <option value="subject">Subject height</option>
          <option value="fixed">Fixed zoom</option>
        </Select>
      </Field>

      {scale.mode === 'span' && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field label="From">
              <AnchorSelect
                value={scale.from}
                onChange={anchor => anchor && update(index, { scale: { ...scale, from: anchor } })}
              />
            </Field>
            <Field label="To">
              <AnchorSelect
                value={scale.to}
                onChange={anchor => anchor && update(index, { scale: { ...scale, to: anchor } })}
              />
            </Field>
          </div>
          <Slider
            label="Span fills"
            value={scale.spanPct}
            min={5}
            max={100}
            step={0.5}
            unit="% of height"
            onChange={value => update(index, { scale: { ...scale, spanPct: value } })}
          />
        </>
      )}

      {scale.mode === 'subject' && (
        <Slider
          label="Subject fills"
          value={scale.heightPct}
          min={10}
          max={100}
          step={0.5}
          unit="% of height"
          onChange={value => update(index, { scale: { ...scale, heightPct: value } })}
        />
      )}

      {scale.mode === 'fixed' && (
        <Slider
          label="Source pixels per canvas pixel"
          value={scale.sourcePerCanvasPixel}
          min={0.2}
          max={4}
          step={0.05}
          unit="×"
          onChange={value => update(index, { scale: { ...scale, sourcePerCanvasPixel: value } })}
        />
      )}
    </div>
  )
}

/** Anchors a strategy needs, whether listed in `requires` or implied. */
function requiredAnchors(strategy: FramingStrategy): AnchorName[] {
  const names = new Set<AnchorName>(strategy.requires)
  if (strategy.vertical) names.add(strategy.vertical.anchor)
  if (strategy.horizontal) names.add(strategy.horizontal.anchor)
  if (strategy.scale.mode === 'span') {
    names.add(strategy.scale.from)
    names.add(strategy.scale.to)
  }
  return [...names]
}
