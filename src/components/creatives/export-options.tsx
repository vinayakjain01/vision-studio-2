/**
 * Export format/quality/resolution picker, shared by every place a creative
 * gets downloaded — the bulk "Download all", a single product's download,
 * and one photo's per-template downloads.
 *
 * Purely client-side UI state. `exportQueryString` turns it into the query
 * string the export routes understand (`/api/creatives/download` and
 * `/api/creatives/[creativeId]/export`); left untouched, it returns an empty
 * string, so a download nobody customised hits the exact same URL — and
 * therefore the exact same untouched-bytes code path — as before these
 * controls existed.
 */

'use client'

import * as React from 'react'
import { Select } from '@/components/ui/primitives'

export type ExportFormatChoice = '' | 'jpeg' | 'png' | 'webp'

export interface ExportSettings {
  /** Empty string means "keep the stored format". */
  format: ExportFormatChoice
  quality: number
  scale: 100 | 75 | 50
}

/**
 * `quality` mirrors `config.render.jpegQuality`'s own default (95) — kept as
 * a plain constant rather than imported, since that module pulls in Node's
 * `path`/`os` and is marked server-only. A mismatch here would only ever
 * matter if the server default changes without this being updated too, and
 * even then only cosmetically: the slider's resting position, not the bytes
 * actually produced (`quality` is only ever sent when it differs from this
 * constant, so the server's own default governs whenever it isn't).
 */
export const DEFAULT_EXPORT_SETTINGS: ExportSettings = { format: '', quality: 95, scale: 100 }

export function exportQueryString(settings: ExportSettings): string {
  const params = new URLSearchParams()
  if (settings.format) params.set('format', settings.format)
  if (settings.format !== 'png' && settings.quality !== DEFAULT_EXPORT_SETTINGS.quality) {
    params.set('quality', String(settings.quality))
  }
  if (settings.scale !== 100) params.set('scale', String(settings.scale))
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

      {/* PNG is lossless — a quality slider has nothing to apply it to. */}
      {settings.format !== 'png' && (
        <div className="flex items-center gap-1.5" title="Export quality">
          <input
            type="range"
            min={1}
            max={100}
            value={settings.quality}
            onChange={e => set({ quality: Number(e.target.value) })}
            aria-label="Export quality"
            className="h-1.5 w-20 accent-[var(--color-accent)]"
          />
          <span className="numeric w-6 shrink-0 text-[10px] text-[var(--color-ink-subtle)]">
            {settings.quality}
          </span>
        </div>
      )}
    </div>
  )
}
