import { Router } from 'express'
import type { Request, Response } from 'express'
import { requireWorkspaceId } from '../auth/workspace.js'
import { getPostgresSql } from '../database/client.js'

export const cloudAiAuditRouter = Router()

function limit(value: unknown, fallback = 30): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(1, Math.min(200, Math.floor(parsed))) : fallback
}

/** 复用 AI 数据说明页所需字段，但只返回当前会话所属工作区的记录。 */
cloudAiAuditRouter.get('/ai/calls', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req)
  const rows = await getPostgresSql().unsafe(`SELECT id,task,stage,attempt,retry_of_call_id,model,provider_request_id,provider_attempts,
    status,error_type,error_message,duration_ms,finish_reason,prompt_tokens,completion_tokens,total_tokens,created_at
    FROM workspace_ai_call_records WHERE workspace_id=$1 ORDER BY id DESC LIMIT $2`, [workspaceId, limit(req.query.limit)])
  res.json(rows)
})

cloudAiAuditRouter.get('/ai/calls/:id', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req)
  const id = Number(req.params.id)
  if (!Number.isSafeInteger(id) || id <= 0) return void res.status(422).json({ message: 'AI 调用记录编号无效' })
  const rows = await getPostgresSql().unsafe(`SELECT id,task,stage,attempt,retry_of_call_id,model,prompt_hash,provider_request_id,provider_attempts,
    request_messages_json,response_schema_json,request_options_json,raw_response,parsed_response_json,
    validated_response_json,status,error_type,error_message,duration_ms,finish_reason,prompt_tokens,
    completion_tokens,total_tokens,created_at,finished_at FROM workspace_ai_call_records WHERE workspace_id=$1 AND id=$2`, [workspaceId, id])
  if (!rows.length) return void res.status(404).json({ message: 'AI 调用记录不存在' })
  res.json(rows[0])
})
