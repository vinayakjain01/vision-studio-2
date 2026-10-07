/**
 * Lockout-recovery CLI: create a tenant + its first (owner) user, the same
 * way the admin UI's "create tenant" action does — same quota defaults,
 * same generated one-time temp password, same forced-change-at-next-login,
 * same audit log entry. For when the admin UI itself is unreachable (the
 * web process is down, or every admin account is locked out) but the
 * machine running this script still has access to the data directory.
 *
 *   npm run admin:create-tenant -- --name "Acme Co" --email owner@acme.test
 *
 * Operates on the REAL data directory (`VISION_STUDIO_DATA_DIR`, same as
 * any other npm script) — this is a production recovery tool, not a test
 * fixture. The temp password is printed to this terminal ONCE and never
 * written anywhere else (not logged, not persisted) — see
 * `generateTempPassword`'s doc comment.
 */

export {} // no top-level imports otherwise — without this, TS treats the file as a global script and its `main`/`parseArgs` collide with admin-reset-password.ts's own.

function parseArgs(argv: string[]): { name?: string; email?: string } {
  const out: { name?: string; email?: string } = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--name') out.name = argv[++i]
    else if (argv[i] === '--email') out.email = argv[++i]
  }
  return out
}

async function main() {
  const { name, email } = parseArgs(process.argv.slice(2))
  if (!name || !email) {
    console.error('Usage: npm run admin:create-tenant -- --name "Tenant Name" --email owner@example.com')
    process.exit(1)
  }

  const { migrateControl } = await import('../src/db/migrate')
  const { getControlDb, closeDb } = await import('../src/db/client')
  const { createTenantAndFirstUser, AdminActionError } = await import('../src/services/admin-service')

  migrateControl(getControlDb())

  try {
    const result = await createTenantAndFirstUser({ tenantName: name, email }, { userId: null })
    console.log('\nTenant created.')
    console.log(`  tenant id      ${result.tenantId}`)
    console.log(`  user id        ${result.userId}`)
    console.log(`  email          ${email}`)
    console.log(`  temp password  ${result.tempPassword}`)
    console.log('\nThis password is shown ONCE and was never logged. The account must change it at first login.')
  } catch (err) {
    if (err instanceof AdminActionError) {
      console.error(`\nCould not create tenant: ${err.message}`)
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
