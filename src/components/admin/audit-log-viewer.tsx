'use client'

import * as React from 'react'
import useSWR from 'swr'
import { fetcher } from '@/lib/api'
import { Panel, PanelHeader, Input, Select, Button } from '@/components/ui/primitives'
import { timeAgo } from '@/lib/utils'

interface AuditLogEntry {
  id: string
  actorUserId: string | null
  tenantId: string | null
  action: string
  detail: unknown
  createdAt: string
}

const ACTIONS = [
  '',
  'admin_create_tenant',
  'admin_suspend_tenant',
  'admin_resume_tenant',
  'admin_update_quotas',
  'admin_reset_password',
  'admin_mark_pending_deletion',
  'admin_cancel_pending_deletion',
  'admin_purge_tenant',
  'change_password',
  'change_password_failed',
  'login_failed',
]

export function AuditLogViewer() {
  const [actorUserId, setActorUserId] = React.useState('')
  const [action, setAction] = React.useState('')
  const [tenantId, setTenantId] = React.useState('')
  const [fromDate, setFromDate] = React.useState('')
  const [toDate, setToDate] = React.useState('')

  const params = new URLSearchParams()
  if (actorUserId) params.set('actorUserId', actorUserId)
  if (action) params.set('action', action)
  if (tenantId) params.set('tenantId', tenantId)
  if (fromDate) params.set('fromDate', new Date(fromDate).toISOString())
  if (toDate) params.set('toDate', new Date(toDate).toISOString())

  const { data, isLoading, mutate } = useSWR<{ entries: AuditLogEntry[] }>(
    `/api/admin/audit-log?${params.toString()}`,
    fetcher
  )

  return (
    <Panel>
      <PanelHeader title="Audit log" description="Every admin action, who did it, when." />
      <div className="flex flex-wrap items-end gap-2 border-b border-[var(--color-border)] px-4 py-3">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase text-[var(--color-ink-subtle)]">Actor user id</label>
          <Input value={actorUserId} onChange={e => setActorUserId(e.target.value)} placeholder="usr_…" className="h-8 w-40" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase text-[var(--color-ink-subtle)]">Action</label>
          <Select value={action} onChange={e => setAction(e.target.value)} className="h-8 w-48">
            {ACTIONS.map(a => (
              <option key={a} value={a}>
                {a || 'All actions'}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase text-[var(--color-ink-subtle)]">Tenant id</label>
          <Input value={tenantId} onChange={e => setTenantId(e.target.value)} placeholder="tnt_…" className="h-8 w-40" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase text-[var(--color-ink-subtle)]">From</label>
          <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="h-8" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase text-[var(--color-ink-subtle)]">To</label>
          <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="h-8" />
        </div>
        <Button size="sm" variant="outline" onClick={() => mutate()}>
          Refresh
        </Button>
      </div>

      {isLoading && <p className="px-4 py-6 text-sm text-[var(--color-ink-subtle)]">Loading…</p>}

      {!isLoading && (!data || data.entries.length === 0) && (
        <p className="px-4 py-6 text-sm text-[var(--color-ink-subtle)]">No matching entries.</p>
      )}

      {!!data?.entries.length && (
        <div className="max-h-[32rem] divide-y divide-[var(--color-border)] overflow-y-auto">
          {data.entries.map(entry => (
            <div key={entry.id} className="px-4 py-2.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono font-medium text-[var(--color-ink)]">{entry.action}</span>
                <span className="numeric text-[var(--color-ink-subtle)]">{timeAgo(entry.createdAt)}</span>
              </div>
              <p className="mt-0.5 font-mono text-[10px] text-[var(--color-ink-subtle)]">
                actor {entry.actorUserId ?? '—'} · tenant {entry.tenantId ?? '—'}
              </p>
              {entry.detail != null && (
                <pre className="mt-1 overflow-x-auto rounded bg-[var(--color-surface-raised)] px-2 py-1 text-[10px] text-[var(--color-ink-muted)]">
                  {JSON.stringify(entry.detail)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}
