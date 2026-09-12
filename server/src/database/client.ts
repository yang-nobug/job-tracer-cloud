import { drizzle } from 'drizzle-orm/postgres-js'
import postgres, { type Sql } from 'postgres'
import { getPostgresConfig, requirePostgresConfig } from './config.js'
import * as schema from './schema.js'

let sqlClient: Sql | undefined

/** PostgreSQL 客户端按需创建，避免迁移期间影响尚未改造的 SQLite 路由。 */
export function getPostgresSql(): Sql {
  if (sqlClient) return sqlClient
  const config = requirePostgresConfig()
  sqlClient = postgres(config.url, {
    max: config.maxConnections,
    idle_timeout: config.idleTimeoutSeconds,
    connect_timeout: config.connectTimeoutSeconds,
    ssl: config.ssl ? 'require' : false,
    onnotice: notice => console.warn('[postgres] notice:', notice.message)
  })
  return sqlClient
}

export function getPostgresDb() {
  return drizzle(getPostgresSql(), { schema })
}

export async function closePostgres(): Promise<void> {
  const client = sqlClient
  sqlClient = undefined
  if (client) await client.end({ timeout: 5 })
}

export type DatabaseHealth =
  | { status: 'not_configured' }
  | { status: 'ready'; latencyMs: number }
  | { status: 'failed'; errorCode: 'CONNECTION_FAILED' | 'INVALID_CONFIGURATION' }

/** 不泄漏数据库地址、用户名或底层错误，仅提供部署探活所需状态。 */
export async function checkPostgresHealth(): Promise<DatabaseHealth> {
  try {
    if (!getPostgresConfig()) return { status: 'not_configured' }
    const startedAt = Date.now()
    await getPostgresSql().unsafe('SELECT 1')
    return { status: 'ready', latencyMs: Date.now() - startedAt }
  } catch (error) {
    const errorCode = error instanceof Error && error.name === 'DatabaseConfigurationError'
      ? 'INVALID_CONFIGURATION'
      : 'CONNECTION_FAILED'
    return { status: 'failed', errorCode }
  }
}
