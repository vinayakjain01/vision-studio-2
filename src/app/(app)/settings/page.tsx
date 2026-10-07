import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { config } from '@/config'
import { resolveSession } from '@/auth/session'
import { users } from '@/db/control-repositories'
import { PageHeader, PageBody } from '@/components/shell/page-header'
import { SettingsClient } from '@/components/settings/settings-client'
import { AccountPanel } from '@/components/settings/account-panel'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  // A second, cheap session resolution (same pattern as `withTenant`) — the
  // user's own email isn't part of `TenantContext`, so this page needs it
  // directly rather than threading it through `runWithTenant`.
  const jar = await cookies()
  const token = jar.get(config.auth.sessionCookieName)?.value
  const resolved = resolveSession(token)
  if (!resolved) redirect('/login')
  const user = users.get(resolved.userId)
  if (!user) redirect('/login')

  return (
    <>
      <PageHeader title="Settings" description="Your account, and this installation's engine status." />
      <PageBody className="space-y-4">
        <AccountPanel userEmail={user.email} />
        <SettingsClient />
      </PageBody>
    </>
  )
}
