/**
 * Lockout-recovery CLI: reset a user's password, the same way the admin
 * UI's "reset password" action does — generated one-time temp password,
 * forced change at next login, every other session for that user revoked,
 * audit log entry. For when the admin UI is unreachable but this machine
 * still has access to the data directory — including the case where the
 * ONLY platform admin account is the one that's locked out.
 *
 *   npm run admin:reset-password -- --email someone@example.com
 *
 * Operates on the REAL data directory, same as any other npm script. The
 * temp password is printed to this terminal ONCE and never written
 * anywhere else — see `generateTempPassword`'s doc comment.
 */

export {} // no top-level imports otherwise — without this, TS treats the file as a global script and its `main`/`parseArgs` collide with admin-create-tenant.ts's own.

function parseArgs(argv: string[]): { email?: string } {
  const out: { email?: string } = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--email') out.email = argv[++i]
  }
  return out
}

async function main() {
  const { email } = parseArgs(process.argv.slice(2))
  if (!email) {
    console.error('Usage: npm run admin:reset-password -- --email someone@example.com')
    process.exit(1)
  }

  const { migrateControl } = await import('../src/db/migrate')
  const { getControlDb, closeDb } = await import('../src/db/client')
  const { users } = await import('../src/db/control-repositories')
  const { resetUserPassword, AdminActionError } = await import('../src/services/admin-service')

  migrateControl(getControlDb())

  const user = users.findByEmail(email)
  if (!user) {
    console.error(`\nNo user with email ${email}.`)
    closeDb()
    process.exit(1)
  }

  try {
    const result = await resetUserPassword(user.id, { userId: null })
    console.log('\nPassword reset.')
    console.log(`  email          ${email}`)
    console.log(`  temp password  ${result.tempPassword}`)
    console.log('\nThis password is shown ONCE and was never logged. Every other session for this')
    console.log('account was revoked, and it must change this password at next login.')
  } catch (err) {
    if (err instanceof AdminActionError) {
      console.error(`\nCould not reset password: ${err.message}`)
      process.exit(1)
    }
    throw err
  } finally {
    closeDb()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
