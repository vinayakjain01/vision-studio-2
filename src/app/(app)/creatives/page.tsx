import { PageHeader, PageBody } from '@/components/shell/page-header'
import { CreativesClient } from '@/components/creatives/creatives-client'

export const dynamic = 'force-dynamic'

export default function CreativesPage() {
  return (
    <>
      <PageHeader
        title="Creatives"
        description="Every rendered image. Badges mark the ones whose framing fell back or hit a constraint — the ones worth reviewing."
      />
      <PageBody>
        <CreativesClient />
      </PageBody>
    </>
  )
}
