import { bootstrapPlatformAdmin } from './auth/auth-service.js'
import { closePostgres } from './database/client.js'

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(name + ' 未配置')
  return value
}

async function main(): Promise<void> {
  try {
    const admin = await bootstrapPlatformAdmin({
      email: required('BOOTSTRAP_ADMIN_EMAIL'),
      displayName: required('BOOTSTRAP_ADMIN_DISPLAY_NAME'),
      password: required('BOOTSTRAP_ADMIN_PASSWORD')
    })
    console.log('[auth] platform admin ready:', admin.email)
  } finally {
    await closePostgres()
  }
}

main().catch(error => {
  console.error('[auth] bootstrap failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
