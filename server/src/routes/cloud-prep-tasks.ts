import { Router } from 'express'
import type { NextFunction, Request, Response } from 'express'
import { requireWorkspaceId } from '../auth/workspace.js'
import { AiError, isAiTaskEnabled, resolveAiTask } from '../ai.js'
import { CloudPrepError } from '../cloud-prep-agent-service.js'
import { CloudPrepTaskError, chatCloudPrepTask, cloudPrepTaskSession, generateCloudPrepGuide, listCloudPrepTasks, updateCloudPrepProgress } from '../cloud-prep-task-execution.js'

export const cloudPrepTasksRouter = Router()
const route = (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => { handler(req, res).catch(next) }
const id = (value: unknown, name: string) => { const result = Number(value); if (!Number.isSafeInteger(result) || result <= 0) throw new CloudPrepTaskError(`${name} 非法`); return result }
const requireModel = () => { if (!isAiTaskEnabled('interviewPrepAgent')) throw new CloudPrepTaskError('面试准备 Agent 已停用', 422, 'task_disabled'); if (!resolveAiTask('interviewPrepAgent')) throw new CloudPrepTaskError('请先配置可用的面试准备模型', 422, 'not_configured') }

cloudPrepTasksRouter.get('/prep-agent/interviews/:id/tasks', route(async (req, res) => { res.json(await listCloudPrepTasks(requireWorkspaceId(req), id(req.params.id, 'interview_id'))) }))
cloudPrepTasksRouter.get('/prep-agent/plan-items/:id/session', route(async (req, res) => { res.json(await cloudPrepTaskSession(requireWorkspaceId(req), id(req.params.id, 'plan_item_id'))) }))
cloudPrepTasksRouter.post('/prep-agent/plan-items/:id/guide', route(async (req, res) => { requireModel(); res.status(202).json(await generateCloudPrepGuide(requireWorkspaceId(req), id(req.params.id, 'plan_item_id'), req.body?.force === true)) }))
cloudPrepTasksRouter.patch('/prep-agent/plan-items/:id/progress', route(async (req, res) => { res.json(await updateCloudPrepProgress(requireWorkspaceId(req), id(req.params.id, 'plan_item_id'), req.body)) }))
cloudPrepTasksRouter.post('/prep-agent/plan-items/:id/messages', route(async (req, res) => { requireModel(); res.json(await chatCloudPrepTask(requireWorkspaceId(req), id(req.params.id, 'plan_item_id'), req.body)) }))
cloudPrepTasksRouter.use((error: Error, _req: Request, res: Response, next: NextFunction) => { if (res.headersSent) return next(error); const status = error instanceof CloudPrepTaskError ? error.statusCode : error instanceof CloudPrepError ? error.statusCode : error instanceof AiError ? error.statusCode : 500; res.status(status).json({ message: error.message || '准备任务执行请求失败', error_type: error instanceof CloudPrepTaskError ? error.kind : error instanceof CloudPrepError ? error.kind : error instanceof AiError ? error.kind : 'unexpected' }) })
