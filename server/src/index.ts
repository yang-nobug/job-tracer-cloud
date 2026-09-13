import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { applicationsRouter } from './routes/applications.js'
import { eventsRouter } from './routes/events.js'
import { interviewsRouter } from './routes/interviews.js'
import { resumesRouter } from './routes/resumes.js'
import { recoverInterruptedCloudResumeExtractions } from './cloud-resume-text.js'
import { statsRouter } from './routes/stats.js'
import { cloudKnowledgeRouter } from './routes/cloud-knowledge.js'
import { cloudKnowledgeAiRouter } from './routes/cloud-knowledge-ai.js'
import { cloudAiRouter } from './routes/cloud-ai.js'
import { cloudApplicationImportsRouter } from './routes/cloud-application-imports.js'
import { localDataImportRouter } from './routes/local-data-import.js'
import { cloudMailRouter, startCloudMailAutomationScheduler, stopCloudMailAutomationScheduler } from './routes/cloud-mail.js'
import { cloudPrepAgentRouter } from './routes/cloud-prep-agent.js'
import { cloudPrepTasksRouter } from './routes/cloud-prep-tasks.js'
import { cloudReviewsRouter } from './routes/cloud-reviews.js'
import { cloudRecordingsRouter, recoverInterruptedCloudRecordings } from './routes/cloud-recordings.js'
import { cloudTutorRouter } from './routes/cloud-tutor.js'
import { cloudProjectsRouter } from './routes/cloud-projects.js'
import { cloudCodeReadingRouter, recoverInterruptedCloudCodeReadingSessions } from './routes/cloud-code-reading.js'
import { cloudAiAuditRouter } from './routes/cloud-ai-audit.js'
import { cloudAiSettingsRouter } from './routes/cloud-ai-settings.js'
import { cloudObservabilityRouter } from './routes/cloud-observability.js'
import { sharedJobsRouter } from './routes/shared-jobs.js'
import { refreshPlatformAiSettings } from './platform-ai-settings.js'
import {
  configurePrepAgentRuntime, recoverPrepAgentRuntimeRun, stopPrepAgentService
} from './prep-agent-runtime.js'
import { recoverableCloudPrepRuns } from './cloud-prep-agent-service.js'
import { logApp, newTraceId, runWithTrace, validTraceId } from './observability.js'
import { healthRouter } from './routes/health.js'
import { authRouter } from './routes/auth.js'
import { adminRouter } from './routes/admin.js'
import { requireAuth, requireSameOrigin } from './auth/guards.js'
import { assertSecureSessionConfiguration } from './auth/session.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const configuredPort = Number(process.env.PORT)
const PORT = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535 ? configuredPort : 3210
assertSecureSessionConfiguration()
configurePrepAgentRuntime(PORT)

const app = express()
// Node 仅监听本机，由单层 Nginx 反向代理提供公网访问。
app.set('trust proxy', 1)
void recoverInterruptedCloudRecordings().then(count => {
  if (count) console.log(`[cloud-recordings] 已标记 ${count} 个中断任务，可在页面点击重试`)
}).catch(error => console.warn('[cloud-recordings] 恢复中断任务失败:', (error as Error).message))
void recoverInterruptedCloudCodeReadingSessions().then(count => {
  if (count) console.log(`[cloud-code-reading] 已标记 ${count} 个中断调查，可在页面点击重试`)
}).catch(error => console.warn('[cloud-code-reading] 恢复中断任务失败:', (error as Error).message))
app.use(express.json({ limit: '2mb' }))
app.use('/api', healthRouter)
app.use('/api/auth', authRouter)
app.use('/api/admin', adminRouter)

// 每个 HTTP 请求都有可回查的链路编号；内部 Python Agent 会透传该 header。
app.use((req, res, next) => {
  const traceId = validTraceId(req.get('x-trace-id')) ?? newTraceId('req')
  const started = Date.now()
  res.setHeader('X-Trace-Id', traceId)
  res.on('finish', () => {
    if (req.path.startsWith('/api/observability')) return
    logApp({
      level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      source: 'api', eventName: 'api.request_completed', traceId,
      message: `${req.method} ${req.path} -> ${res.statusCode}`,
      errorCode: res.statusCode >= 400 ? `HTTP_${res.statusCode}` : undefined,
      context: { method: req.method, path: req.path, status_code: res.statusCode, duration_ms: Date.now() - started }
    })
  })
  runWithTrace({ traceId }, next)
})

// Python 面试准备 Agent 只能从本机以内部令牌调用这两个路径；它没有浏览器 Cookie。
// 实际路由仍会校验 loopback 地址和令牌，其他 API 一律要求登录。
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/internal/prep-agent/') || req.path.startsWith('/internal/code-reading/')) return next()
  void requireAuth(req, res, next)
})
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return requireSameOrigin(req, res, next)
  next()
})
app.use('/api', statsRouter)
app.use('/api', cloudReviewsRouter)
app.use('/api', cloudRecordingsRouter)
app.use('/api', cloudTutorRouter)
app.use('/api', cloudProjectsRouter)
app.use('/api', cloudCodeReadingRouter)
app.use('/api', interviewsRouter)
app.use('/api', eventsRouter)
app.use('/api/applications', applicationsRouter)
app.use('/api/resumes', resumesRouter)
// 面经、题目和截图已迁入工作区 PostgreSQL；AI 拆题/答案生成也不会落到共享 SQLite。
app.use('/api/knowledge', cloudKnowledgeRouter)
app.use('/api', cloudKnowledgeAiRouter)
app.use('/api', cloudAiRouter)
// AI 开关与助教默认模型使用平台 PostgreSQL 配置，不再落入旧 SQLite。
app.use('/api', cloudAiSettingsRouter)
// AI 调用记录保存于工作区 PostgreSQL，优先于旧 SQLite 的同路径接口。
app.use('/api', cloudAiAuditRouter)
app.use('/api', cloudObservabilityRouter)
app.use('/api', sharedJobsRouter)
app.use('/api/application-imports', cloudApplicationImportsRouter)
app.use('/api/local-data-import', localDataImportRouter)
app.use('/api', cloudMailRouter)
// 面试准备计划及其任务执行均按工作区存入 PostgreSQL。
app.use('/api', cloudPrepAgentRouter)
app.use('/api', cloudPrepTasksRouter)

// 先恢复平台级 AI 配置，再开始接收请求，避免重启瞬间回退到 config.json 默认值。
try {
  await refreshPlatformAiSettings()
} catch (error) {
  console.warn('[platform-ai-settings] 加载失败，将暂用 config.json 默认值:', (error as Error).message)
}

// 统一错误处理（422/500 -> JSON）
app.use((err: Error & { status?: number }, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = Number.isInteger(err.status) && err.status! >= 400 && err.status! < 600 ? err.status! : 500
  if (status >= 500) console.error(err)
  logApp({ level: status >= 500 ? 'error' : 'warn', source: 'api', eventName: 'api.unhandled_error', message: err.message || '服务器错误',
    traceId: validTraceId(req.get('x-trace-id')) ?? undefined, errorCode: 'UNHANDLED_ERROR', errorStack: err.stack,
    context: { method: req.method, path: req.path } })
  res.status(status).json({ message: err.message || '服务器错误' })
})

// 托管前端构建产物（npm run build 后存在）
const publicDir = path.resolve(__dirname, '../public')
if (existsSync(publicDir)) {
  app.use(express.static(publicDir))
  // 前端路由回退
  app.get(/^\/(?!api).*/, (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'))
  })
}

// 仅允许本机浏览器访问，不向局域网开放。
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`job-tracer 已启动: http://localhost:${PORT}`)
  void recoverInterruptedCloudResumeExtractions().then(count => {
    if (count) console.log(`[resumes] 已标记 ${count} 个中断的简历提取，可在简历选择器中重试`)
  }).catch(error => console.warn('[resumes] 恢复中断提取状态失败:', (error as Error).message))
  startCloudMailAutomationScheduler()
  void recoverableCloudPrepRuns().then(runs => {
    if (runs.length) console.log(`[prep-agent] 正在恢复 ${runs.length} 个云端中断运行`)
    for (const run of runs) recoverPrepAgentRuntimeRun(run.id).catch(error => {
      console.error(`[prep-agent] 恢复云端运行 ${run.id} 失败:`, (error as Error).message)
    })
  }).catch(error => console.warn('[prep-agent] 查询云端恢复任务失败:', (error as Error).message))
})

function shutdown(): void {
  stopCloudMailAutomationScheduler()
  stopPrepAgentService()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500).unref()
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
