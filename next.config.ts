import type { NextConfig } from 'next'

const isDev = process.env.NODE_ENV !== 'production'

const nextConfig: NextConfig = {
  // Native addons must not be bundled by webpack/turbopack — they are loaded
  // through Node's require at runtime from node_modules.
  serverExternalPackages: ['@napi-rs/canvas', 'onnxruntime-node', 'better-sqlite3', 'sharp'],

  compress: true,
  poweredByHeader: false,

  experimental: {
    serverActions: {
      // Folder upload streams originals through a server action / route handler.
      bodySizeLimit: '64mb',
    },
  },

  async headers() {
    return [
      {
        /**
         * Build assets.
         *
         * `immutable` is only safe in PRODUCTION, where Next emits
         * content-hashed filenames. In development Turbopack reuses chunk names
         * (`src_1jjd340._.js` and friends) across rebuilds — the name comes from
         * the module group, not the content — so an immutable, year-long
         * max-age tells the browser never to revalidate a URL whose bytes change
         * on every edit.
         *
         * The result is a browser that keeps executing stale JavaScript
         * indefinitely: newly-created chunks are fetched fresh while cached ones
         * are not, producing hydration mismatches and code that no longer exists
         * appearing in stack traces. Hard reload does not reliably clear it.
         */
        source: '/_next/static/(.*)',
        headers: [
          {
            key: 'Cache-Control',
            value: isDev
              ? 'no-store, must-revalidate'
              : 'public, max-age=31536000, immutable',
          },
        ],
      },
      {
        // Media is content-addressed by sha256 — the bytes at a given URL can
        // never change, so it is safe to cache immutably and forever.
        source: '/api/media/:hash/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        ],
      },
    ]
  },
}

export default nextConfig
