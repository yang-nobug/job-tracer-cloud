import { Router } from 'express'
import type { Request, Response } from 'express'
import { requireWorkspaceId } from '../auth/workspace.js'
import { getPostgresSql } from '../database/client.js'

export const cloudObservabilityRouter = Router()

type CloudRun = { id: string; trace_id: string; operation_type: string; trigger_type: string; status: string; error_code: string | null; error_message: string | null; started_at: string; duration_ms: number | null }
const limit = (value: unknown) => Number.isFinite(Number(value)) ? Math.max(1, Math.min(100, Math.floor(Number(value)))) : 50
const status = (value: string) => value === 'done' || value === 'completed' || value === 'succeeded' ? 'succeeded' : value === 'failed' ? 'failed' : value

function requireAdmin(req: Request, res: Response): boolean {
  if (req.auth?.isAdmin) return true
  res.status(403).json({ message: '仅平台管理员可查看运行日志' })
  return false
}

async function list(workspaceId: string, maximum: number): Promise<CloudRun[]> {
  const sql = getPostgresSql()
  const [ai, recordings, prep, mail] = await Promise.all([
    sql.unsafe(`SELECT 'ai:' || id AS id,COALESCE(provider_request_id,'ai-' || id) AS trace_id,
      'AI · ' || task || ' / ' || stage AS operation_type,'model' AS trigger_type,status,error_type AS error_code,error_message,
      created_at AS started_at,duration_ms FROM workspace_ai_call_records WHERE workspace_id=$1 ORDER BY id DESC LIMIT $2`, [workspaceId, maximum]),
    sql.unsafe(`SELECT 'recording:' || id AS id,'recording-' || id AS trace_id,'录音复盘 · ' || filename AS operation_type,
      'upload' AS trigger_type,status,error AS error_code,error AS error_message,created_at AS started_at,
      CASE WHEN status IN ('done','failed') THEN (EXTRACT(EPOCH FROM updated_at-created_at)*1000)::integer ELSE NULL END AS duration_ms
      FROM workspace_recordings WHERE workspace_id=$1 ORDER BY id DESC LIMIT $2`, [workspaceId, maximum]),
    sql.unsafe(`SELECT 'prep:' || id AS id,id::text AS trace_id,'面试准备 Agent' AS operation_type,'manual' AS trigger_type,status,error_type AS error_code,error_message,created_at AS started_at,
      CASE WHEN finished_at IS NOT NULL THEN (EXTRACT(EPOCH FROM finished_at-created_at)*1000)::integer ELSE NULL END AS duration_ms
      FROM workspace_prep_agent_runs WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT $2`, [workspaceId, maximum]),
    sql.unsafe(`SELECT 'mail:' || a.candidate_id AS id,'mail-' || a.candidate_id AS trace_id,'招聘邮件 AI 识别' AS operation_type,
      'mail' AS trigger_type,a.status,a.error_code,a.error_code AS error_message,a.updated_at AS started_at,NULL::integer AS duration_ms
      FROM workspace_mail_candidate_analyses a WHERE a.workspace_id=$1 ORDER BY a.updated_at DESC LIMIT $2`, [workspaceId, maximum])
  ])
  return [...ai, ...recordings, ...prep, ...mail].map(item => ({ ...(item as unknown as CloudRun), status: status(String(item.status)) } as CloudRun)).sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, maximum)
}

cloudObservabilityRouter.get('/observability/runs', async (req: Request, res: Response) => {
  res.json(await list(requireWorkspaceId(req), limit(req.query.limit)))
})

cloudObservabilityRouter.get('/observability/runs/:key', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const [kind, rawId] = String(req.params.key).split(':', 2)
  if (!kind || !rawId) return void res.status(422).json({ message: '运行记录编号无效' })
  const sql = getPostgresSql(); let run: CloudRun | null = null; let steps: unknown[] = []; let aiCalls: unknown[] = []
  if (kind === 'ai' && /^\d+$/.test(rawId)) {
    const rows = await sql.unsafe(`SELECT 'ai:' || id AS id,COALESCE(provider_request_id,'ai-' || id) AS trace_id,'AI · ' || task || ' / ' || stage AS operation_type,'model' AS trigger_type,status,error_type AS error_code,error_message,created_at AS started_at,duration_ms FROM workspace_ai_call_records WHERE workspace_id=$1 AND id=$2`, [workspaceId, Number(rawId)])
    run = rows[0] ? { ...(rows[0] as unknown as CloudRun), status: status(String((rows[0] as any).status)) } : null
    aiCalls = rows
  } else if (kind === 'recording' && /^\d+$/.test(rawId)) {
    const rows = await sql.unsafe(`SELECT 'recording:' || id AS id,'recording-' || id AS trace_id,'录音复盘 · ' || filename AS operation_type,'upload' AS trigger_type,status,error AS error_code,error AS error_message,created_at AS started_at,CASE WHEN status IN ('done','failed') THEN (EXTRACT(EPOCH FROM updated_at-created_at)*1000)::integer ELSE NULL END AS duration_ms FROM workspace_recordings WHERE workspace_id=$1 AND id=$2`, [workspaceId, Number(rawId)])
    run = rows[0] ? { ...(rows[0] as unknown as CloudRun), status: status(String((rows[0] as any).status)) } : null
    steps = await sql.unsafe(`SELECT chunk_index AS id,'分段 ' || (chunk_index+1) AS step_name,status,updated_at AS started_at,NULL::integer AS duration_ms,error AS error_code,error AS error_message FROM workspace_recording_analysis_chunks WHERE recording_id=$1 ORDER BY chunk_index`, [Number(rawId)])
  } else if (kind === 'prep' && /^[a-f0-9-]{36}$/i.test(rawId)) {
    const rows = await sql.unsafe(`SELECT 'prep:' || id AS id,id::text AS trace_id,'面试准备 Agent' AS operation_type,'manual' AS trigger_type,status,error_type AS error_code,error_message,created_at AS started_at,CASE WHEN finished_at IS NOT NULL THEN (EXTRACT(EPOCH FROM finished_at-created_at)*1000)::integer ELSE NULL END AS duration_ms FROM workspace_prep_agent_runs WHERE workspace_id=$1 AND id=$2`, [workspaceId, rawId])
    run = rows[0] ? { ...(rows[0] as unknown as CloudRun), status: status(String((rows[0] as any).status)) } : null
    steps = await sql.unsafe(`SELECT id,node AS step_name,status,created_at AS started_at,duration_ms,error_type AS error_code,NULL::text AS error_message FROM workspace_prep_agent_steps WHERE run_id=$1 ORDER BY id`, [rawId])
  } else if (kind === 'mail' && /^\d+$/.test(rawId)) {
    const rows = await sql.unsafe(`SELECT 'mail:' || candidate_id AS id,'mail-' || candidate_id AS trace_id,'招聘邮件 AI 识别' AS operation_type,'mail' AS trigger_type,status,error_code,error_code AS error_message,updated_at AS started_at,NULL::integer AS duration_ms FROM workspace_mail_candidate_analyses WHERE workspace_id=$1 AND candidate_id=$2`, [workspaceId, Number(rawId)])
    run = rows[0] ? { ...(rows[0] as unknown as CloudRun), status: status(String((rows[0] as any).status)) } : null
    aiCalls = run ? await sql.unsafe(`SELECT id,task,stage,attempt,model,status,duration_ms,total_tokens,created_at FROM workspace_ai_call_records WHERE workspace_id=$1 AND created_at >= $2::timestamptz - interval '5 minutes' AND created_at <= $2::timestamptz + interval '5 minutes' ORDER BY id`, [workspaceId, run.started_at]) : []
  }
  if (!run) return void res.status(404).json({ message: '运行记录不存在' })
  res.json({ run, steps, logs: [], aiCalls })
})

cloudObservabilityRouter.get('/observability/logs', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return
  const maximum = Number.isFinite(Number(req.query.limit)) ? Math.max(1, Math.min(200, Math.floor(Number(req.query.limit)))) : 100
  const level = typeof req.query.level === 'string' && ['debug', 'info', 'warn', 'error'].includes(req.query.level) ? req.query.level : null
  const traceId = typeof req.query.trace_id === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(req.query.trace_id) ? req.query.trace_id : null
  const source = typeof req.query.source === 'string' ? req.query.source.trim().slice(0, 80) || null : null
  const rows = await getPostgresSql().unsafe(`SELECT id,level,source,event_name,trace_id,operation_run_id,operation_step_id,entity_type,entity_id,message,context_json,error_code,created_at
    FROM platform_system_logs
    WHERE ($1::text IS NULL OR level=$1) AND ($2::text IS NULL OR trace_id=$2) AND ($3::text IS NULL OR source=$3)
    ORDER BY id DESC LIMIT $4`, [level, traceId, source, maximum])
  res.json(rows)
})

cloudObservabilityRouter.delete('/observability/logs', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return
  if (req.query.scope === 'all') await getPostgresSql().unsafe('DELETE FROM platform_system_logs')
  else if (req.query.scope === 'info') await getPostgresSql().unsafe("DELETE FROM platform_system_logs WHERE level IN ('debug','info')")
  else return void res.status(422).json({ message: '仅支持 scope=info 或 scope=all' })
  res.json({ ok: true })
})
