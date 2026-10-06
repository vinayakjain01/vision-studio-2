import { PageHeader, PageBody } from '@/components/shell/page-header'
import { SettingsClient } from '@/components/settings/settings-client'

export const dynamic = 'force-dynamic'

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Engine"
        description="Model status, capabilities and queue health. Everything here is configured through environment variables — see .env.example."
      />
      <PageBody>
        <SettingsClient />
      </PageBody>
    </>
  )
}
