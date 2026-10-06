import { PageHeader, PageBody } from '@/components/shell/page-header'
import { RulesClient } from '@/components/rules/rules-client'

export const dynamic = 'force-dynamic'

export default function RulesPage() {
  return (
    <>
      <PageHeader
        title="Rules"
        description="Map products to templates by folder, category, import, or what the Vision Engine detected. Evaluated top to bottom; the first match wins."
      />
      <PageBody>
        <RulesClient />
      </PageBody>
    </>
  )
}
