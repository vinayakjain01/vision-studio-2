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
