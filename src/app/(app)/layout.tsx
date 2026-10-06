import { AppNav } from '@/components/shell/sidebar-nav'

/**
 * The authenticated app shell (sidebar + main content). Everything under
 * this route group requires a session — enforced by middleware and, for the
 * handful of pages that read data server-side, by `withTenant()` in each
 * page itself (see `src/tenancy/page-context.ts`). `/login` sits OUTSIDE
 * this group deliberately, so it renders without this chrome.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <AppNav />
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  )
}
