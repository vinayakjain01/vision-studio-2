'use client'

import * as React from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { Loader2, LogIn } from 'lucide-react'
import { Button, Field, Input, Panel } from '@/components/ui/primitives'

export default function LoginPage() {
  // `useSearchParams()` opts this page out of static rendering unless it's
  // inside a Suspense boundary — wrapped here rather than relying on this
  // route never being prerendered.
  return (
    <React.Suspense fallback={null}>
      <LoginForm />
    </React.Suspense>
  )
}

function LoginForm() {
  const router = useRouter()
  const params = useSearchParams()
  const next = params.get('next') || '/'

  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        // Deliberately the same message for "no such account" and "wrong
        // password" — see src/auth/login.ts for why.
        toast.error(body?.error ?? 'Incorrect email or password')
        return
      }
      router.push(next)
      router.refresh()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-canvas)] px-4">
      <div className="w-full max-w-sm space-y-5">
        <div className="flex items-center justify-center gap-2">
          <img src="/icon.svg" alt="" className="h-7 w-7" />
          <span className="text-base font-semibold">Vision Studio</span>
        </div>

        <Panel>
          <form onSubmit={submit} className="space-y-4 p-5">
            <Field label="Email" htmlFor="email">
              <Input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                disabled={submitting}
              />
            </Field>
            <Field label="Password" htmlFor="password">
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={e => setPassword(e.target.value)}
                disabled={submitting}
              />
            </Field>
            <Button type="submit" variant="primary" className="w-full" disabled={submitting}>
              {submitting ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
              {submitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </Panel>

        <p className="text-center text-[11px] text-[var(--color-ink-subtle)]">
          No open sign-up — an administrator creates accounts.
        </p>
      </div>
    </div>
  )
}
