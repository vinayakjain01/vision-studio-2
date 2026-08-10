import type { Metadata } from 'next'
import './globals.css'
import { Toaster } from 'sonner'
import { AppNav } from '@/components/shell/sidebar-nav'

export const metadata: Metadata = {
  title: 'Vision Studio',
  description: 'High-accuracy fashion product image processing.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <div className="flex min-h-screen">
          <AppNav />
          <main className="min-w-0 flex-1">{children}</main>
        </div>
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
