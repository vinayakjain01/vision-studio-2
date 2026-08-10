/**
 * Client-safe media URL builder.
 *
 * `storage/media-store.ts` also exposes `mediaUrl`, but that module imports
 * `fs` and `@/config`, so it cannot be pulled into a client component. This is
 * the same URL shape with no server dependencies.
 */

export type MediaRootName = 'originals' | 'derived' | 'creatives' | 'assets'

export function mediaUrlFor(root: MediaRootName, key: string): string {
  const encoded = key.split('/').map(encodeURIComponent).join('/')
  return `/api/media/${root}/${encoded}`
}
