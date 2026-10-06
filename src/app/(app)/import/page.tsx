import { imports } from '@/db/repositories'
import { withTenant } from '@/tenancy/page-context'
import { PageHeader, PageBody } from '@/components/shell/page-header'
import { ImportClient } from '@/components/import/import-client'

export const dynamic = 'force-dynamic'

export default async function ImportPage() {
  return withTenant(() => (
    <>
      <PageHeader
        title="Import"
        description="Pick a folder of product photography. The tree is walked recursively, each folder becomes a product, and vision analysis starts as files land."
      />
      <PageBody>
        <ImportClient recentImports={imports.list(10)} />
      </PageBody>
    </>
  ))
}
