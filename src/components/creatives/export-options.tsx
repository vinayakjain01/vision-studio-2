/**
 * Export format/resolution/size-budget picker, shared by every place a
 * creative gets downloaded — the bulk "Download all", a single product's
 * download, and one photo's per-template downloads.
 *
 * Purely client-side UI state. `exportQueryString` turns it into the query
 * string the export routes understand (`/api/creatives/download` and
 * `/api/creatives/[creativeId]/export`); left untouched, it returns an empty
 * string, so a download nobody customised hits the exact same URL — and
 * therefore the exact same untouched-bytes code path — as before these
 * controls existed.
 *
 * There is no direct quality slider here on purpose. The target-size range
 * is optional and off by default: left off, export quality is whatever it
 * already was before this feature existed (the render-time default). Turned
 * on, the two KB inputs replace a quality guess with a size an operator
 * actually cares about — see `encodeWithinSizeBudget` in
 * `src/render/export-image.ts` for how that's honoured.
 */

'use client'

import * as React from 'react'
import { Input, Select } from '@/components/ui/primitives'

export type ExportFormatChoice = '' | 'jpeg' | 'png' | 'webp'

export interface SizeRange {
  min: number
  max: number
}

export interface ExportSettings {
  /** Empty string means "keep the stored format". */
  format: ExportFormatChoice
  scale: 100 | 75 | 50
  /** null = off, i.e. use the render-time default quality. */
  sizeRange: SizeRange | null
}

/** Pre-filled when the "Target size" checkbox is first ticked. */
const DEFAULT_SIZE_RANGE: SizeRange = { min: 100, max: 300 }

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = { format: '', scale: 100, sizeRange: null }

export function exportQueryString(settings: ExportSettings): string {
  const params = new URLSearchParams()
  if (settings.format) params.set('format', settings.format)
  if (settings.scale !== 100) params.set('scale', String(settings.scale))
  // PNG is lossless — a size budget has no quality knob to search over, so
  // it's never sent even if a range was left filled in from a prior format.
  if (settings.format !== 'png' && settings.sizeRange) {
    params.set('sizeMinKb', String(settings.sizeRange.min))
    params.set('sizeMaxKb', String(settings.sizeRange.max))
  }
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

export function ExportOptionsFields({
  settings,
  onChange,
}: {
  settings: ExportSettings
  onChange: (settings: ExportSettings) => void
}) {
  const set = (patch: Partial<ExportSettings>) => onChange({ ...settings, ...patch })
  const sizeRange = settings.sizeRange

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        aria-label="Export format"
        value={settings.format}
        onChange={e => set({ format: e.target.value as ExportFormatChoice })}
        className="h-7 w-[5.5rem] text-[11px]"
      >
        <option value="">Original</option>
        <option value="jpeg">JPEG</option>
        <option value="png">PNG</option>
        <option value="webp">WebP</option>
      </Select>

      <Select
        aria-label="Export resolution"
        value={String(settings.scale)}
        onChange={e => set({ scale: Number(e.target.value) as ExportSettings['scale'] })}
        className="h-7 w-20 text-[11px]"
      >
        <option value="100">100%</option>
        <option value="75">75%</option>
        <option value="50">50%</option>
      </Select>

      {/* PNG is lossless — there's no size budget to apply it to. */}
      {settings.format !== 'png' && (
        <div className="flex items-center gap-1.5">
          <label className="flex cursor-pointer items-center gap-1 text-[11px] text-[var(--color-ink-subtle)]">
            <input
              type="checkbox"
              checked={sizeRange !== null}
              onChange={e => set({ sizeRange: e.target.checked ? DEFAULT_SIZE_RANGE : null })}
              className="accent-[var(--color-accent)]"
            />
            Target size
          </label>

          {sizeRange && (
            <>
              <Input
                type="number"
                min={1}
                value={sizeRange.min}
                onChange={e =>
                  set({ sizeRange: { ...sizeRange, min: Math.max(1, Number(e.target.value) || 1) } })
                }
                aria-label="Minimum size in KB"
                className="h-7 w-14 px-1.5 text-center text-[11px]"
              />
              <span className="text-[10px] text-[var(--color-ink-subtle)]">–</span>
              <Input
                type="number"
                min={sizeRange.min}
                value={sizeRange.max}
                onChange={e =>
                  set({
                    sizeRange: {
                      ...sizeRange,
                      max: Math.max(sizeRange.min, Number(e.target.value) || sizeRange.min),
                    },
                  })
                }
                aria-label="Maximum size in KB"
                className="h-7 w-14 px-1.5 text-center text-[11px]"
              />
              <span className="text-[10px] text-[var(--color-ink-subtle)]">KB</span>
            </>
          )}
        </div>
      )}
    </div>
  )
}
