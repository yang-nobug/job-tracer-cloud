const DEFAULT_MAX_CONNECTIONS = 8
const DEFAULT_IDLE_TIMEOUT_SECONDS = 30
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 8

export interface PostgresConfig {
  url: string
  maxConnections: number
  idleTimeoutSeconds: number
  connectTimeoutSeconds: number
  ssl: boolean
}

export class DatabaseConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DatabaseConfigurationError'
  }
}

function readPositiveInteger(name: string, fallback: number, max: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new DatabaseConfigurationError(`${name} 必须是 1 到 ${max} 的整数`)
  }
  return parsed
}

/**
 * 数据库尚未配置时返回 null，使现有 SQLite 页面在迁移期间仍能运行。
 * 所有真正使用 PostgreSQL 的功能必须调用 requirePostgresConfig()。
 */
export function getPostgresConfig(): PostgresConfig | null {
  const url = process.env.DATABASE_URL?.trim()
  if (!url) return null

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new DatabaseConfigurationError('DATABASE_URL 不是有效的 PostgreSQL 连接地址')
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new DatabaseConfigurationError('DATABASE_URL 必须使用 postgres:// 或 postgresql:// 协议')
  }

  return {
    url,
    maxConnections: readPositiveInteger('DATABASE_MAX_CONNECTIONS', DEFAULT_MAX_CONNECTIONS, 20),
    idleTimeoutSeconds: readPositiveInteger('DATABASE_IDLE_TIMEOUT_SECONDS', DEFAULT_IDLE_TIMEOUT_SECONDS, 300),
    connectTimeoutSeconds: readPositiveInteger('DATABASE_CONNECT_TIMEOUT_SECONDS', DEFAULT_CONNECT_TIMEOUT_SECONDS, 60),
    ssl: process.env.DATABASE_SSL?.trim().toLowerCase() === 'true'
  }
}

export function requirePostgresConfig(): PostgresConfig {
  const config = getPostgresConfig()
  if (!config) {
    throw new DatabaseConfigurationError('DATABASE_URL 未配置；请在服务器环境文件中设置 PostgreSQL 连接地址')
  }
  return config
}
