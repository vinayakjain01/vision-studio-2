'use client'

import * as React from 'react'
import type { BackgroundMode, BackgroundSettings } from '@/templates/types'
import { Field, Input, Select, Slider } from '@/components/ui/primitives'
import { AiExtendStatus } from './ai-extend-status'

const MODE_HINTS: Record<BackgroundMode, string> = {
  solid: 'A flat colour. Visible only where the crop does not cover the canvas.',
  gradient: 'Two-stop linear gradient.',
  blur_extend:
    'A blurred, zoomed copy of the photo fills the frame behind the subject. Use with the "allow" overflow policy so exposed edges blend rather than showing a hard band.',
  edge_extend: 'Stretches the crop to fill. Cheaper than blur; works on plain seamless backdrops.',
  // Wording matched deliberately to the sibling CatalogStudio project's own
  // "Fit" control, so the same concept reads identically across both tools.
  ai_extend:
    'AI will generate natural background to fill empty canvas regions. The original product image is never modified.',
}

export function BackgroundControls({
  background,
  onChange,
}: {
  background: BackgroundSettings
  onChange: (background: BackgroundSettings) => void
}) {
  const set = (patch: Partial<BackgroundSettings>) => onChange({ ...background, ...patch })

  return (
    <div className="space-y-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-subtle)]">
        Background
      </p>

      <Field label="Mode" hint={MODE_HINTS[background.mode]}>
        <Select
          value={background.mode}
          onChange={e => set({ mode: e.target.value as BackgroundMode })}
        >
          <option value="solid">Solid colour</option>
          <option value="gradient">Gradient</option>
          <option value="blur_extend">Blurred extend</option>
          <option value="edge_extend">Edge extend</option>
          <option value="ai_extend">AI Extend (fills canvas with AI)</option>
        </Select>
      </Field>

      {(background.mode === 'solid' ||
        background.mode === 'blur_extend' ||
        background.mode === 'edge_extend' ||
        background.mode === 'ai_extend') && (
        <Field label="Base colour">
          <div className="flex items-center gap-1.5">
            <input
              type="color"
              value={/^#[0-9a-f]{6}$/i.test(background.color) ? background.color : '#ffffff'}
              onChange={e => set({ color: e.target.value })}
              className="h-8 w-8 shrink-0 cursor-pointer rounded border border-[var(--color-border-strong)] bg-transparent"
            />
            <Input
              value={background.color}
              onChange={e => set({ color: e.target.value })}
              className="h-8 font-mono text-[11px]"
            />
          </div>
        </Field>
      )}

      {background.mode === 'gradient' && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field label="From">
              <input
                type="color"
                value={background.gradientFrom}
                onChange={e => set({ gradientFrom: e.target.value })}
                className="h-8 w-full cursor-pointer rounded border border-[var(--color-border-strong)] bg-transparent"
              />
            </Field>
            <Field label="To">
              <input
                type="color"
                value={background.gradientTo}
                onChange={e => set({ gradientTo: e.target.value })}
                className="h-8 w-full cursor-pointer rounded border border-[var(--color-border-strong)] bg-transparent"
              />
            </Field>
          </div>
          <Slider
            label="Angle"
            value={background.gradientAngle}
            min={0}
            max={360}
            step={5}
            unit="°"
            onChange={gradientAngle => set({ gradientAngle })}
          />
        </>
      )}

      {background.mode === 'blur_extend' && (
        <>
          <Slider
            label="Blur"
            value={background.blurRadius}
            min={4}
            max={64}
            step={1}
            unit="px"
            onChange={blurRadius => set({ blurRadius })}
          />
          <Slider
            label="Zoom"
            value={background.blurZoom}
            min={1}
            max={1.8}
            step={0.05}
            unit="×"
            onChange={blurZoom => set({ blurZoom })}
            hint="Over-scales the blurred copy so its own edges stay off-canvas."
          />
        </>
      )}

      {background.mode === 'ai_extend' && <AiExtendStatus />}

      {background.mode === 'ai_extend' && (
        <Field
          label="Backdrop prompt (optional)"
          hint="Describe what's actually behind the subject in these photos — backdrop material, floor, lighting rig. Left empty, a generic prompt is used instead. A prompt written for a different backdrop than what's really in frame will invent equipment that isn't there, so only describe photos this template actually renders."
        >
          <textarea
            value={background.backdropPrompt ?? ''}
            onChange={e => set({ backdropPrompt: e.target.value })}
            placeholder="e.g. A plain grey studio backdrop with visible fabric folds, lit by a large softbox directly overhead, on a matte white floor."
            rows={4}
            className="w-full resize-none rounded-md border border-[var(--color-border-strong)] bg-[var(--color-canvas)] px-2.5 py-2 text-[11px] leading-relaxed text-[var(--color-ink)] placeholder:text-[var(--color-ink-subtle)] focus:border-[var(--color-accent)] focus:outline-none"
          />
        </Field>
      )}
    </div>
  )
}
