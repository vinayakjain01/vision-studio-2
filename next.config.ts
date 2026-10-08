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
    /**
     * P6 load-test finding: `middleware.ts`'s matcher covers every `/api/*`
     * route (by design — it's the first-line session/auth check), and since
     * Next.js 15, any route under an active middleware matcher has its
     * request body transparently buffered by the middleware/proxy layer so
     * both middleware and the route handler can read it — capped at 10MB by
     * default. Past that cap Next does NOT reject the request; it silently
     * truncates the stream and logs a warning, which `files/route.ts`'s
     * busboy parser then sees as a corrupt multipart body ("Unexpected end
     * of form") with no indication the real cause was an invisible proxy-
     * layer limit rather than anything in that route's own code. This
     * applies regardless of busboy's own streaming design (see that route's
     * module doc) — the truncation happens before the handler, and
     * `serverActions.bodySizeLimit` above does NOT cover it (that setting
     * is Server-Actions-only). Sized to match `serverActions.bodySizeLimit`
     * for the same worst-case: a large bulk upload.
     */
    proxyClientMaxBodySize: '64mb',
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
          // No camera/mic/geolocation/etc — this app uses none of them.
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
          // Only meaningful once actually served over HTTPS (Caddy, per
          // docs/DEPLOY.md) — harmless to send over plain HTTP in dev, since
          // browsers ignore Strict-Transport-Security on an insecure origin.
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              // Next's dev server (Fast Refresh/HMR) needs 'unsafe-eval';
              // production never does — no inline <script> tags anywhere in
              // this app, and none should ever be added.
              `script-src 'self'${isDev ? " 'unsafe-eval'" : ''}`,
              // React's `style={{...}}` prop (used by a handful of
              // components — the template canvas, mainly) renders as an
              // inline `style` attribute, which needs 'unsafe-inline' here
              // specifically. Inline STYLE injection is a far smaller
              // attack surface than inline SCRIPT, which stays disallowed
              // above.
              "style-src 'self' 'unsafe-inline'",
              // Media is served from this app's own /api/media/* route
              // (content-addressed, see media-store.ts) — never a remote
              // origin. `data:` for the handful of inline SVG/data-URI
              // icons.
              "img-src 'self' data:",
              "font-src 'self'",
              "connect-src 'self'",
              "object-src 'none'",
              "base-uri 'self'",
              "frame-ancestors 'self'",
            ].join('; '),
          },
        ],
      },
    ]
  },
}

export default nextConfig
