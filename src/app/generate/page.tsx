import { PageHeader, PageBody } from '@/components/shell/page-header'
import { GenerateClient } from '@/components/generate/generate-client'

export const dynamic = 'force-dynamic'

export default function GeneratePage() {
  return (
    <>
      <PageHeader
        title="Generate"
        description="Render creatives in bulk. The plan is resolved before anything is queued, so what will and will not be covered is visible up front."
      />
      <PageBody>
        <GenerateClient />
      </PageBody>
    </>
  )
}
