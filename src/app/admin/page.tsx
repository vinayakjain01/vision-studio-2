import { withAdmin } from '@/tenancy/admin-page-context'
import { AdminClient } from '@/components/admin/admin-client'

export const dynamic = 'force-dynamic'

export default async function AdminPage() {
  // Establishes the access gate (redirect-to-login / 404-for-non-admin —
  // see withAdmin's doc comment) before anything else renders. The page
  // itself needs nothing from the resolved session beyond that the check
  // passed; all real data is fetched client-side from /api/admin/*.
  return withAdmin(() => <AdminClient />)
}
