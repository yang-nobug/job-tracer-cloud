import { Router } from 'express'
import { checkPostgresHealth } from '../database/client.js'

export const healthRouter = Router()

/** 公网探活端点：不返回版本、密钥、路径或数据库连接细节。 */
healthRouter.get('/health', async (_req, res) => {
  const database = await checkPostgresHealth()
  const status = database.status === 'ready'
    ? 'ok'
    : database.status === 'not_configured'
      ? 'pending_database'
      : 'degraded'
  res.status(database.status === 'failed' ? 503 : 200).json({
    status,
    database,
    timestamp: new Date().toISOString()
  })
})
