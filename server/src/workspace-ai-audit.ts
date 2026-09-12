import { createHash } from 'node:crypto'
import { getPostgresSql } from './database/client.js'
import type { AiCompletionResult, AiTask, ChatMessage, CompletionOptions } from './ai.js'

const MAX_AUDIT_TEXT = 200_000

function clip(value: string): string {
  return value.length <= MAX_AUDIT_TEXT ? value : `${value.slice(0, MAX_AUDIT_TEXT)}\n\n[日志截断：原内容超过 ${MAX_AUDIT_TEXT} 字符]`
}

function json(value: unknown): string | null {
  if (value === undefined) return null
  try { return clip(JSON.stringify(value)) } catch { return JSON.stringify({ unavailable: true }) }
}

/** 图片内容不会落库。审计只保留 data URL 的哈希与长度，便于排查请求而不保存原图。 */
function messagesForAudit(messages: ChatMessage[]): string {
  return clip(JSON.stringify(messages.map(message => ({
    role: message.role,
    content: Array.isArray(message.content)
      ? message.content.map(part => part.type === 'text' ? part : {
          type: 'image_url', image_url: {
            stored: false,
            sha256: createHash('sha256').update(part.image_url.url).digest('hex'),
            byte_length: part.image_url.url.length
          }
        })
      : message.content
  }))))
}

export async function writeWorkspaceAiCall(entry: {
  workspaceId: string
  task: AiTask
  stage: string
  attempt: number
  promptHash: string
  messages: ChatMessage[]
  options: CompletionOptions
  result?: AiCompletionResult
  error?: Error
  durationMs: number
}): Promise<number | null> {
  try {
    const requestOptions = {
      output_mode: entry.options.outputMode ?? null,
      temperature: entry.options.temperature ?? null,
      max_output_tokens: entry.options.maxOutputTokens ?? null,
      timeout_ms: entry.options.timeoutMs ?? null,
      thinking: entry.options.thinking ?? null,
      image_count: entry.messages.reduce((count, message) => count + (Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url').length : 0), 0)
    }
    const rows = await getPostgresSql().unsafe(`INSERT INTO workspace_ai_call_records (
      workspace_id,task,stage,attempt,retry_of_call_id,model,prompt_hash,provider_request_id,
      request_messages_json,response_schema_json,request_options_json,raw_response,status,
      error_type,error_message,duration_ms,finish_reason,prompt_tokens,completion_tokens,total_tokens,
      provider_attempts,created_at,finished_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,now(),now()) RETURNING id`, [
      entry.workspaceId, entry.task, entry.stage, entry.attempt, entry.options.audit?.retryOfCallId ?? null, entry.result?.model ?? entry.options.model ?? null,
      entry.promptHash, entry.result?.requestId ?? null, messagesForAudit(entry.messages),
      json(entry.options.responseSchema?.schema), json(requestOptions), entry.result ? clip(entry.result.content) : null,
      entry.error ? 'provider_failed' : 'succeeded',
      typeof (entry.error as unknown as { kind?: unknown } | undefined)?.kind === 'string' ? (entry.error as unknown as { kind: string }).kind : entry.error ? 'unexpected' : null,
      entry.error ? clip(entry.error.message) : null, entry.result?.durationMs ?? entry.durationMs,
      entry.result?.finishReason ?? null, entry.result?.usage?.promptTokens ?? null,
      entry.result?.usage?.completionTokens ?? null, entry.result?.usage?.totalTokens ?? null,
      entry.result?.providerAttempts ?? null
    ]) as Array<{ id: number }>
    // 每个工作区独立保留最近 2000 条，防止长期运行无界增长。
    await getPostgresSql().unsafe('DELETE FROM workspace_ai_call_records WHERE workspace_id=$1 AND id NOT IN (SELECT id FROM workspace_ai_call_records WHERE workspace_id=$1 ORDER BY id DESC LIMIT 2000)', [entry.workspaceId])
    return rows[0]?.id ?? null
  } catch (error) {
    console.error('写入工作区 AI 调用审计记录失败:', (error as Error).message)
    return null
  }
}

export async function updateWorkspaceAiCall(id: number | undefined, workspaceId: string | undefined, values: { status: 'succeeded' | 'validation_failed'; parsed?: unknown; validated?: unknown; error?: Error }): Promise<void> {
  if (!id || !workspaceId) return
  try {
    await getPostgresSql().unsafe(`UPDATE workspace_ai_call_records SET status=$1,parsed_response_json=$2,validated_response_json=$3,error_type=$4,error_message=$5,finished_at=now() WHERE id=$6 AND workspace_id=$7`, [
      values.status, json(values.parsed), json(values.validated), values.error ? 'validation' : null,
      values.error ? clip(values.error.message) : null, id, workspaceId
    ])
  } catch (error) { console.error('更新工作区 AI 调用审计记录失败:', (error as Error).message) }
}
