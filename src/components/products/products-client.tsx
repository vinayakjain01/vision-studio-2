'use client'

import * as React from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { Images, Loader2, Search } from 'lucide-react'
import { fetcher } from '@/lib/api'
import { DeleteButton } from '@/components/ui/delete-button'
import { BulkGeneratePanel } from '@/components/products/bulk-generate-panel'
import { humanize, percent } from '@/lib/utils'
import { Badge, Button, EmptyState, Input, Panel, Select, Spinner } from '@/components/ui/primitives'
import type { ProductSummary } from '@/app/api/products/route'

interface Response {
  products: ProductSummary[]
  total: number
  categories: { category: string; count: number }[]
  hasMore: boolean
}

const PAGE_SIZE = 60

export function ProductsClient() {
  const [search, setSearch] = React.useState('')
  const [debounced, setDebounced] = React.useState('')
  const [category, setCategory] = React.useState('')
  const [limit, setLimit] = React.useState(PAGE_SIZE)

  // Debounce the search so typing does not fire a query per keystroke against
  // a catalog of thousands.
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 250)
    return () => clearTimeout(timer)
  }, [search])

  const params = new URLSearchParams({ limit: String(limit) })
  if (debounced) params.set('search', debounced)
  if (category) params.set('category', category)

  const { data, isLoading, mutate } = useSWR<Response>(`/api/products?${params}`, fetcher, {
    keepPreviousData: true,
    // Analysis fills in behind the list; refresh while anything is still pending.
    refreshInterval: latest =>
      latest?.products.some(p => p.visionStatus === 'pending' || p.visionStatus === 'processing')
        ? 4000
        : 0,
  })

  const products = data?.products ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-ink-subtle)]"
          />
          <Input
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Search products or folders"
            className="pl-8"
          />
        </div>

        <Select
          value={category}
          onChange={event => setCategory(event.target.value)}
          className="w-52"
        >
          <option value="">All categories</option>
          {(data?.categories ?? []).map(entry => (
            <option key={entry.category} value={entry.category}>
              {entry.category} ({entry.count})
            </option>
          ))}
        </Select>

        {data && (
          <span className="numeric text-xs text-[var(--color-ink-subtle)]">
            {data.total} product{data.total === 1 ? '' : 's'}
          </span>
        )}
        {isLoading && <Spinner className="text-[var(--color-ink-subtle)]" />}
      </div>

      {!!data?.total && (
        <BulkGeneratePanel
          search={debounced}
          category={category}
          productCount={data.total}
          onGenerated={() => mutate()}
        />
      )}

      {products.length === 0 && !isLoading ? (
        <Panel>
          <EmptyState
            icon={<Images size={26} />}
            title={debounced || category ? 'No matching products' : 'No products yet'}
            description={
              debounced || category
                ? 'Try a different search or clear the category filter.'
                : 'Import a folder of photographs to get started.'
            }
            action={
              !debounced && !category ? (
                <Link
                  href="/import"
                  className="inline-flex items-center rounded-md bg-[var(--color-accent)] px-3.5 py-2 text-sm font-medium text-[var(--color-accent-ink)]"
                >
                  Import a folder
                </Link>
              ) : undefined
            }
          />
        </Panel>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {products.map(product => (
              <ProductCard key={product.id} product={product} onDeleted={() => mutate()} />
            ))}
          </div>

          {data?.hasMore && (
            <div className="flex justify-center pt-2">
              <Button variant="outline" onClick={() => setLimit(l => l + PAGE_SIZE)}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ProductCard({
  product,
  onDeleted,
}: {
  product: ProductSummary
  onDeleted: () => void
}) {
  const statusTone =
    product.visionStatus === 'ready'
      ? 'positive'
      : product.visionStatus === 'failed'
        ? 'danger'
        : product.visionStatus === 'unavailable'
          ? 'warning'
          : 'neutral'

  return (
    <div className="panel group relative overflow-hidden transition-colors hover:border-[var(--color-border-strong)]">
      {/* Outside the link: a button nested in an anchor swallows its own clicks. */}
      <div className="absolute right-1.5 top-1.5 z-10 rounded-md bg-black/65 opacity-0 backdrop-blur transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <DeleteButton
          confirmLabel="Delete product"
          successLabel={`Deleted "${product.name}"`}
          onDeleted={onDeleted}
          onDelete={async () => {
            const r = await fetch(`/api/products/${product.id}/delete`, { method: 'POST' })
            if (!r.ok) throw new Error('Could not delete this product')
            return r.json()
          }}
        />
      </div>

      <Link href={`/products/${product.id}`} className="block">
      <div className="relative aspect-[3/4] overflow-hidden bg-[var(--color-canvas)]">
        {product.thumbnailUrl ? (
          <img
            src={product.thumbnailUrl}
            alt={product.name}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="grid h-full place-items-center text-[var(--color-ink-subtle)]">
            <Images size={20} />
          </div>
        )}

        {product.visionStatus === 'processing' && (
          <span className="absolute right-1.5 top-1.5 rounded bg-black/70 p-1">
            <Loader2 size={11} className="animate-spin text-[var(--color-accent)]" />
          </span>
        )}

        {product.imageCount > 1 && (
          <span className="numeric absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium">
            {product.imageCount}
          </span>
        )}
      </div>

      <div className="space-y-1.5 px-2.5 py-2">
        <p className="truncate text-xs font-medium leading-tight">{product.name}</p>
        <p className="truncate text-[11px] text-[var(--color-ink-subtle)]">
          {product.folderPath || 'root'}
        </p>

        <div className="flex flex-wrap items-center gap-1">
          {product.shotType ? (
            <Badge tone="neutral">{humanize(product.shotType)}</Badge>
          ) : (
            <Badge tone={statusTone}>{product.visionStatus}</Badge>
          )}
          {product.confidence != null && (
            <span className="numeric text-[10px] text-[var(--color-ink-subtle)]">
              {percent(product.confidence)}
            </span>
          )}
        </div>
      </div>
      </Link>
    </div>
  )
}
