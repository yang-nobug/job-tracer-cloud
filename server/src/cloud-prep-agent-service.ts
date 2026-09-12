import { createHash, randomUUID } from 'node:crypto'
import { getPostgresSql } from './database/client.js'
import {
  validatePrepCritic, validatePrepGapAnalysis, validatePrepPlan, validatePrepRoleProfile,
  type PrepPlan
} from './prep-agent-contracts.js'

export const CLOUD_PREP_STATUSES = ['pending', 'running', 'waiting_review', 'committing', 'completed', 'failed', 'cancelled'] as const
type Status = typeof CLOUD_PREP_STATUSES[number]

export interface CloudPrepConstraints { focus: string[]; project_ids: number[]; resume_id: number | null }
export interface CloudPrepRun { id: string; workspace_id: string; thread_id: string; request_id: string; application_id: number; interview_id: number; status: Status; goal: string; constraints_json: string; input_hash: string; snapshot_hash: string | null; current_node: string | null; plan_json: string | null; evidence_json: string | null; role_profile_json: string | null; gap_analysis_json: string | null; critic_json: string | null; warnings_json: string; error_type: string | null; error_message: string | null; model_calls: number; prompt_tokens: number; completion_tokens: number; total_tokens: number; created_at: string; updated_at: string; finished_at: string | null }

export interface CloudPrepEvidence { ref: string; type: 'knowledge_item' | 'application' | 'interview' | 'review' | 'mastery' | 'resume' | 'project'; title: string; excerpt: string; source_id?: number | null; item_id?: number; score?: number; company?: string; position?: string; round?: string; retrieval_scope?: 'same_company_position' | 'same_company' | 'general' }

export class CloudPrepError extends Error { constructor(message: string, public statusCode = 422, public kind = 'validation') { super(message) } }

const clip = (value: unknown, size: number) => typeof value === 'string' ? value.trim().slice(0, size) : ''
const parseJson = <T>(value: string | null | undefined, fallback: T): T => { try { return value ? JSON.parse(value) as T : fallback } catch { return fallback } }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}+#]+/gu, '')
const samePosition = (left: string, right: string) => { const a = normalize(left); const b = normalize(right); return Boolean(a && b && (a === b || a.includes(b) || b.includes(a))) }

export function parseCloudPrepConstraints(value: string | null): CloudPrepConstraints {
  const raw = parseJson<Record<string, unknown>>(value, {})
  const focus = Array.isArray(raw.focus) ? raw.focus.map(value => clip(value, 40)).filter(Boolean).slice(0, 8) : []
  const resumeId = Number(raw.resume_id)
  const projectIds = Array.isArray(raw.project_ids) ? [...new Set(raw.project_ids.map(Number).filter(id => Number.isInteger(id) && id > 0))].slice(0, 3) : []
  return { focus, project_ids: projectIds, resume_id: Number.isInteger(resumeId) && resumeId > 0 ? resumeId : null }
}

export function validateCloudPrepCreate(body: unknown): { applicationId: number; interviewId: number; goal: string; constraints: CloudPrepConstraints; requestId: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CloudPrepError('请求格式不正确')
  const raw = body as Record<string, unknown>; const applicationId = Number(raw.application_id); const interviewId = Number(raw.interview_id)
  if (!Number.isInteger(applicationId) || applicationId <= 0) throw new CloudPrepError('application_id 非法')
  if (!Number.isInteger(interviewId) || interviewId <= 0) throw new CloudPrepError('interview_id 非法')
  const requestId = clip(raw.request_id, 100)
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw new CloudPrepError('request_id 非法')
  const constraints = raw.constraints && typeof raw.constraints === 'object' && !Array.isArray(raw.constraints) ? raw.constraints : {}
  const focus = Array.isArray((constraints as Record<string, unknown>).focus) ? (constraints as Record<string, unknown>).focus as unknown[] : []
  const resumeId = Number((constraints as Record<string, unknown>).resume_id)
  const projectIds = Array.isArray((constraints as Record<string, unknown>).project_ids) ? [...new Set(((constraints as Record<string, unknown>).project_ids as unknown[]).map(Number).filter(id => Number.isInteger(id) && id > 0))].slice(0, 3) : []
  return { applicationId, interviewId, goal: clip(raw.goal, 500) || '根据当前岗位和面试资料生成准备计划', requestId,
    constraints: { focus: focus.map(value => clip(value, 40)).filter(Boolean).slice(0, 8), project_ids: projectIds, resume_id: Number.isInteger(resumeId) && resumeId > 0 ? resumeId : null } }
}

export async function createCloudPrepRun(workspaceId: string, input: ReturnType<typeof validateCloudPrepCreate>): Promise<CloudPrepRun> {
  const sql = getPostgresSql()
  const existing = await sql.unsafe('SELECT * FROM workspace_prep_agent_runs WHERE workspace_id=$1 AND request_id=$2', [workspaceId, input.requestId]) as unknown as CloudPrepRun[]
  if (existing[0]) return existing[0]
  const interview = await sql.unsafe(`SELECT i.id,i.done FROM interviews i JOIN applications a ON a.id=i.application_id
    WHERE i.workspace_id=$1 AND i.id=$2 AND a.workspace_id=$1 AND a.id=$3 AND i.application_id=$3`, [workspaceId, input.interviewId, input.applicationId]) as Array<{ id: number; done: boolean }>
  if (!interview[0]) throw new CloudPrepError('投递或面试不存在，或者二者不匹配', 404, 'not_found')
  if (interview[0].done) throw new CloudPrepError('该面试已完成，不能再生成面试准备计划', 409, 'interview_completed')
  if (input.constraints.resume_id) {
    const resume = await sql.unsafe(`SELECT r.id FROM resumes r JOIN resume_texts t ON t.resume_id=r.id
      WHERE r.workspace_id=$1 AND r.id=$2 AND t.workspace_id=$1 AND t.status='completed' AND length(COALESCE(t.text_content,''))>0`, [workspaceId, input.constraints.resume_id])
    if (!resume.length) throw new CloudPrepError('选择的简历不存在或尚未成功提取文本', 422, 'resume_unavailable')
  }
  if (input.constraints.project_ids.length) {
    const ids = sql.array(input.constraints.project_ids, 23)
    const projects = await sql.unsafe('SELECT id FROM workspace_project_profiles WHERE workspace_id=$1 AND id=ANY($2::int[])', [workspaceId, ids])
    if (projects.length !== input.constraints.project_ids.length) throw new CloudPrepError('选择的项目档案不存在', 422, 'project_unavailable')
  }
  const active = await sql.unsafe(`SELECT id FROM workspace_prep_agent_runs WHERE workspace_id=$1 AND interview_id=$2
    AND status IN ('pending','running','waiting_review','committing') LIMIT 1`, [workspaceId, input.interviewId])
  if (active.length) throw new CloudPrepError('这场面试已有正在进行或等待确认的准备计划', 409, 'active_run')
  const id = randomUUID(); const constraintsJson = JSON.stringify(input.constraints)
  const rows = await sql.unsafe(`INSERT INTO workspace_prep_agent_runs (id,workspace_id,thread_id,request_id,application_id,interview_id,goal,constraints_json,input_hash)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [id, workspaceId, `prep:${id}`, input.requestId, input.applicationId, input.interviewId, input.goal, constraintsJson, hash({ applicationId: input.applicationId, interviewId: input.interviewId, goal: input.goal, constraints: input.constraints })]) as unknown as CloudPrepRun[]
  return rows[0]
}

export async function cloudPrepRun(workspaceId: string | null, id: string): Promise<CloudPrepRun> {
  const params: unknown[] = workspaceId ? [workspaceId, id] : [id]
  const rows = await getPostgresSql().unsafe(`SELECT * FROM workspace_prep_agent_runs WHERE ${workspaceId ? 'workspace_id=$1 AND id=$2' : 'id=$1'}`, params as never[]) as unknown as CloudPrepRun[]
  if (!rows[0]) throw new CloudPrepError('Agent 运行不存在', 404, 'not_found')
  return rows[0]
}

export async function cloudPrepContext(run: CloudPrepRun) {
  const sql = getPostgresSql()
  const rows = await sql.unsafe(`SELECT a.company,a.position,a.status,a.location AS application_location,a.jd_text,a.notes,a.updated_at AS application_updated_at,
    i.round,i.scheduled_at,i.location AS interview_location,i.done,i.created_at AS interview_created_at
    FROM applications a JOIN interviews i ON i.id=$2 AND i.application_id=a.id AND i.workspace_id=a.workspace_id
    WHERE a.workspace_id=$1 AND a.id=$3`, [run.workspace_id, run.interview_id, run.application_id]) as Array<Record<string, unknown>>
  const row = rows[0]; if (!row) throw new CloudPrepError('投递或面试已不存在', 404, 'not_found')
  const checklist = await sql.unsafe('SELECT id,content,done::integer AS done FROM checklist_items WHERE workspace_id=$1 AND interview_id=$2 ORDER BY sort,id', [run.workspace_id, run.interview_id])
  const masteryRows = await sql.unsafe(`SELECT i.id,i.source_id,i.question,COALESCE(i.answer,'') AS answer,COALESCE(s.company,'') AS company,COALESCE(s.position,'') AS position,COALESCE(s.round,'') AS round
    FROM knowledge_items i LEFT JOIN knowledge_sources s ON s.id=i.source_id AND s.workspace_id=i.workspace_id WHERE i.workspace_id=$1 AND i.mastery<2
    ORDER BY CASE WHEN s.application_id=$2 THEN 0 WHEN s.company=$3 THEN 1 ELSE 2 END,i.mastery,i.updated_at DESC LIMIT 30`, [run.workspace_id, run.application_id, String(row.company ?? '')]) as Array<Record<string, unknown>>
  const mastery: CloudPrepEvidence[] = masteryRows.map((item, index) => ({ ref: `M${index + 1}`, type: 'mastery', item_id: Number(item.id), source_id: item.source_id == null ? null : Number(item.source_id), title: String(item.question), excerpt: clip(item.answer, 1200), company: String(item.company ?? ''), position: String(item.position ?? ''), round: String(item.round ?? '') }))
  const constraints = parseCloudPrepConstraints(run.constraints_json)
  const resumeRows = constraints.resume_id ? await sql.unsafe(`SELECT r.id,r.filename,r.note,t.text_content FROM resumes r JOIN resume_texts t ON t.resume_id=r.id
    WHERE r.workspace_id=$1 AND r.id=$2 AND t.workspace_id=$1 AND t.status='completed'`, [run.workspace_id, constraints.resume_id]) as Array<{ id: number; filename: string; note: string | null; text_content: string }> : []
  const resume = resumeRows[0] ? { ref: 'RES', type: 'resume' as const, item_id: resumeRows[0].id, title: resumeRows[0].note ? `${resumeRows[0].filename} · ${resumeRows[0].note}` : resumeRows[0].filename, excerpt: clip(resumeRows[0].text_content, 16000) } : null
  const reviewRows = await sql.unsafe(`SELECT r.interview_id,r.content,i.round,i.scheduled_at FROM workspace_interview_reviews r
    JOIN interviews i ON i.id=r.interview_id AND i.workspace_id=r.workspace_id
    WHERE r.workspace_id=$1 AND i.application_id=$2 ORDER BY r.updated_at DESC LIMIT 6`, [run.workspace_id, run.application_id]) as Array<{ interview_id: number; content: string; round: string; scheduled_at: string }>
  const reviews: CloudPrepEvidence[] = reviewRows.map((item, index) => ({ ref: `R${index + 1}`, type: 'review', item_id: item.interview_id, title: `${item.round} 复盘`, excerpt: clip(item.content, 4000), round: item.round }))
  const projectRows = constraints.project_ids.length ? await sql.unsafe(`SELECT p.id,p.name,p.description,f.title,f.content FROM workspace_project_profiles p LEFT JOIN workspace_project_facts f ON f.project_id=p.id WHERE p.workspace_id=$1 AND p.id=ANY($2::int[]) ORDER BY p.id,f.id DESC`, [run.workspace_id, sql.array(constraints.project_ids, 23)]) as Array<{ id:number; name:string; description:string; title:string|null; content:string|null }> : []
  const projects: CloudPrepEvidence[] = projectRows.map((item, index) => ({ ref: `P${index + 1}`, type: 'project' as const, item_id: item.id, title: item.title ? `${item.name} · ${item.title}` : item.name, excerpt: clip([item.description, item.content].filter(Boolean).join('\n'), 3000) || '项目已接入，但尚未填写项目事实。' })).slice(0, 12)
  const context = { application: { ref: 'APP' as const, id: run.application_id, company: String(row.company), position: String(row.position), status: String(row.status), location: row.application_location == null ? null : String(row.application_location), jd_text: clip(row.jd_text, 12000) || null, notes: clip(row.notes, 3000) || null }, interview: { ref: 'IV' as const, id: run.interview_id, round: String(row.round), scheduled_at: String(row.scheduled_at), location: row.interview_location == null ? null : String(row.interview_location), done: row.done ? 1 : 0 }, existing_checklist: checklist, resume, resume_status: constraints.resume_id ? (resume ? 'completed' : 'unavailable') : null, reviews, mastery, projects }
  return { snapshot_hash: hash({ ...context, application_updated_at: row.application_updated_at, interview_created_at: row.interview_created_at }), ...context }
}

export async function serializeCloudPrepRun(workspaceId: string | null, id: string, includeSteps = true): Promise<Record<string, unknown>> {
  const run = await cloudPrepRun(workspaceId, id); const sql = getPostgresSql()
  const steps = includeSteps ? await sql.unsafe('SELECT id,node,attempt,status,summary,duration_ms,error_type,created_at,finished_at FROM workspace_prep_agent_steps WHERE run_id=$1 ORDER BY id', [run.id]) : undefined
  const persisted = run.status === 'completed' ? await sql.unsafe(`SELECT id,checklist_id,title,category,priority,estimated_minutes,reason,success_criteria,evidence_json,sort
    FROM workspace_prep_agent_plan_items WHERE run_id=$1 ORDER BY sort`, [run.id]) as Array<Record<string, unknown>> : undefined
  return { ...run, constraints: parseCloudPrepConstraints(run.constraints_json), plan: parseJson(run.plan_json, null), evidence: parseJson<CloudPrepEvidence[]>(run.evidence_json, []), role_profile: parseJson(run.role_profile_json, null), gap_analysis: parseJson(run.gap_analysis_json, null), critic: parseJson(run.critic_json, null), warnings: parseJson<string[]>(run.warnings_json, []), ...(steps ? { steps } : {}), ...(persisted ? { persisted_items: persisted.map(item => ({ ...item, evidence_refs: parseJson(item.evidence_json as string, []), evidence_json: undefined })) } : {}) }
}

export async function cloudPrepReferences(run: CloudPrepRun): Promise<CloudPrepEvidence[]> {
  const context = await cloudPrepContext(run); const evidence = parseJson<CloudPrepEvidence[]>(run.evidence_json, [])
  return [{ ref: 'APP', type: 'application', title: `${context.application.company} · ${context.application.position}`, excerpt: [context.application.jd_text, context.application.notes].filter(Boolean).join('\n\n') || '当前投递未填写 JD 或备注。' }, { ref: 'IV', type: 'interview', title: context.interview.round, excerpt: `面试时间：${context.interview.scheduled_at}` }, ...(context.resume ? [context.resume] : []), ...context.reviews, ...context.mastery, ...context.projects, ...evidence.filter(item => !['APP', 'IV', 'RES'].includes(item.ref))]
}

export async function searchCloudPrepEvidence(run: CloudPrepRun, queries: unknown): Promise<CloudPrepEvidence[]> {
  if (!Array.isArray(queries) || queries.length > 8) throw new CloudPrepError('queries 必须是最多 8 项的数组')
  const context = await cloudPrepContext(run); const sql = getPostgresSql(); const selected = new Map<number, CloudPrepEvidence>()
  const scoped = await sql.unsafe(`SELECT i.id,i.source_id,i.question,COALESCE(i.answer,'') AS answer,COALESCE(s.company,'') AS company,COALESCE(s.position,'') AS position,COALESCE(s.round,'') AS round
    FROM knowledge_items i JOIN knowledge_sources s ON s.id=i.source_id AND s.workspace_id=i.workspace_id WHERE i.workspace_id=$1 AND lower(s.company) LIKE '%' || lower($2) || '%' LIMIT 80`, [run.workspace_id, context.application.company]) as Array<Record<string, unknown>>
  for (const item of scoped) { const position = String(item.position ?? ''); const scope = samePosition(position, context.application.position) ? 'same_company_position' : 'same_company'; selected.set(Number(item.id), { ref: '', type: 'knowledge_item', item_id: Number(item.id), source_id: item.source_id == null ? null : Number(item.source_id), title: String(item.question), excerpt: clip(item.answer, 1800), company: String(item.company), position, round: String(item.round ?? ''), retrieval_scope: scope, score: scope === 'same_company_position' ? 100 : 60 }) }
  for (const raw of queries) { const query = raw && typeof raw === 'object' ? clip((raw as Record<string, unknown>).query, 200) : ''; if (!query) throw new CloudPrepError('检索关键词不能为空')
    const rows = await sql.unsafe(`SELECT i.id,i.source_id,i.question,COALESCE(i.answer,'') AS answer,COALESCE(s.company,'') AS company,COALESCE(s.position,'') AS position,COALESCE(s.round,'') AS round
      FROM knowledge_items i LEFT JOIN knowledge_sources s ON s.id=i.source_id AND s.workspace_id=i.workspace_id WHERE i.workspace_id=$1 AND (i.question ILIKE '%' || $2 || '%' OR COALESCE(i.answer,'') ILIKE '%' || $2 || '%') ORDER BY i.updated_at DESC LIMIT 8`, [run.workspace_id, query]) as Array<Record<string, unknown>>
    for (const item of rows) if (!selected.has(Number(item.id))) selected.set(Number(item.id), { ref: '', type: 'knowledge_item', item_id: Number(item.id), source_id: item.source_id == null ? null : Number(item.source_id), title: String(item.question), excerpt: clip(item.answer, 1800), company: String(item.company ?? ''), position: String(item.position ?? ''), round: String(item.round ?? ''), retrieval_scope: 'general', score: 10 })
  }
  return [...selected.values()].sort((a, b) => Number(b.score) - Number(a.score)).slice(0, 15).map((item, index) => ({ ...item, ref: `E${index + 1}` }))
}

export async function updateCloudPrepRun(run: CloudPrepRun, body: unknown): Promise<void> {
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}; const current = run
  const status = typeof raw.status === 'string' && CLOUD_PREP_STATUSES.includes(raw.status as Status) ? raw.status as Status : current.status
  if (['completed', 'cancelled'].includes(current.status) && status !== current.status) return
  const metrics = raw.metrics && typeof raw.metrics === 'object' ? raw.metrics as Record<string, unknown> : {}; const count = (name: string, fallback: number) => Number.isInteger(Number(metrics[name])) && Number(metrics[name]) >= 0 ? Number(metrics[name]) : fallback
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.map(v => clip(v, 300)).filter(Boolean).slice(0, 30) : parseJson<string[]>(current.warnings_json, [])
  const json = (key: string, fallback: string | null, validate: (value: unknown) => unknown) => raw[key] === undefined ? fallback : JSON.stringify(validate(raw[key]))
  await getPostgresSql().unsafe(`UPDATE workspace_prep_agent_runs SET status=$1,snapshot_hash=$2,current_node=$3,plan_json=$4,evidence_json=$5,role_profile_json=$6,gap_analysis_json=$7,critic_json=$8,warnings_json=$9,error_type=$10,error_message=$11,model_calls=$12,prompt_tokens=$13,completion_tokens=$14,total_tokens=$15,updated_at=now(),finished_at=$16 WHERE id=$17`, [status, raw.snapshot_hash === undefined ? current.snapshot_hash : clip(raw.snapshot_hash, 64) || null, raw.current_node === undefined ? current.current_node : clip(raw.current_node, 80) || null, json('plan', current.plan_json, validatePrepPlan), raw.evidence === undefined ? current.evidence_json : JSON.stringify(Array.isArray(raw.evidence) ? raw.evidence.slice(0, 30) : []), json('role_profile', current.role_profile_json, validatePrepRoleProfile), json('gap_analysis', current.gap_analysis_json, validatePrepGapAnalysis), json('critic', current.critic_json, validatePrepCritic), JSON.stringify(warnings), raw.error_type === undefined ? current.error_type : clip(raw.error_type, 80) || null, raw.error_message === undefined ? current.error_message : clip(raw.error_message, 500) || null, count('model_calls', current.model_calls), count('prompt_tokens', current.prompt_tokens), count('completion_tokens', current.completion_tokens), count('total_tokens', current.total_tokens), ['completed', 'failed', 'cancelled'].includes(status) ? new Date() : null, current.id])
}

export async function insertCloudPrepStep(run: CloudPrepRun, body: unknown): Promise<number> { const raw = body && typeof body === 'object' ? body as Record<string, unknown> : {}; const node = clip(raw.node, 80); const attempt = Number(raw.attempt ?? 1); if (!node || !Number.isInteger(attempt) || attempt < 1 || attempt > 20) throw new CloudPrepError('步骤参数非法'); const rows = await getPostgresSql().unsafe(`INSERT INTO workspace_prep_agent_steps (run_id,node,attempt,summary,input_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [run.id, node, attempt, clip(raw.summary, 500) || null, clip(raw.input_hash, 64) || null]) as Array<{ id: number }>; await getPostgresSql().unsafe(`UPDATE workspace_prep_agent_runs SET status='running',current_node=$1,updated_at=now() WHERE id=$2 AND status NOT IN ('completed','cancelled')`, [node, run.id]); return rows[0].id }

export async function finishCloudPrepStep(run: CloudPrepRun, stepId: number, body: unknown): Promise<void> { const raw = body && typeof body === 'object' ? body as Record<string, unknown> : {}; const status = raw.status === 'completed' || raw.status === 'failed' ? raw.status : null; const duration = Number(raw.duration_ms); if (!status || !Number.isInteger(duration) || duration < 0) throw new CloudPrepError('步骤结果非法'); const result = await getPostgresSql().unsafe(`UPDATE workspace_prep_agent_steps SET status=$1,summary=$2,duration_ms=$3,output_hash=$4,error_type=$5,finished_at=now() WHERE id=$6 AND run_id=$7 AND status='running' RETURNING id`, [status, clip(raw.summary, 500) || null, duration, clip(raw.output_hash, 64) || null, clip(raw.error_type, 80) || null, stepId, run.id]); if (!result.length) throw new CloudPrepError('步骤不存在或已结束', 409, 'step_conflict') }

export async function persistCloudPrepPlan(run: CloudPrepRun, value: unknown): Promise<{ checklistIds: number[]; plan: PrepPlan }> { const plan = validatePrepPlan(value); if (!['waiting_review', 'committing', 'completed'].includes(run.status)) throw new CloudPrepError('当前运行不在等待确认状态', 409, 'run_state'); if (run.status === 'completed') { const ids = await getPostgresSql().unsafe('SELECT checklist_id FROM workspace_prep_agent_plan_items WHERE run_id=$1 AND checklist_id IS NOT NULL ORDER BY sort', [run.id]) as Array<{ checklist_id: number }>; return { checklistIds: ids.map(r => r.checklist_id), plan: parseJson(run.plan_json, plan) } }
  const context = await cloudPrepContext(run); if (run.snapshot_hash && run.snapshot_hash !== context.snapshot_hash) throw new CloudPrepError('投递、面试或准备清单在生成后发生了变化，请重新生成或重新确认', 409, 'snapshot_changed')
  const valid = new Set(['APP', 'IV', ...(context.resume ? ['RES'] : []), ...context.reviews.map(item => item.ref), ...context.mastery.map(item => item.ref), ...context.projects.map(item => item.ref), ...parseJson<CloudPrepEvidence[]>(run.evidence_json, []).map(item => item.ref)]); const focus = parseCloudPrepConstraints(run.constraints_json).focus.map(normalize); const covered = new Set(plan.items.flatMap(item => item.focus_areas).map(normalize)); for (const item of plan.items) { if (item.evidence_refs.some(ref => !valid.has(ref))) throw new CloudPrepError(`任务“${item.title}”包含无效引用`); } for (const item of focus) if (!covered.has(item)) throw new CloudPrepError('重点方向没有映射到任何准备任务', 422, 'focus_not_covered')
  const evidence = new Map(parseJson<CloudPrepEvidence[]>(run.evidence_json, []).map(item => [item.ref, item])); const ids = await getPostgresSql().begin(async sql => { const existing = await sql.unsafe('SELECT checklist_id FROM workspace_prep_agent_plan_items WHERE run_id=$1 AND checklist_id IS NOT NULL ORDER BY sort', [run.id]) as Array<{ checklist_id: number }>; if (existing.length) return existing.map(item => item.checklist_id); const max = await sql.unsafe('SELECT COALESCE(MAX(sort),0)::integer AS value FROM checklist_items WHERE workspace_id=$1 AND interview_id=$2', [run.workspace_id, run.interview_id]) as Array<{ value: number }>; const result: number[] = []; for (const [index, item] of plan.items.entries()) { const content = `[${item.priority === 'high' ? '高' : item.priority === 'medium' ? '中' : '低'}] ${item.title}（建议${item.estimated_minutes}分钟）`; const check = await sql.unsafe('INSERT INTO checklist_items (workspace_id,interview_id,content,sort) VALUES ($1,$2,$3,$4) RETURNING id', [run.workspace_id, run.interview_id, content, max[0].value + index + 1]) as Array<{ id: number }>; result.push(check[0].id); await sql.unsafe(`INSERT INTO workspace_prep_agent_plan_items (run_id,checklist_id,title,category,priority,estimated_minutes,reason,success_criteria,evidence_json,sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [run.id, check[0].id, item.title, item.category, item.priority, item.estimated_minutes, item.reason, item.success_criteria, JSON.stringify(item.evidence_refs.map(ref => evidence.get(ref) ?? { ref })), index]) } await sql.unsafe(`UPDATE workspace_prep_agent_runs SET status='completed',current_node='finalize',plan_json=$1,updated_at=now(),finished_at=now(),error_type=NULL,error_message=NULL WHERE id=$2`, [JSON.stringify(plan), run.id]); return result }); return { checklistIds: ids, plan } }

export async function cancelCloudPrepRun(run: CloudPrepRun): Promise<void> { if (run.status === 'completed') throw new CloudPrepError('已完成的计划不能取消', 409, 'run_state'); await getPostgresSql().unsafe(`UPDATE workspace_prep_agent_runs SET status='cancelled',current_node='cancelled',updated_at=now(),finished_at=now() WHERE id=$1 AND status<>'completed'`, [run.id]) }
export async function listCloudPrepRuns(workspaceId: string, interviewId: number, limit = 10): Promise<Record<string, unknown>[]> { const rows = await getPostgresSql().unsafe('SELECT id FROM workspace_prep_agent_runs WHERE workspace_id=$1 AND interview_id=$2 ORDER BY created_at DESC LIMIT $3', [workspaceId, interviewId, Math.max(1, Math.min(20, limit))]) as Array<{ id: string }>; return Promise.all(rows.map(row => serializeCloudPrepRun(workspaceId, row.id, false))) }
export async function recoverableCloudPrepRuns(): Promise<Array<{ id: string }>> { return getPostgresSql().unsafe(`SELECT id FROM workspace_prep_agent_runs WHERE status IN ('pending','running','committing') ORDER BY created_at`) as Promise<Array<{ id: string }>> }
