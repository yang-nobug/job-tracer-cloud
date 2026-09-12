import { checkPostgresHealth, closePostgres } from './client.js'

async function main(): Promise<void> {
  try {
    const health = await checkPostgresHealth()
    if (health.status !== 'ready') {
      console.error('[database] unavailable:', health.status === 'failed' ? health.errorCode : 'DATABASE_URL_NOT_CONFIGURED')
      process.exitCode = 1
      return
    }
    console.log('[database] ready in ' + String(health.latencyMs) + 'ms')
  } finally {
    await closePostgres()
  }
}

main().catch(error => {
  console.error('[database] health check failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
