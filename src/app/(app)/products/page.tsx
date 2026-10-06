import { PageHeader, PageBody } from '@/components/shell/page-header'
import { ProductsClient } from '@/components/products/products-client'

export const dynamic = 'force-dynamic'

export default function ProductsPage() {
  return (
    <>
      <PageHeader
        title="Products"
        description="Every imported product, with what the Vision Engine found in its primary shot."
      />
      <PageBody>
        <ProductsClient />
      </PageBody>
    </>
  )
}
