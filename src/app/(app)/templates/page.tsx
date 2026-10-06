import { PageHeader, PageBody } from '@/components/shell/page-header'
import { TemplatesClient } from '@/components/templates/templates-client'

export const dynamic = 'force-dynamic'

export default function TemplatesPage() {
  return (
    <>
      <PageHeader
        title="Templates"
        description="A template says where landmarks land on the canvas. The same template frames a tall model and a short one identically."
      />
      <PageBody>
        <TemplatesClient />
      </PageBody>
    </>
  )
}
