'use client'

import * as React from 'react'
import { Tabs } from '@/components/ui/primitives'
import { TenantsTable } from './tenants-table'
import { GlobalPanel } from './global-panel'
import { AuditLogViewer } from './audit-log-viewer'

type Tab = 'tenants' | 'global' | 'audit'

export function AdminClient() {
  const [tab, setTab] = React.useState<Tab>('tenants')

  return (
    <div className="space-y-4">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'tenants', label: 'Tenants' },
          { value: 'global', label: 'Global' },
          { value: 'audit', label: 'Audit log' },
        ]}
      />
      {tab === 'tenants' && <TenantsTable />}
      {tab === 'global' && <GlobalPanel />}
      {tab === 'audit' && <AuditLogViewer />}
    </div>
  )
}
