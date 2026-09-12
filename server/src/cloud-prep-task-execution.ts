import { completeChat, completeStructured, type AiCompletionResult } from './ai.js'
import { getPostgresSql } from './database/client.js'
import { cloudPrepContext, cloudPrepRun, type CloudPrepEvidence } from './cloud-prep-agent-service.js'
import { loadPrompt } from './prompt-loader.js'
import {
  PREP_LEARNING_MODULE_SCHEMA, PREP_TASK_BLUEPRINT_SCHEMA, PREP_TASK_CRITIC_SCHEMA, PREP_TASK_PRACTICE_SCHEMA,
  validatePrepLearningModule, validatePrepTaskBlueprint, validatePrepTaskCritic, validatePrepTaskGuide,
  validatePrepTaskPracticeSet, type PrepLearningModule, type PrepTaskBlueprint, type PrepTaskCriticResult, type PrepTaskGuide, type PrepTaskPracticeSet
} from './prep-task-contracts.js'

type TaskRow = Record<string, any>
const active = new Map<number, Promise<void>>()
const json = <T>(value: string | null | undefined, fallback: T): T => { try { return value ? JSON.parse(value) as T : fallback } catch { return fallback } }
const clip = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : ''
export class CloudPrepTaskError extends Error { constructor(message: string, public statusCode = 422, public kind = 'validation') { super(message) } }
function progress(value: unknown, maximum: number, name: string): number[] { if (!Array.isArray(value)) throw new CloudPrepTaskError(`${name} 必须是数组`); const result = [...new Set(value.map(Number))]; if (result.some(item => !Number.isInteger(item) || item < 0 || item >= maximum)) throw new CloudPrepTaskError(`${name} 包含无效序号`); return result.sort((a, b) => a - b) }

function select(where: string): string {
  return `SELECT p.id,p.run_id,p.checklist_id,p.title,p.category,p.priority,p.estimated_minutes,p.reason,p.success_criteria,p.evidence_json,p.sort,
    r.workspace_id,r.application_id,r.interview_id,r.goal,r.evidence_json AS run_evidence_json,c.content AS checklist_content,c.done::integer AS done,
    s.id AS session_id,s.guide_json,s.progress_json,s.guide_model,s.guide_generated_at,s.guide_version,s.generation_status,s.generation_stage,s.generation_progress,s.generation_error,s.generation_started_at,s.generation_model_calls,s.generation_prompt_tokens,s.generation_completion_tokens,s.generation_total_tokens,
    COALESCE((SELECT COUNT(*) FROM workspace_prep_task_messages m WHERE m.session_id=s.id),0)::integer AS message_count
    FROM workspace_prep_agent_plan_items p JOIN workspace_prep_agent_runs r ON r.id=p.run_id AND r.status='completed'
    JOIN checklist_items c ON c.id=p.checklist_id AND c.workspace_id=r.workspace_id
    LEFT JOIN workspace_prep_task_sessions s ON s.plan_item_id=p.id ${where}`
}
async function task(workspaceId: string, id: number): Promise<TaskRow> {
  const rows = await getPostgresSql().unsafe(select('WHERE p.id=$1 AND r.workspace_id=$2'), [id, workspaceId]) as TaskRow[]
  if (!rows[0]) throw new CloudPrepTaskError('AI 准备任务不存在或对应清单已删除', 404, 'not_found')
  return rows[0]
}
function serialize(row: TaskRow) {
  const stored = row.generation_status || (row.guide_json ? 'completed' : 'idle')
  return { id: row.id, run_id: row.run_id, checklist_id: row.checklist_id, application_id: row.application_id, interview_id: row.interview_id, title: row.title, category: row.category, priority: row.priority, estimated_minutes: row.estimated_minutes, reason: row.reason, success_criteria: row.success_criteria, evidence_refs: json<any[]>(row.evidence_json, []).map(item => clip(item?.ref, 60)).filter(Boolean), sort: row.sort, checklist_content: row.checklist_content, done: row.done, guide_ready: Boolean(row.guide_json), guide_version: Number(row.guide_version || (row.guide_json ? 2 : 0)), guide_generated_at: row.guide_generated_at, message_count: Number(row.message_count || 0), progress: json(row.progress_json, { steps: [], checks: [] }), generation: { status: stored, stage: row.generation_stage, progress: Number(row.generation_progress || (row.guide_json ? 100 : 0)), error: row.generation_error, started_at: row.generation_started_at, model_calls: Number(row.generation_model_calls || 0), prompt_tokens: Number(row.generation_prompt_tokens || 0), completion_tokens: Number(row.generation_completion_tokens || 0), total_tokens: Number(row.generation_total_tokens || 0) } }
}
async function session(row: TaskRow): Promise<number> {
  if (row.session_id) return Number(row.session_id)
  const rows = await getPostgresSql().unsafe(`INSERT INTO workspace_prep_task_sessions (workspace_id,plan_item_id) VALUES ($1,$2) ON CONFLICT (plan_item_id) DO UPDATE SET updated_at=now() RETURNING id`, [row.workspace_id, row.id]) as Array<{ id: number }>
  return rows[0].id
}
async function context(row: TaskRow) {
  const run = await cloudPrepRun(row.workspace_id, row.run_id); const base = await cloudPrepContext(run)
  const refs = new Map<string, any>(); refs.set('APP', base.application); refs.set('IV', base.interview); if (base.resume) refs.set('RES', base.resume); base.reviews.forEach(item => refs.set(item.ref, item)); base.mastery.forEach(item => refs.set(item.ref, item)); json<CloudPrepEvidence[]>(row.run_evidence_json, []).forEach(item => refs.set(item.ref, item)); json<any[]>(row.evidence_json, []).forEach(item => { if (item?.ref) refs.set(item.ref, item) })
  const evidenceRefs = json<any[]>(row.evidence_json, []).map(item => clip(item?.ref, 60)).filter(Boolean)
  const fresh = await getPostgresSql().unsafe(`SELECT i.id,i.source_id,i.question,COALESCE(i.answer,'') AS answer FROM knowledge_items i WHERE i.workspace_id=$1 AND (i.question ILIKE '%' || $2 || '%' OR COALESCE(i.answer,'') ILIKE '%' || $2 || '%') ORDER BY i.updated_at DESC LIMIT 6`, [row.workspace_id, row.title]) as Array<Record<string, unknown>>
  fresh.forEach((item, index) => refs.set(`K${index + 1}`, { ref: `K${index + 1}`, type: 'knowledge_item', item_id: item.id, source_id: item.source_id, title: item.question, excerpt: clip(item.answer, 2400) }))
  return { task: { id: row.id, title: row.title, category: row.category, priority: row.priority, estimated_minutes: row.estimated_minutes, reason: row.reason, success_criteria: row.success_criteria, evidence_refs: evidenceRefs }, plan_goal: row.goal, application: base.application, interview: base.interview, evidence: [...evidenceRefs.map(ref => refs.get(ref) ?? { ref, unavailable: true }), ...fresh.map((_, index) => refs.get(`K${index + 1}`))], validRefs: new Set(refs.keys()) }
}
function metrics() { return { calls: 0, prompt: 0, completion: 0, total: 0, model: null as string | null } }
function measure(state: ReturnType<typeof metrics>, completion: AiCompletionResult) { state.calls++; state.prompt += Number(completion.usage?.promptTokens || 0); state.completion += Number(completion.usage?.completionTokens || 0); state.total += Number(completion.usage?.totalTokens || 0); state.model = completion.model }
async function stage<T>(workspaceId: string, prompt: string, schemaName: string, schema: Record<string, unknown>, input: unknown, validate: (value: unknown) => T, state: ReturnType<typeof metrics>): Promise<T> {
  const text = JSON.stringify(input); if (text.length > 160000) throw new CloudPrepTaskError('准备任务上下文过长，请精简 JD 或知识资料')
  const result = await completeStructured([{ role: 'system', content: `${loadPrompt(prompt)}\n\nJSON Schema:\n${JSON.stringify(schema)}` }, { role: 'user', content: `<untrusted_task_context_json>\n${text}\n</untrusted_task_context_json>` }], { task: 'interviewPrepAgent', schemaName, schema, validate, maxOutputTokens: 8192, timeoutMs: 180000, skipAudit: true, workspaceId }); measure(state, result.completion); return result.value
}
function moduleEvidence(value: unknown, descriptor: PrepTaskBlueprint['modules'][number], valid: Set<string>): PrepLearningModule {
  const module = validatePrepLearningModule(value, descriptor)
  module.evidence_refs.forEach(ref => { if (!valid.has(ref)) throw new CloudPrepTaskError(`课程引用无效：${ref}`) })
  module.sections.forEach(section => section.evidence_refs.forEach(ref => { if (!valid.has(ref)) throw new CloudPrepTaskError(`课程引用无效：${ref}`) }))
  return module
}
async function moduleStage(workspaceId: string, taskContext: Awaited<ReturnType<typeof context>>, blueprint: PrepTaskBlueprint, descriptor: PrepTaskBlueprint['modules'][number], valid: Set<string>, state: ReturnType<typeof metrics>, criticFeedback: PrepTaskCriticResult['issues'] = []): Promise<PrepLearningModule> {
  return stage(workspaceId, 'prep-task-module.system.md', 'prep_task_learning_module_v2', PREP_LEARNING_MODULE_SCHEMA as any, { task_context: taskContext, course_overview: blueprint.overview, course_objectives: blueprint.objectives, module: descriptor, critic_feedback: criticFeedback }, value => moduleEvidence(value, descriptor, valid), state)
}
async function practiceStage(workspaceId: string, taskContext: Awaited<ReturnType<typeof context>>, blueprint: PrepTaskBlueprint, modules: PrepLearningModule[], state: ReturnType<typeof metrics>, criticFeedback: PrepTaskCriticResult['issues'] = []): Promise<PrepTaskPracticeSet> {
  return stage(workspaceId, 'prep-task-practice.system.md', 'prep_task_practice_v2', PREP_TASK_PRACTICE_SCHEMA as any, { task: taskContext.task, overview: blueprint.overview, objectives: blueprint.objectives, coverage_map: blueprint.coverage_map, modules, critic_feedback: criticFeedback }, value => validatePrepTaskPracticeSet(value, new Set(modules.map(module => module.id))), state)
}
async function updateGeneration(sessionId: number, stageName: string, percentage: number, state: ReturnType<typeof metrics>) { await getPostgresSql().unsafe(`UPDATE workspace_prep_task_sessions SET generation_stage=$1,generation_progress=$2,generation_model_calls=$3,generation_prompt_tokens=$4,generation_completion_tokens=$5,generation_total_tokens=$6,updated_at=now() WHERE id=$7`, [stageName, percentage, state.calls, state.prompt, state.completion, state.total, sessionId]) }
async function generate(taskId: number, workspaceId: string, sessionId: number, force: boolean) {
  const state = metrics()
  try {
    const row = await task(workspaceId, taskId); const taskContext = await context(row); const valid = taskContext.validRefs
    await updateGeneration(sessionId, 'blueprint', 8, state)
    const blueprint = await stage(workspaceId, 'prep-task-blueprint.system.md', 'prep_task_blueprint_v2', PREP_TASK_BLUEPRINT_SCHEMA as any, { task_context: taskContext }, value => { const plan = validatePrepTaskBlueprint(value); plan.modules.forEach(module => module.evidence_refs.forEach(ref => { if (!valid.has(ref)) throw new CloudPrepTaskError(`课程引用无效：${ref}`) })); return plan }, state)
    const modules: PrepLearningModule[] = []; await updateGeneration(sessionId, 'modules', 20, state)
    for (const descriptor of blueprint.modules) { modules.push(await moduleStage(workspaceId, taskContext, blueprint, descriptor, valid, state)); await updateGeneration(sessionId, 'modules', 20 + Math.round(45 * modules.length / blueprint.modules.length), state) }
    await updateGeneration(sessionId, 'practice', 68, state); let practice = await practiceStage(workspaceId, taskContext, blueprint, modules, state)
    let draft = validatePrepTaskGuide({ version: 2, ...blueprint, modules, practice_set: practice.items, completion_checklist: practice.completion_checklist, quality_review: { verdict: 'pass', repaired: false, issues: [] } }); await updateGeneration(sessionId, 'review', 86, state)
    let critic = await stage(workspaceId, 'prep-task-critic.system.md', 'prep_task_course_critic_v2', PREP_TASK_CRITIC_SCHEMA as any, { guide: draft }, validatePrepTaskCritic, state)
    let repaired = false
    if (critic.verdict === 'revise') {
      await updateGeneration(sessionId, 'repair', 91, state)
      const moduleIds = [...new Set(critic.issues.filter(issue => issue.target === 'module' && issue.module_id).map(issue => String(issue.module_id)))].slice(0, 2)
      for (const moduleId of moduleIds) { const index = modules.findIndex(module => module.id === moduleId); const descriptor = blueprint.modules.find(module => module.id === moduleId); if (index >= 0 && descriptor) { modules[index] = await moduleStage(workspaceId, taskContext, blueprint, descriptor, valid, state, critic.issues.filter(issue => issue.module_id === moduleId)); repaired = true } }
      const practiceIssues = critic.issues.filter(issue => issue.target === 'practice' || issue.target === 'guide')
      if (practiceIssues.length) { practice = await practiceStage(workspaceId, taskContext, blueprint, modules, state, practiceIssues); repaired = true }
      draft = validatePrepTaskGuide({ version: 2, ...blueprint, modules, practice_set: practice.items, completion_checklist: practice.completion_checklist, quality_review: { verdict: 'pass', repaired, issues: [] } })
      critic = await stage(workspaceId, 'prep-task-critic.system.md', 'prep_task_course_critic_v2', PREP_TASK_CRITIC_SCHEMA as any, { guide: draft }, validatePrepTaskCritic, state)
    }
    const guide = { ...draft, quality_review: { verdict: critic.verdict === 'pass' ? 'pass' as const : 'warn' as const, repaired, issues: critic.issues } }
    await getPostgresSql().unsafe(`UPDATE workspace_prep_task_sessions SET guide_json=$1,progress_json='{"steps":[],"checks":[]}',guide_model=$2,guide_generated_at=now(),guide_version=2,generation_status='completed',generation_stage='completed',generation_progress=100,generation_error=NULL,generation_model_calls=$3,generation_prompt_tokens=$4,generation_completion_tokens=$5,generation_total_tokens=$6,quality_json=$7,updated_at=now() WHERE id=$8`, [JSON.stringify(guide), state.model, state.calls, state.prompt, state.completion, state.total, JSON.stringify(guide.quality_review), sessionId]); if (force) await getPostgresSql().unsafe('DELETE FROM workspace_prep_task_messages WHERE session_id=$1', [sessionId])
  } catch (error) { await getPostgresSql().unsafe(`UPDATE workspace_prep_task_sessions SET generation_status='failed',generation_stage='failed',generation_error=$1,updated_at=now() WHERE id=$2`, [clip((error as Error).message, 500) || '执行课程生成失败', sessionId]) }
}
export async function listCloudPrepTasks(workspaceId: string, interviewId: number) { const rows = await getPostgresSql().unsafe(select('WHERE r.workspace_id=$1 AND r.interview_id=$2 ORDER BY c.sort,p.sort'), [workspaceId, interviewId]) as TaskRow[]; return rows.map(serialize) }
export async function cloudPrepTaskSession(workspaceId: string, id: number) { let row = await task(workspaceId, id); await session(row); row = await task(workspaceId, id); const messages = row.session_id ? await getPostgresSql().unsafe('SELECT id,role,content,request_id,created_at FROM workspace_prep_task_messages WHERE session_id=$1 ORDER BY id DESC LIMIT 100', [row.session_id]) : []; return { task: serialize(row), guide: row.guide_json ? json(row.guide_json, null) : null, progress: json(row.progress_json, { steps: [], checks: [] }), evidence: (await context(row)).evidence, messages: [...messages].reverse(), generation: serialize(row).generation } }
export async function generateCloudPrepGuide(workspaceId: string, id: number, force: boolean) { let row = await task(workspaceId, id); const sessionId = await session(row); row = await task(workspaceId, id); if (row.generation_status === 'running' && !active.has(id)) await getPostgresSql().unsafe("UPDATE workspace_prep_task_sessions SET generation_status='failed',generation_stage='interrupted',generation_error='服务重启导致课程生成中断，请重新生成',updated_at=now() WHERE id=$1", [sessionId]); row = await task(workspaceId, id); if (active.has(id) || (row.guide_json && !force)) return cloudPrepTaskSession(workspaceId, id); await getPostgresSql().unsafe(`UPDATE workspace_prep_task_sessions SET generation_status='running',generation_stage='queued',generation_progress=1,generation_error=NULL,generation_started_at=now(),updated_at=now() WHERE id=$1`, [sessionId]); const running = generate(id, workspaceId, sessionId, force).finally(() => active.delete(id)); active.set(id, running); return cloudPrepTaskSession(workspaceId, id) }
export async function updateCloudPrepProgress(workspaceId: string, id: number, body: any) { const row = await task(workspaceId, id); const guide = row.guide_json ? json<PrepTaskGuide | null>(row.guide_json, null) : null; if (!guide) throw new CloudPrepTaskError('请先生成完整执行课程', 409, 'guide_required'); const current = json<any>(row.progress_json, { steps: [], checks: [] }); const next = { steps: body?.steps === undefined ? progress(current.steps, guide.modules.length, 'steps') : progress(body.steps, guide.modules.length, 'steps'), checks: body?.checks === undefined ? progress(current.checks, guide.completion_checklist.length, 'checks') : progress(body.checks, guide.completion_checklist.length, 'checks') }; if (body?.done !== undefined) await getPostgresSql().unsafe('UPDATE checklist_items SET done=$1 WHERE workspace_id=$2 AND id=$3', [body.done === true, workspaceId, row.checklist_id]); const sessionId = await session(row); await getPostgresSql().unsafe('UPDATE workspace_prep_task_sessions SET progress_json=$1,updated_at=now() WHERE id=$2', [JSON.stringify(next), sessionId]); return cloudPrepTaskSession(workspaceId, id) }
export async function chatCloudPrepTask(workspaceId: string, id: number, body: any) { const content = clip(body?.content, 4000); const requestId = clip(body?.request_id, 100); if (!content || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw new CloudPrepTaskError('追问内容或请求编号非法'); const row = await task(workspaceId, id); const sessionId = await session(row); const prior = await getPostgresSql().unsafe("SELECT id,role,content,request_id,created_at FROM workspace_prep_task_messages WHERE session_id=$1 AND request_id=$2 AND role='assistant' ORDER BY id DESC LIMIT 1", [sessionId, requestId]) as any[]; if (prior.length) return { message: prior[0] }; const guide = row.guide_json ? json(row.guide_json, null) : null; if (!guide) throw new CloudPrepTaskError('请先生成完整执行课程', 409, 'guide_required'); const history = await getPostgresSql().unsafe('SELECT role,content FROM workspace_prep_task_messages WHERE session_id=$1 ORDER BY id DESC LIMIT 12', [sessionId]) as any[]; await getPostgresSql().unsafe(`INSERT INTO workspace_prep_task_messages (session_id,role,content,request_id) VALUES ($1,'user',$2,$3) ON CONFLICT (session_id,role,request_id) DO NOTHING`, [sessionId, content, requestId]); const result = await completeChat([{ role: 'system', content: loadPrompt('prep-task-coach.system.md') }, { role: 'user', content: JSON.stringify({ task: serialize(row), guide, evidence: (await context(row)).evidence, conversation: history.reverse(), user_question: content }) }], { task: 'interviewPrepAgent', maxOutputTokens: 4096, timeoutMs: 120000, skipAudit: true, workspaceId }); const rows = await getPostgresSql().unsafe(`INSERT INTO workspace_prep_task_messages (session_id,role,content,request_id) VALUES ($1,'assistant',$2,$3) RETURNING id,role,content,request_id,created_at`, [sessionId, result.content, requestId]) as any[]; return { message: rows[0] } }
