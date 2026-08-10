/**
 * CLI: apply the schema.
 *
 *   npm run db:migrate          apply baseline + pending migrations
 *   npm run db:reset            drop all tables, then re-apply
 */

import fs from 'fs'
import { config } from '../src/config'
import { getDb, closeDb } from '../src/db/client'
import { migrate, dropAll } from '../src/db/migrate'

function main() {
  const reset = process.argv.includes('--reset')

  // Ensure every media root exists so the first upload does not race on mkdir.
  for (const dir of [
    config.paths.dataDir,
    config.paths.originals,
    config.paths.derived,
    config.paths.creatives,
    config.paths.assets,
  ]) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const db = getDb()

  if (reset) {
    console.log('  dropping all tables (media on disk is preserved)')
    dropAll(db)
  }

  const result = migrate(db)

  console.log(`  database   ${config.paths.database}`)
  console.log(`  baseline   applied`)
  if (result.applied.length) console.log(`  migrations ${result.applied.join(', ')}`)
  if (result.skipped.length) console.log(`  up to date ${result.skipped.length} previously applied`)

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[]
  console.log(`  tables     ${tables.map(t => t.name).join(', ')}`)

  closeDb()
  console.log('\n✓ schema ready')
}

main()
