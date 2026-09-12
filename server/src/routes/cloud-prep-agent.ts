import { Router } from 'express'
import type { NextFunction, Request, Response } from 'express'
import { AiError, completeStructured, isAiTaskEnabled, resolveAiTask } from '../ai.js'
import { requireWorkspaceId } from '../auth/workspace.js'
import { loadPrompt } from '../prompt-loader.js'
import { PREP_MODEL_CONTRACTS, validatePrepPlan, type PrepModelKind } from '../prep-agent-contracts.js'
import { prepAgentInternalToken } from '../prep-agent-service.js'
import { cancelPrepAgentRuntimeRun, resumePrepAgentRun, startPrepAgentRun } from '../prep-agent-runtime.js'
import {
  cancelCloudPrepRun, cloudPrepContext, cloudPrepReferences, cloudPrepRun, createCloudPrepRun,
  finishCloudPrepStep, insertCloudPrepStep, listCloudPrepRuns, parseCloudPrepConstraints,
  persistCloudPrepPlan, recoverableCloudPrepRuns, searchCloudPrepEvidence, serializeCloudPrepRun,
  updateCloudPrepRun, validateCloudPrepCreate, CloudPrepError
} from '../cloud-prep-agent-service.js'

export const cloudPrepAgentRouter = Router()
const asyncRoute = (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => { handler(req, res).catch(next) }
const numberId = (value: unknown, label: string) => { const id = Number(value); if (!Number.isSafeInteger(id) || id <= 0) throw new CloudPrepError(`${label} 非法`); return id }
const runId = (value: unknown) => { const id = typeof value === 'string' ? value : ''; if (!/^[a-f0-9-]{36}$/i.test(id)) throw new CloudPrepError('运行编号非法'); return id }

cloudPrepAgentRouter.post('/prep-agent/runs', asyncRoute(async (req, res) => {
  if (!isAiTaskEnabled('interviewPrepAgent')) throw new CloudPrepError('面试准备 Agent 已停用', 422, 'task_disabled')
  if (!resolveAiTask('interviewPrepAgent')) throw new CloudPrepError('请先配置可用的大模型，再生成面试准备计划', 422, 'not_configured')
  const workspaceId = requireWorkspaceId(req); const run = await createCloudPrepRun(workspaceId, validateCloudPrepCreate(req.body))
  if (run.status === 'pending') {
    try { await startPrepAgentRun(run.id) }
    catch (error) { await updateCloudPrepRun(run, { status: 'failed', error_type: 'agent_unavailable', error_message: (error as Error).message }); throw new CloudPrepError((error as Error).message, 503, 'agent_unavailable') }
  }
  res.status(202).json(await serializeCloudPrepRun(workspaceId, run.id))
}))
cloudPrepAgentRouter.get('/prep-agent/runs/:id', asyncRoute(async (req, res) => { res.json(await serializeCloudPrepRun(requireWorkspaceId(req), runId(req.params.id))) }))
cloudPrepAgentRouter.get('/prep-agent/runs/:id/references', asyncRoute(async (req, res) => { const run = await cloudPrepRun(requireWorkspaceId(req), runId(req.params.id)); res.json(await cloudPrepReferences(run)) }))
cloudPrepAgentRouter.get('/prep-agent/interviews/:id/runs', asyncRoute(async (req, res) => { res.json(await listCloudPrepRuns(requireWorkspaceId(req), numberId(req.params.id, 'interview_id'), Number(req.query.limit) || 10)) }))
cloudPrepAgentRouter.post('/prep-agent/runs/:id/resume', asyncRoute(async (req, res) => {
  const workspaceId = requireWorkspaceId(req); const run = await cloudPrepRun(workspaceId, runId(req.params.id)); if (run.status !== 'waiting_review') throw new CloudPrepError('当前运行不在等待确认状态', 409, 'run_state')
  const action = req.body?.action; if (!['approve', 'edit', 'revise', 'cancel'].includes(action)) throw new CloudPrepError('action 非法')
  if (action === 'cancel') { await cancelCloudPrepRun(run); await cancelPrepAgentRuntimeRun(run.id) }
  else { const decision: Record<string, unknown> = { action }; if (action === 'edit') decision.edited_plan = validatePrepPlan(req.body?.edited_plan); if (action === 'revise') { const feedback = typeof req.body?.feedback === 'string' ? req.body.feedback.trim().slice(0, 1000) : ''; if (!feedback) throw new CloudPrepError('请填写重新生成的修改要求'); decision.feedback = feedback }; await resumePrepAgentRun(run.id, decision) }
  res.status(202).json(await serializeCloudPrepRun(workspaceId, run.id))
}))
cloudPrepAgentRouter.post('/prep-agent/runs/:id/cancel', asyncRoute(async (req, res) => { const workspaceId = requireWorkspaceId(req); const run = await cloudPrepRun(workspaceId, runId(req.params.id)); await cancelCloudPrepRun(run); await cancelPrepAgentRuntimeRun(run.id); res.json(await serializeCloudPrepRun(workspaceId, run.id)) }))
cloudPrepAgentRouter.get('/prep-agent/runs/:id/events', asyncRoute(async (req, res) => {
  const workspaceId = requireWorkspaceId(req); const id = runId(req.params.id); await cloudPrepRun(workspaceId, id)
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8'); res.setHeader('Cache-Control', 'no-cache, no-transform'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders(); let last = ''; let closed = false
  const send = async () => { if (closed) return; try { const payload = await serializeCloudPrepRun(workspaceId, id); const value = JSON.stringify(payload); if (value !== last) { res.write(`event: run\ndata: ${value}\n\n`); last = value } else res.write(': keepalive\n\n'); if (['completed', 'failed', 'cancelled'].includes(String(payload.status))) { clearInterval(timer); setTimeout(() => { if (!closed) res.end() }, 200) } } catch { clearInterval(timer); res.end() } }
  const timer = setInterval(() => { void send() }, 1000); req.on('close', () => { closed = true; clearInterval(timer) }); await send()
}))

function internalOnly(req: Request, res: Response, next: NextFunction): void { const address = req.socket.remoteAddress ?? ''; const local = address === '127.0.0.1' || address === '::1' || address.endsWith(':127.0.0.1'); if (!local || req.get('x-prep-agent-token') !== prepAgentInternalToken()) { res.status(403).json({ message: '禁止访问 Agent 内部接口' }); return }; next() }
cloudPrepAgentRouter.use('/internal/prep-agent', internalOnly)
cloudPrepAgentRouter.get('/internal/prep-agent/runs/recoverable', asyncRoute(async (_req, res) => { res.json(await recoverableCloudPrepRuns()) }))
cloudPrepAgentRouter.get('/internal/prep-agent/runs/:id/input', asyncRoute(async (req, res) => { const run = await cloudPrepRun(null, runId(req.params.id)); res.json({ run_id: run.id, thread_id: run.thread_id, request_id: run.request_id, application_id: run.application_id, interview_id: run.interview_id, goal: run.goal, constraints: parseCloudPrepConstraints(run.constraints_json), status: run.status }) }))
cloudPrepAgentRouter.get('/internal/prep-agent/runs/:id/context', asyncRoute(async (req, res) => { res.json(await cloudPrepContext(await cloudPrepRun(null, runId(req.params.id)))) }))
cloudPrepAgentRouter.post('/internal/prep-agent/search', asyncRoute(async (req, res) => { const run = await cloudPrepRun(null, runId(req.body?.run_id)); res.json({ evidence: await searchCloudPrepEvidence(run, req.body?.queries) }) }))
cloudPrepAgentRouter.post('/internal/prep-agent/model', asyncRoute(async (req, res) => {
  const kind = req.body?.kind as PrepModelKind; if (!(kind in PREP_MODEL_CONTRACTS)) throw new CloudPrepError('未知模型节点'); const contract = PREP_MODEL_CONTRACTS[kind]; const input = req.body?.input; const serialized = JSON.stringify(input ?? {}); if (serialized.length > 160_000) throw new CloudPrepError('模型节点输入过长')
  const result = await completeStructured([{ role: 'system', content: `${loadPrompt(contract.prompt)}\n\nJSON Schema:\n${JSON.stringify(contract.schema)}` }, { role: 'user', content: `<untrusted_context_json>\n${serialized}\n</untrusted_context_json>` }], { task: 'interviewPrepAgent', schemaName: contract.schemaName, schema: contract.schema, validate: contract.validate as (value: unknown) => unknown })
  res.json({ value: result.value, attempts: result.attempts, model: result.completion.model, usage: result.completion.usage, duration_ms: result.completion.durationMs })
}))
cloudPrepAgentRouter.post('/internal/prep-agent/runs/:id/steps', asyncRoute(async (req, res) => { const run = await cloudPrepRun(null, runId(req.params.id)); res.status(201).json({ id: await insertCloudPrepStep(run, req.body) }) }))
cloudPrepAgentRouter.patch('/internal/prep-agent/runs/:id/steps/:stepId', asyncRoute(async (req, res) => { const run = await cloudPrepRun(null, runId(req.params.id)); await finishCloudPrepStep(run, numberId(req.params.stepId, 'step_id'), req.body); res.json({ ok: true }) }))
cloudPrepAgentRouter.post('/internal/prep-agent/runs/:id/status', asyncRoute(async (req, res) => { const run = await cloudPrepRun(null, runId(req.params.id)); await updateCloudPrepRun(run, req.body); res.json({ ok: true }) }))
cloudPrepAgentRouter.post('/internal/prep-agent/runs/:id/persist', asyncRoute(async (req, res) => { res.json(await persistCloudPrepPlan(await cloudPrepRun(null, runId(req.params.id)), req.body?.plan)) }))

cloudPrepAgentRouter.use((error: Error, _req: Request, res: Response, next: NextFunction) => { if (res.headersSent) return next(error); const status = error instanceof CloudPrepError ? error.statusCode : error instanceof AiError ? error.statusCode : 500; res.status(status).json({ message: error.message || '面试准备 Agent 请求失败', error_type: error instanceof CloudPrepError ? error.kind : error instanceof AiError ? error.kind : 'unexpected' }) })
