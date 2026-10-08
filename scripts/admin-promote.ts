/**
 * Grant platform-admin access to an account — the gap left by
 * `scripts/tenants-migrate-legacy.ts`, which only ever makes ONE admin (the
 * very first account, at bootstrap time, tied to `ADMIN_EMAIL`). This is for
 * every case after that: promoting an existing tenant user to admin, or
 * creating a brand new admin account on an install that already has tenants
 * (where the migration script's own bootstrap path is a no-op).
 *
 *   npm run admin:promote -- --email someone@example.com [--password "..."]
 *
 * If the email already has an account, it's promoted in place (password
 * untouched unless --password is given). If not, a new platform-admin user
 * is created — NOT tied to any tenant, since an admin doesn't need one —
 * with the given password, or a generated one-time temp password (forced
 * change at next login) if --password is omitted.
 *
 * Operates on the REAL data directory, same as any other npm script.
 */

export {} // no top-level imports otherwise — see the other admin-*.ts scripts' identical note on why this line is needed.

function parseArgs(argv: string[]): { email?: string; password?: string } {
  const out: { email?: string; password?: string } = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--email') out.email = argv[++i]
    else if (argv[i] === '--password') out.password = argv[++i]
  }
  return out
}

async function main() {
  const { email, password } = parseArgs(process.argv.slice(2))
  if (!email) {
    console.error('Usage: npm run admin:promote -- --email someone@example.com [--password "..."]')
    process.exit(1)
  }

  const { migrateControl } = await import('../src/db/migrate')
  const { getControlDb, closeDb } = await import('../src/db/client')
  const { users, auditLog } = await import('../src/db/control-repositories')
  const { hashPassword, generateTempPassword } = await import('../src/auth/password')

  migrateControl(getControlDb())

  const existing = users.findByEmail(email)

  if (existing) {
    users.setPlatformAdmin(existing.id, true)
    if (password) {
      users.setPasswordHash(existing.id, await hashPassword(password), false)
    }
    auditLog.record({ actorUserId: null, tenantId: null, action: 'admin_promote_existing', detail: { email } })
    console.log(`\n${email} is now a platform admin.`)
    if (password) console.log('Its password was also updated to the one given.')
    else console.log('Its existing password is unchanged — log in with that.')
  } else {
    const generated = !password
    const effectivePassword = password ?? generateTempPassword()
    const hash = await hashPassword(effectivePassword)
    const user = users.create({ email, passwordHash: hash, isPlatformAdmin: true, mustChangePassword: generated })
    auditLog.record({ actorUserId: null, tenantId: null, action: 'admin_promote_new', detail: { email } })
    console.log(`\nCreated a new platform admin: ${email} (user id ${user.id})`)
    if (generated) {
      console.log(`  password  ${effectivePassword}`)
      console.log('\nThis password is shown ONCE and was never logged. It must change it at first login.')
    } else {
      console.log('Logged in with the password you supplied — not re-printed here since you already have it.')
    }
  }

  closeDb()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
