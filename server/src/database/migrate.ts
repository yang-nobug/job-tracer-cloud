import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { closePostgres, getPostgresDb } from './client.js'
import { requirePostgresConfig } from './config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const migrationsFolder = path.join(__dirname, 'migrations')

async function main(): Promise<void> {
  requirePostgresConfig()
  try {
    await migrate(getPostgresDb(), { migrationsFolder })
    console.log('[database] migrations applied')
  } finally {
    await closePostgres()
  }
}

main().catch(error => {
  console.error('[database] migration failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
