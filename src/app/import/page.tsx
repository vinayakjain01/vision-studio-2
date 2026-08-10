import { imports } from '@/db/repositories'
import { PageHeader, PageBody } from '@/components/shell/page-header'
import { ImportClient } from '@/components/import/import-client'

export const dynamic = 'force-dynamic'

export default function ImportPage() {
  return (
    <>
      <PageHeader
        title="Import"
        description="Pick a folder of product photography. The tree is walked recursively, each folder becomes a product, and vision analysis starts as files land."
      />
      <PageBody>
        <ImportClient recentImports={imports.list(10)} />
      </PageBody>
    </>
  )
}
