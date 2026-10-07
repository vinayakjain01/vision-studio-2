'use client'

import * as React from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import { Plus, X, Copy } from 'lucide-react'
import { fetcher, postJson, patchJson, del } from '@/lib/api'
import { jitterMs } from '@/lib/polling'
import { Panel, PanelHeader, Button, Input, Badge, Alert } from '@/components/ui/primitives'
import { formatBytes, timeAgo } from '@/lib/utils'

interface AdminTenantRow {
  id: string
  name: string
  status: 'active' | 'suspended' | 'pending_deletion'
  pendingDeletionAt: string | null
  ownerUserId: string | null
  ownerEmail: string | null
  storageUsedBytes: number
  storageQuotaBytes: number
  queuedJobs: number
  runningJobs: number
  jobsPerHour24h: number
  queueWaitP50Ms: number
  queueWaitP95Ms: number
  aiExtendCallsThisMonth: number
  aiExtendQuota: number
  weight: number
  lastActivityAt: string | null
  createdAt: string
}

/** Shown once, right after creation/reset — never retrievable again after this. */
function RevealedPassword({
  email,
  password,
  onDismiss,
}: {
  email: string
  password: string
  onDismiss: () => void
}) {
  return (
    <Alert tone="warning" title={`Temporary password for ${email}`}>
      <div className="flex items-center gap-2">
        <code className="rounded bg-[var(--color-surface-raised)] px-2 py-1 font-mono text-sm">{password}</code>
        <button
          onClick={() => {
            navigator.clipboard?.writeText(password).catch(() => {})
            toast.success('Copied')
          }}
          className="text-[var(--color-ink-subtle)] hover:text-[var(--color-ink)]"
          aria-label="Copy"
        >
          <Copy size={14} />
        </button>
        <button onClick={onDismiss} className="ml-auto text-[var(--color-ink-subtle)] hover:text-[var(--color-ink)]">
          <X size={14} />
        </button>
      </div>
      <p className="mt-1">
        Shown once — this cannot be retrieved again. The account must change it at next login.
      </p>
    </Alert>
  )
}

function CreateTenantForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = React.useState(false)
  const [tenantName, setTenantName] = React.useState('')
  const [email, setEmail] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus size={13} /> New tenant
      </Button>
    )
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const result = await postJson<{ tenantId: string; userId: string; tempPassword: string }>(
        '/api/admin/tenants',
        { tenantName, email }
      )
      onCreated()
      setOpen(false)
      setTenantName('')
      setEmail('')
      window.dispatchEvent(
        new CustomEvent('admin:reveal-password', { detail: { email, password: result.tempPassword } })
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create tenant')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <Input placeholder="Tenant name" value={tenantName} onChange={e => setTenantName(e.target.value)} required className="w-48" />
      <Input placeholder="owner@email.com" type="email" value={email} onChange={e => setEmail(e.target.value)} required className="w-56" />
      <Button size="sm" type="submit" disabled={busy}>
        {busy ? 'Creating…' : 'Create'}
      </Button>
      <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  )
}

function QuotaEditor({ tenant, onSaved }: { tenant: AdminTenantRow; onSaved: () => void }) {
  const [maxStorageBytes, setMaxStorageBytes] = React.useState(String(tenant.storageQuotaBytes))
  const [maxAiExtendPerMonth, setMaxAiExtendPerMonth] = React.useState(String(tenant.aiExtendQuota))
  const [weight, setWeight] = React.useState(String(tenant.weight))
  const [busy, setBusy] = React.useState(false)

  const save = async () => {
    setBusy(true)
    try {
      await patchJson(`/api/admin/tenants/${tenant.id}`, {
        action: 'update_quotas',
        quotas: {
          maxStorageBytes: Number(maxStorageBytes),
          maxAiExtendPerMonth: Number(maxAiExtendPerMonth),
          weight: Number(weight),
        },
      })
      toast.success('Quotas updated — effective immediately')
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update quotas')
    } finally {
      setBusy(false)
    }
  }

  return (
    <tr className="bg-[var(--color-surface-raised)]">
      <td colSpan={9} className="px-3 py-2">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase text-[var(--color-ink-subtle)]">Storage quota (bytes)</label>
            <Input value={maxStorageBytes} onChange={e => setMaxStorageBytes(e.target.value)} className="h-8 w-36" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase text-[var(--color-ink-subtle)]">AI Extend / month</label>
            <Input value={maxAiExtendPerMonth} onChange={e => setMaxAiExtendPerMonth(e.target.value)} className="h-8 w-28" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase text-[var(--color-ink-subtle)]">Scheduler weight</label>
            <Input value={weight} onChange={e => setWeight(e.target.value)} className="h-8 w-20" />
          </div>
          <Button size="sm" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </td>
    </tr>
  )
}

function PurgeConfirm({ tenant, onDone }: { tenant: AdminTenantRow; onDone: () => void }) {
  const [confirmName, setConfirmName] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const purge = async () => {
    setBusy(true)
    try {
      await del(`/api/admin/tenants/${tenant.id}`, { confirmName })
      toast.success(`${tenant.name} purged permanently`)
      onDone()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not purge tenant')
    } finally {
      setBusy(false)
    }
  }

  return (
    <tr className="bg-[color-mix(in_oklch,var(--color-danger)_8%,transparent)]">
      <td colSpan={9} className="px-3 py-2">
        <div className="flex flex-wrap items-end gap-2">
          <p className="text-xs text-[var(--color-danger)]">
            Permanently deletes {tenant.name} — all data, media, jobs. Type the tenant name to confirm:
          </p>
          <Input
            value={confirmName}
            onChange={e => setConfirmName(e.target.value)}
            placeholder={tenant.name}
            className="h-8 w-48"
          />
          <Button size="sm" variant="danger" disabled={busy || confirmName !== tenant.name} onClick={purge}>
            {busy ? 'Purging…' : 'Purge permanently'}
          </Button>
        </div>
      </td>
    </tr>
  )
}

export function TenantsTable() {
  const { data, isLoading, mutate } = useSWR<{ tenants: AdminTenantRow[] }>('/api/admin/tenants', fetcher, {
    refreshInterval: () => jitterMs(10_000),
  })
  const [editingQuotasFor, setEditingQuotasFor] = React.useState<string | null>(null)
  const [purgingFor, setPurgingFor] = React.useState<string | null>(null)
  const [revealed, setRevealed] = React.useState<{ email: string; password: string } | null>(null)

  React.useEffect(() => {
    const handler = (e: Event) => setRevealed((e as CustomEvent).detail)
    window.addEventListener('admin:reveal-password', handler)
    return () => window.removeEventListener('admin:reveal-password', handler)
  }, [])

  const act = async (tenantId: string, action: string) => {
    try {
      await patchJson(`/api/admin/tenants/${tenantId}`, { action })
      toast.success('Done')
      mutate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed')
    }
  }

  const resetPassword = async (tenant: AdminTenantRow) => {
    if (!tenant.ownerUserId || !tenant.ownerEmail) return
    try {
      const result = await postJson<{ tempPassword: string }>(
        `/api/admin/users/${tenant.ownerUserId}/reset-password`,
        {}
      )
      setRevealed({ email: tenant.ownerEmail, password: result.tempPassword })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not reset password')
    }
  }

  const tenants = data?.tenants ?? []

  return (
    <div className="space-y-3">
      {revealed && (
        <RevealedPassword email={revealed.email} password={revealed.password} onDismiss={() => setRevealed(null)} />
      )}

      <Panel>
        <PanelHeader title="Tenants" action={<CreateTenantForm onCreated={() => mutate()} />} />

        {isLoading && <p className="px-4 py-6 text-sm text-[var(--color-ink-subtle)]">Loading…</p>}

        {!isLoading && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-[10px] uppercase text-[var(--color-ink-subtle)]">
                  <th className="px-3 py-2">Tenant</th>
                  <th className="px-3 py-2">Storage</th>
                  <th className="px-3 py-2">Queue</th>
                  <th className="px-3 py-2">Jobs/hr</th>
                  <th className="px-3 py-2">Wait p50/p95</th>
                  <th className="px-3 py-2">AI Extend</th>
                  <th className="px-3 py-2">Weight</th>
                  <th className="px-3 py-2">Last activity</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {tenants.map(tenant => (
                  <React.Fragment key={tenant.id}>
                    <tr className="border-b border-[var(--color-border)]">
                      <td className="px-3 py-2">
                        <p className="font-medium text-[var(--color-ink)]">{tenant.name}</p>
                        <p className="text-[10px] text-[var(--color-ink-subtle)]">{tenant.ownerEmail ?? '—'}</p>
                        <Badge
                          tone={
                            tenant.status === 'active'
                              ? 'positive'
                              : tenant.status === 'suspended'
                                ? 'danger'
                                : 'warning'
                          }
                        >
                          {tenant.status}
                        </Badge>
                      </td>
                      <td className="numeric px-3 py-2">
                        {formatBytes(tenant.storageUsedBytes)} / {formatBytes(tenant.storageQuotaBytes)}
                      </td>
                      <td className="numeric px-3 py-2">
                        {tenant.queuedJobs} queued · {tenant.runningJobs} running
                      </td>
                      <td className="numeric px-3 py-2">{tenant.jobsPerHour24h}</td>
                      <td className="numeric px-3 py-2">
                        {tenant.queueWaitP50Ms}ms / {tenant.queueWaitP95Ms}ms
                      </td>
                      <td className="numeric px-3 py-2">
                        {tenant.aiExtendCallsThisMonth} / {tenant.aiExtendQuota}
                      </td>
                      <td className="numeric px-3 py-2">{tenant.weight}</td>
                      <td className="px-3 py-2 text-[var(--color-ink-subtle)]">
                        {tenant.lastActivityAt ? timeAgo(tenant.lastActivityAt) : 'never'}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {tenant.status === 'active' && (
                            <Button size="sm" variant="outline" onClick={() => act(tenant.id, 'suspend')}>
                              Suspend
                            </Button>
                          )}
                          {tenant.status === 'suspended' && (
                            <Button size="sm" variant="outline" onClick={() => act(tenant.id, 'resume')}>
                              Resume
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditingQuotasFor(editingQuotasFor === tenant.id ? null : tenant.id)}
                          >
                            Quotas
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => resetPassword(tenant)}>
                            Reset password
                          </Button>
                          {tenant.status !== 'pending_deletion' ? (
                            <Button size="sm" variant="ghost" onClick={() => act(tenant.id, 'mark_pending_deletion')}>
                              Delete…
                            </Button>
                          ) : (
                            <>
                              <Button size="sm" variant="ghost" onClick={() => act(tenant.id, 'cancel_pending_deletion')}>
                                Cancel delete
                              </Button>
                              <Button
                                size="sm"
                                variant="danger"
                                onClick={() => setPurgingFor(purgingFor === tenant.id ? null : tenant.id)}
                              >
                                Purge…
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                    {editingQuotasFor === tenant.id && (
                      <QuotaEditor
                        tenant={tenant}
                        onSaved={() => {
                          setEditingQuotasFor(null)
                          mutate()
                        }}
                      />
                    )}
                    {purgingFor === tenant.id && (
                      <PurgeConfirm
                        tenant={tenant}
                        onDone={() => {
                          setPurgingFor(null)
                          mutate()
                        }}
                      />
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
            {tenants.length === 0 && (
              <p className="px-4 py-6 text-sm text-[var(--color-ink-subtle)]">No tenants yet.</p>
            )}
          </div>
        )}
      </Panel>
    </div>
  )
}
