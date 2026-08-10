'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Aperture,
  FolderUp,
  Images,
  LayoutTemplate,
  Route,
  Sparkles,
  Wand2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { EngineStatusPill } from './engine-status'

/**
 * Grouped into the two things a user is ever doing: getting photos in, and
 * getting creatives out. A flat list of seven items reads as "seven features to
 * learn"; two short groups read as a workflow with an obvious starting point.
 */
const GROUPS: {
  label: string
  links: { href: string; label: string; icon: typeof Aperture; exact?: boolean }[]
}[] = [
  {
    label: 'Photos',
    links: [
      { href: '/', label: 'Overview', icon: Aperture, exact: true },
      { href: '/import', label: 'Import', icon: FolderUp },
      { href: '/products', label: 'Products', icon: Images },
    ],
  },
  {
    label: 'Creatives',
    links: [
      { href: '/templates', label: 'Templates', icon: LayoutTemplate },
      { href: '/rules', label: 'Rules', icon: Route },
      { href: '/generate', label: 'Generate', icon: Wand2 },
      { href: '/creatives', label: 'Downloads', icon: Sparkles },
    ],
  },
]

export function AppNav() {
  const pathname = usePathname()

  return (
    <nav className="sticky top-0 flex h-screen w-52 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="px-4 py-5">
        <Link href="/" className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-[var(--color-accent)] text-[var(--color-accent-ink)]">
            <Aperture size={16} strokeWidth={2.5} />
          </span>
          <span className="text-sm font-semibold tracking-tight">Vision Studio</span>
        </Link>
      </div>

      <div className="flex-1 space-y-5 px-2">
        {GROUPS.map(group => (
          <div key={group.label}>
            <p className="mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-ink-subtle)]">
              {group.label}
            </p>
            <ul className="space-y-0.5">
              {group.links.map(link => {
                const active = link.exact
                  ? pathname === link.href
                  : pathname === link.href || pathname.startsWith(`${link.href}/`)
                const Icon = link.icon

                return (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className={cn(
                        'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] transition-colors',
                        active
                          ? 'bg-[var(--color-surface-raised)] font-medium text-[var(--color-ink)]'
                          : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)]'
                      )}
                    >
                      <Icon size={15} strokeWidth={active ? 2.2 : 1.8} />
                      {link.label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>

      <div className="border-t border-[var(--color-border)] p-3">
        <EngineStatusPill />
      </div>
    </nav>
  )
}
