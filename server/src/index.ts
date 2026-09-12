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
import { knowledgeRouter } from './routes/knowledge.js'
import { knowledgeAiRouter } from './routes/knowledge-ai.js'
import { cloudKnowledgeRouter } from './routes/cloud-knowledge.js'
import { cloudKnowledgeAiRouter } from './routes/cloud-knowledge-ai.js'
import { cloudAiRouter } from './routes/cloud-ai.js'
import { cloudApplicationImportsRouter } from './routes/cloud-application-imports.js'
import { recoverInterruptedRecordings, recordingsRouter } from './routes/recordings.js'
import { tutorRouter } from './routes/tutor.js'
import { aiRouter } from './routes/ai.js'
import { applicationImportsRouter } from './routes/application-imports.js'
import { prepAgentRouter } from './routes/prep-agent.js'
import { prepTasksRouter } from './routes/prep-tasks.js'
import { mailRouter, recoverInterruptedMailAnalyses } from './routes/mail.js'
import {
  configureMailAutomation, mailAutomationRouter, startMailAutomationScheduler, stopMailAutomationScheduler
} from './mail-automation.js'
import {
  configurePrepAgentRuntime, recoverPrepAgentRuntimeRun, stopPrepAgentService
} from './prep-agent-runtime.js'
import { recoverablePrepAgentRuns } from './prep-agent-service.js'
import { observabilityRouter } from './routes/observability.js'
import { projectsRouter } from './routes/projects.js'
import { codeReadingRouter } from './routes/code-reading.js'
import { recoverInterruptedCodeReadingSessions } from './code-reading-agent.js'
import { logApp, newTraceId, runWithTrace, validTraceId } from './observability.js'
import { feishuRouter } from './routes/feishu.js'
import { healthRouter } from './routes/health.js'
import { authRouter } from './routes/auth.js'
import { adminRouter } from './routes/admin.js'
import { requireAuth, requireLegacyDataAccess, requireSameOrigin } from './auth/guards.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const configuredPort = Number(process.env.PORT)
const PORT = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535 ? configuredPort : 3210
configurePrepAgentRuntime(PORT)
configureMailAutomation(PORT)

const app = express()
// Node 仅监听本机，由单层 Nginx 反向代理提供公网访问。
app.set('trust proxy', 1)
const recoveredRecordings = recoverInterruptedRecordings()
if (recoveredRecordings) console.log(`[recordings] 已恢复 ${recoveredRecordings} 个中断任务，可在页面点击重试`)
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

// 已迁入 PostgreSQL 的核心投递数据可供所有已批准用户使用。
app.use('/api', requireAuth)
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return requireSameOrigin(req, res, next)
  next()
})
app.use('/api', statsRouter)
app.use('/api', interviewsRouter)
app.use('/api', eventsRouter)
app.use('/api/applications', applicationsRouter)
app.use('/api/resumes', resumesRouter)
// 面经、题目和截图已迁入工作区 PostgreSQL；AI 拆题/答案生成也不会落到共享 SQLite。
app.use('/api/knowledge', cloudKnowledgeRouter)
app.use('/api', cloudKnowledgeAiRouter)
app.use('/api', cloudAiRouter)
app.use('/api/application-imports', cloudApplicationImportsRouter)

// 其余模块仍使用共享 SQLite 数据，继续限制为管理员，直到逐项迁移完成。
app.use('/api', requireLegacyDataAccess)
app.use('/api', aiRouter)
app.use('/api', observabilityRouter)
app.use('/api/feishu', feishuRouter)
app.use('/api', projectsRouter)
app.use('/api', codeReadingRouter)
app.use('/api/application-imports', applicationImportsRouter)
app.use('/api/knowledge', knowledgeRouter)
app.use('/api', knowledgeAiRouter)
app.use('/api/recordings', recordingsRouter)
app.use('/api/tutor', tutorRouter)
app.use('/api', prepAgentRouter)
app.use('/api', prepTasksRouter)
app.use('/api', mailRouter)
app.use('/api', mailAutomationRouter)

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
  recoverInterruptedMailAnalyses()
  const interruptedCodeSessions = recoverInterruptedCodeReadingSessions()
  if (interruptedCodeSessions) console.log(`[code-reading] 已标记 ${interruptedCodeSessions} 个中断调查，可在项目档案中点击重试`)
  startMailAutomationScheduler()
  const recoverable = recoverablePrepAgentRuns()
  if (recoverable.length) {
    console.log(`[prep-agent] 正在恢复 ${recoverable.length} 个中断运行`)
    for (const run of recoverable) {
      recoverPrepAgentRuntimeRun(run.id).catch(error => {
        console.error(`[prep-agent] 恢复 ${run.id} 失败:`, (error as Error).message)
      })
    }
  }
})

function shutdown(): void {
  stopMailAutomationScheduler()
  stopPrepAgentService()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500).unref()
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
