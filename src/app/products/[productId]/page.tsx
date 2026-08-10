import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { products } from '@/db/repositories'
import { PageHeader, PageBody } from '@/components/shell/page-header'
import { ProductDetailClient } from '@/components/products/product-detail-client'

export const dynamic = 'force-dynamic'

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ productId: string }>
}) {
  const { productId } = await params
  const product = products.get(productId)
  if (!product) notFound()

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link
              href="/products"
              className="text-[var(--color-ink-subtle)] transition-colors hover:text-[var(--color-ink)]"
              aria-label="Back to products"
            >
              <ArrowLeft size={16} />
            </Link>
            {product.name}
          </span>
        }
        description={`${product.folderPath || 'root'}${product.category ? ` · ${product.category}` : ''} · ${product.imageCount} image${product.imageCount === 1 ? '' : 's'}`}
      />
      <PageBody>
        <ProductDetailClient productId={productId} />
      </PageBody>
    </>
  )
}
