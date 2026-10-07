/**
 * Password hashing — argon2id.
 *
 * Verified to install and run cleanly on this app's Docker base
 * (`node:20-slim`, glibc, with the node-gyp fallback toolchain already
 * present for other native deps — see `Dockerfile`), so the bcrypt
 * fallback the spec allows for isn't needed here.
 *
 * Server-only.
 */

import argon2 from 'argon2'
import crypto from 'crypto'

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id })
}

/**
 * Constant-time by construction — argon2's own `verify` does the comparison
 * internally rather than this code ever holding both values side by side to
 * diff itself.
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain)
  } catch {
    // A corrupt or foreign-format hash (e.g. hand-edited in the DB) must
    // fail closed as "wrong password", not throw past the login route.
    return false
  }
}

/**
 * One-time credential for admin-initiated account creation / password
 * reset (P5) — shown to the admin ONCE in the response body, never logged,
 * never persisted anywhere except as its argon2 hash. Readable-by-a-human
 * on purpose (a restricted alphabet with no visually-ambiguous characters:
 * no 0/O, 1/l/I), since an admin typically has to relay this to the account
 * holder over some out-of-band channel (phone, a support ticket).
 */
export function generateTempPassword(length = 16): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  const bytes = crypto.randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length]
  return out
}
