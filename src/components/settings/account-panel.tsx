'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { KeyRound, Mail } from 'lucide-react'
import { postJson } from '@/lib/api'
import { Alert, Button, Input, Panel, PanelHeader } from '@/components/ui/primitives'

/**
 * Identity + self-service password change. Deliberately separate from
 * `SettingsClient` (engine/model/queue status) — this is about the signed-in
 * PERSON, not the app's backend health, and keeping them in one component
 * would mix two unrelated concerns that happen to share a page.
 */
export function AccountPanel({ userEmail }: { userEmail: string }) {
  const [currentPassword, setCurrentPassword] = React.useState('')
  const [newPassword, setNewPassword] = React.useState('')
  const [confirmPassword, setConfirmPassword] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (newPassword !== confirmPassword) {
      toast.error('New password and confirmation do not match')
      return
    }
    if (newPassword.length < 8) {
      toast.error('New password must be at least 8 characters')
      return
    }

    setBusy(true)
    try {
      await postJson('/api/auth/change-password', { currentPassword, newPassword })
      toast.success('Password changed. Every other signed-in session was logged out.')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not change password')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel>
      <PanelHeader title="Account" description="Your identity and sign-in credentials for this workspace." />
      <div className="space-y-4 px-4 py-4">
        <div className="flex items-center gap-2 text-sm text-[var(--color-ink-muted)]">
          <Mail size={14} />
          {userEmail}
        </div>

        <form onSubmit={submit} className="space-y-3 border-t border-[var(--color-border)] pt-4">
          <p className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-ink-subtle)]">
            <KeyRound size={13} /> Change password
          </p>
          <Input
            type="password"
            placeholder="Current password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={e => setCurrentPassword(e.target.value)}
            required
          />
          <Input
            type="password"
            placeholder="New password (min. 8 characters)"
            autoComplete="new-password"
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            required
            minLength={8}
          />
          <Input
            type="password"
            placeholder="Confirm new password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            required
            minLength={8}
          />
          <Alert tone="neutral">
            Changing your password signs out every OTHER session for this account — not this one.
          </Alert>
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? 'Changing…' : 'Change password'}
          </Button>
        </form>
      </div>
    </Panel>
  )
}
