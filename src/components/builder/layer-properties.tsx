/**
 * Layer property editor.
 *
 * The one control worth calling out is "Pin to landmark". A layer pinned to,
 * say, `shoulder_right` positions itself relative to where that landmark landed
 * after framing, so a badge follows the model across a whole catalog instead of
 * sitting at a fixed canvas position that happens to land on her face in every
 * third photo.
 */

'use client'

import * as React from 'react'
import { Trash2 } from 'lucide-react'
import { ANCHOR_NAMES, type AnchorName } from '@/vision/types'
import { TEMPLATE_VARIABLES, type Layer } from '@/templates/types'
import { Button, Field, Input, Select, Slider, Textarea, Toggle } from '@/components/ui/primitives'

export function LayerProperties({
  layer,
  onChange,
  onRemove,
}: {
  layer: Layer
  onChange: (patch: Partial<Layer>) => void
  onRemove: () => void
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <input
          value={layer.name}
          onChange={e => onChange({ name: e.target.value })}
          className="min-w-0 flex-1 bg-transparent text-xs font-semibold outline-none"
        />
        <button
          onClick={onRemove}
          className="text-[var(--color-ink-subtle)] transition-colors hover:text-[var(--color-danger)]"
          aria-label="Delete layer"
        >
          <Trash2 size={13} />
        </button>
      </div>

      {/* Type-specific */}
      {layer.type === 'text' && <TextProperties layer={layer} onChange={onChange} />}
      {layer.type === 'badge' && <BadgeProperties layer={layer} onChange={onChange} />}
      {(layer.type === 'rectangle' || layer.type === 'ellipse') && (
        <ShapeProperties layer={layer} onChange={onChange} />
      )}
      {layer.type === 'image' && <ImageProperties layer={layer} onChange={onChange} />}

      {/* Placement */}
      <div className="space-y-3 border-t border-[var(--color-border)] pt-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-subtle)]">
          Placement
        </p>

        <Field
          label="Pin to landmark"
          hint={
            layer.anchorTo
              ? 'X and Y below are an offset from where this landmark lands after framing.'
              : 'X and Y below are absolute positions on the canvas.'
          }
        >
          <Select
            value={layer.anchorTo ?? ''}
            onChange={e => onChange({ anchorTo: (e.target.value || null) as AnchorName | null })}
          >
            <option value="">Fixed on canvas</option>
            {ANCHOR_NAMES.map(anchor => (
              <option key={anchor} value={anchor}>
                {anchor}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid grid-cols-2 gap-2">
          <Slider
            label={layer.anchorTo ? 'X offset' : 'X'}
            value={layer.x}
            min={layer.anchorTo ? -100 : 0}
            max={100}
            step={0.5}
            unit="%"
            onChange={x => onChange({ x })}
          />
          <Slider
            label={layer.anchorTo ? 'Y offset' : 'Y'}
            value={layer.y}
            min={layer.anchorTo ? -100 : 0}
            max={100}
            step={0.5}
            unit="%"
            onChange={y => onChange({ y })}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Slider
            label="Width"
            value={layer.width}
            min={1}
            max={100}
            step={0.5}
            unit="%"
            onChange={width => onChange({ width })}
          />
          <Slider
            label="Height"
            value={layer.height}
            min={1}
            max={100}
            step={0.5}
            unit="%"
            onChange={height => onChange({ height })}
          />
        </div>

        <Slider
          label="Rotation"
          value={layer.rotation}
          min={-180}
          max={180}
          step={1}
          unit="°"
          onChange={rotation => onChange({ rotation })}
        />

        <Slider
          label="Opacity"
          value={layer.opacity}
          min={0}
          max={1}
          step={0.05}
          onChange={opacity => onChange({ opacity })}
        />

        <Slider
          label="Layer order"
          value={layer.zIndex}
          min={0}
          max={40}
          step={1}
          onChange={zIndex => onChange({ zIndex })}
          hint="Below the template's subject order, this draws behind the photograph."
        />
      </div>
    </div>
  )
}

// ─── Text ────────────────────────────────────────────────────────────────────

function TextProperties({
  layer,
  onChange,
}: {
  layer: Extract<Layer, { type: 'text' }>
  onChange: (patch: Partial<Layer>) => void
}) {
  return (
    <div className="space-y-3">
      <Field label="Content" hint="Use {{variables}} for per-product values.">
        <Textarea
          rows={3}
          value={layer.content}
          onChange={e => onChange({ content: e.target.value } as Partial<Layer>)}
        />
      </Field>

      <div className="flex flex-wrap gap-1">
        {TEMPLATE_VARIABLES.map(variable => (
          <button
            key={variable.key}
            onClick={() =>
              onChange({ content: `${layer.content}${variable.key}` } as Partial<Layer>)
            }
            title={`${variable.label} — e.g. ${variable.example}`}
            className="rounded border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-ink-subtle)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            {variable.key}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Colour">
          <ColorInput
            value={layer.color}
            onChange={color => onChange({ color } as Partial<Layer>)}
          />
        </Field>
        <Field label="Align">
          <Select
            value={layer.align}
            onChange={e => onChange({ align: e.target.value as any } as Partial<Layer>)}
          >
            <option value="left">Left</option>
            <option value="center">Centre</option>
            <option value="right">Right</option>
          </Select>
        </Field>
      </div>

      <Slider
        label="Font size"
        value={layer.fontSizePct}
        min={0.5}
        max={20}
        step={0.1}
        unit="% of height"
        onChange={fontSizePct => onChange({ fontSizePct } as Partial<Layer>)}
      />

      <div className="grid grid-cols-2 gap-2">
        <Slider
          label="Line height"
          value={layer.lineHeight}
          min={0.8}
          max={2.5}
          step={0.05}
          onChange={lineHeight => onChange({ lineHeight } as Partial<Layer>)}
        />
        <Slider
          label="Tracking"
          value={layer.letterSpacing}
          min={-5}
          max={20}
          step={0.5}
          unit="px"
          onChange={letterSpacing => onChange({ letterSpacing } as Partial<Layer>)}
        />
      </div>

      <div className="space-y-2">
        <Toggle
          label="Bold"
          checked={layer.fontWeight === 'bold'}
          onChange={bold => onChange({ fontWeight: bold ? 'bold' : 'normal' } as Partial<Layer>)}
        />
        <Toggle
          label="Uppercase"
          checked={layer.uppercase}
          onChange={uppercase => onChange({ uppercase } as Partial<Layer>)}
        />
        <Toggle
          label="Wrap text"
          checked={layer.wrap}
          onChange={wrap => onChange({ wrap } as Partial<Layer>)}
          hint="Breaks at the layer width instead of overflowing."
        />
      </div>
    </div>
  )
}

// ─── Badge ───────────────────────────────────────────────────────────────────

function BadgeProperties({
  layer,
  onChange,
}: {
  layer: Extract<Layer, { type: 'badge' }>
  onChange: (patch: Partial<Layer>) => void
}) {
  return (
    <div className="space-y-3">
      <Field label="Content">
        <Input
          value={layer.content}
          onChange={e => onChange({ content: e.target.value } as Partial<Layer>)}
        />
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Fill">
          <ColorInput value={layer.fill} onChange={fill => onChange({ fill } as Partial<Layer>)} />
        </Field>
        <Field label="Text">
          <ColorInput
            value={layer.color}
            onChange={color => onChange({ color } as Partial<Layer>)}
          />
        </Field>
      </div>

      <Field label="Shape">
        <Select
          value={layer.shape}
          onChange={e => onChange({ shape: e.target.value as any } as Partial<Layer>)}
        >
          <option value="pill">Pill</option>
          <option value="rectangle">Rectangle</option>
          <option value="circle">Circle</option>
        </Select>
      </Field>

      <Slider
        label="Font size"
        value={layer.fontSizePct}
        min={0.5}
        max={12}
        step={0.1}
        unit="% of height"
        onChange={fontSizePct => onChange({ fontSizePct } as Partial<Layer>)}
      />

      <Toggle
        label="Uppercase"
        checked={layer.uppercase}
        onChange={uppercase => onChange({ uppercase } as Partial<Layer>)}
      />
    </div>
  )
}

// ─── Shapes ──────────────────────────────────────────────────────────────────

function ShapeProperties({
  layer,
  onChange,
}: {
  layer: Extract<Layer, { type: 'rectangle' | 'ellipse' }>
  onChange: (patch: Partial<Layer>) => void
}) {
  return (
    <div className="space-y-3">
      <Field label="Fill">
        <ColorInput value={layer.fill} onChange={fill => onChange({ fill } as Partial<Layer>)} />
      </Field>

      {layer.type === 'rectangle' && (
        <Slider
          label="Corner radius"
          value={layer.borderRadiusPct}
          min={0}
          max={50}
          step={0.5}
          unit="%"
          onChange={borderRadiusPct => onChange({ borderRadiusPct } as Partial<Layer>)}
        />
      )}

      <Field label="Stroke">
        <ColorInput
          value={layer.strokeColor ?? '#000000'}
          onChange={strokeColor => onChange({ strokeColor } as Partial<Layer>)}
          allowNone
          isNone={layer.strokeColor === null}
          onNone={() => onChange({ strokeColor: null } as Partial<Layer>)}
        />
      </Field>

      {layer.strokeColor && (
        <Slider
          label="Stroke width"
          value={layer.strokeWidthPct}
          min={0}
          max={5}
          step={0.1}
          unit="%"
          onChange={strokeWidthPct => onChange({ strokeWidthPct } as Partial<Layer>)}
        />
      )}
    </div>
  )
}

// ─── Image ───────────────────────────────────────────────────────────────────

function ImageProperties({
  layer,
  onChange,
}: {
  layer: Extract<Layer, { type: 'image' }>
  onChange: (patch: Partial<Layer>) => void
}) {
  return (
    <div className="space-y-3">
      <Field
        label="Asset key"
        hint="Storage key under data/media/assets. Copy a logo or overlay there and reference it here."
      >
        <Input
          value={layer.assetKey}
          onChange={e => onChange({ assetKey: e.target.value } as Partial<Layer>)}
          placeholder="logo.png"
        />
      </Field>

      <Field label="Fit">
        <Select
          value={layer.fit}
          onChange={e => onChange({ fit: e.target.value as any } as Partial<Layer>)}
        >
          <option value="contain">Contain</option>
          <option value="cover">Cover</option>
          <option value="fill">Stretch</option>
        </Select>
      </Field>

      <Slider
        label="Corner radius"
        value={layer.borderRadiusPct}
        min={0}
        max={50}
        step={0.5}
        unit="%"
        onChange={borderRadiusPct => onChange({ borderRadiusPct } as Partial<Layer>)}
      />
    </div>
  )
}

// ─── Colour ──────────────────────────────────────────────────────────────────

function ColorInput({
  value,
  onChange,
  allowNone,
  isNone,
  onNone,
}: {
  value: string
  onChange: (value: string) => void
  allowNone?: boolean
  isNone?: boolean
  onNone?: () => void
}) {
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="color"
        value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'}
        onChange={e => onChange(e.target.value)}
        className="h-8 w-8 shrink-0 cursor-pointer rounded border border-[var(--color-border-strong)] bg-transparent"
      />
      <Input
        value={isNone ? '' : value}
        placeholder={isNone ? 'none' : undefined}
        onChange={e => onChange(e.target.value)}
        className="h-8 font-mono text-[11px]"
      />
      {allowNone && (
        <Button size="sm" variant="ghost" onClick={onNone} className="shrink-0">
          None
        </Button>
      )}
    </div>
  )
}
