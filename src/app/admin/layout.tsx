import { ShieldAlert } from 'lucide-react'

/**
 * Deliberately NOT the tenant app shell (`(app)/layout.tsx`'s sidebar) —
 * this is a platform-wide console, not scoped to any one tenant, and
 * showing the Photos/Creatives nav here would misleadingly imply it is.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--color-canvas)]">
      <header className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-3">
        <ShieldAlert size={16} className="text-[var(--color-accent)]" />
        <span className="text-sm font-semibold tracking-tight">Vision Studio — Admin</span>
      </header>
      <main className="mx-auto max-w-6xl px-5 py-6">{children}</main>
    </div>
  )
}
