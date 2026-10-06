import type { Metadata } from 'next'
import './globals.css'
import { Toaster } from 'sonner'

export const metadata: Metadata = {
  title: 'Vision Studio',
  description: 'High-accuracy fashion product image processing.',
}

/**
 * Deliberately minimal — just `<html>`/`<body>` and the toaster. The sidebar
 * shell used to live here, which meant /login (added for multi-tenancy)
 * would have rendered inside the full app chrome, nav links and all, for a
 * page that exists specifically to run before any of that is reachable. The
 * sidebar now lives in `src/app/(app)/layout.tsx`, applying to every
 * authenticated page but not to /login, which sits outside that route
 * group.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        {children}
        <Toaster
          theme="dark"
          position="bottom-right"
          toastOptions={{
            style: {
              background: 'var(--color-surface-raised)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-ink)',
            },
          }}
        />
      </body>
    </html>
  )
}
