/**
 * Right after an import finishes, let the operator fix the shot type for any
 * folder the per-photo detector will mis-read — most commonly a colorway
 * grid sheet (several garments in one image), where each sheet's own crop
 * makes the detector guess a different shot type sheet to sheet, so the same
 * framing rule crops them inconsistently. Setting one label for the whole
 * folder here is the same `shotTypeOverride` a template rule or AI-Extend
 * eligibility check reads later — see `getUsableAnalysis` in
 * `src/services/vision-service.ts`.
 *
 * Collapsed by default: most imports never need this, and a 500-photo import
 * creating dozens of products shouldn't force a long list onto everyone who
 * didn't ask for it.
 */

'use client'

import * as React from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { fetcher, postJson } from '@/lib/api'
import { humanize } from '@/lib/utils'
import { Select } from '@/components/ui/primitives'
import { SHOT_TYPES } from '@/vision/types'
import type { ProductSummary } from '@/app/api/products/route'

const OVERRIDE_CHOICES = SHOT_TYPES.filter(type => type !== 'unknown')

export function ImportShotTypeOverrides({ importId }: { importId: string }) {
  const [expanded, setExpanded] = React.useState(false)
  const { data, mutate } = useSWR<{ products: ProductSummary[] }>(
    expanded ? `/api/products?importId=${importId}&limit=500` : null,
    fetcher
  )
  const products = data?.products ?? []

  return (
    <div className="border-t border-[var(--color-border)]">
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="flex w-full items-center gap-1.5 px-4 py-3 text-left text-xs font-medium text-[var(--color-ink-subtle)] transition-colors hover:text-[var(--color-ink)]"
      >
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        Does a folder&apos;s shot type need fixing?
      </button>

      {expanded && (
        <div className="space-y-2 px-4 pb-4">
          <p className="text-[11px] text-[var(--color-ink-subtle)]">
            If a folder&apos;s photos are really one grid or sheet per image (e.g. a colorway chart), the
            detector can read each sheet differently. Pick one shot type for the whole folder to make
            every photo in it behave the same way — leave it on Auto-detect otherwise.
          </p>

          {!data ? (
            <p className="text-[11px] text-[var(--color-ink-subtle)]">Loading folders…</p>
          ) : products.length === 0 ? (
            <p className="text-[11px] text-[var(--color-ink-subtle)]">No folders in this import.</p>
          ) : (
            <ul className="divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
              {products.map(product => (
                <li key={product.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium">{product.name}</p>
                    <p className="truncate text-[11px] text-[var(--color-ink-subtle)]">
                      {product.folderPath || 'root'} · {product.imageCount} photo
                      {product.imageCount === 1 ? '' : 's'}
                    </p>
                  </div>
                  <Select
                    aria-label={`Shot type override for ${product.name}`}
                    className="w-40 shrink-0"
                    value={product.shotTypeOverride ?? ''}
                    onChange={async event => {
                      const value = event.target.value || null
                      // Optimistic: the dropdown itself is the only feedback an
                      // operator setting several folders in a row sees between
                      // picks, so it should reflect the pick immediately rather
                      // than waiting on the round trip.
                      mutate(
                        current =>
                          current && {
                            products: current.products.map(p =>
                              p.id === product.id ? { ...p, shotTypeOverride: value } : p
                            ),
                          },
                        { revalidate: false }
                      )
                      try {
                        await postJson(`/api/products/${product.id}/shot-type-override`, {
                          shotType: value,
                        })
                      } catch (err) {
                        toast.error(
                          err instanceof Error ? err.message : `Could not update "${product.name}"`
                        )
                        mutate()
                      }
                    }}
                  >
                    <option value="">Auto-detect</option>
                    {OVERRIDE_CHOICES.map(type => (
                      <option key={type} value={type}>
                        {humanize(type)}
                      </option>
                    ))}
                  </Select>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
