import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import type { NextFunction, Request, Response } from 'express'
import { AiError, completeChat, tutorModel } from '../ai.js'
import { requireWorkspaceId } from '../auth/workspace.js'
import { getPostgresSql } from '../database/client.js'
import { loadPrompt } from '../prompt-loader.js'

/** 云端 AI 助教：会话、消息、引用和反馈均按工作区隔离。 */
export const cloudTutorRouter = Router()
const HISTORY_LIMIT = 40
const HISTORY_CHAR_BUDGET = 12_000
const CONTEXT_LIMIT = 5
const CONTEXT_CHAR_BUDGET = 10_000

type TutorSession = { id: number; workspace_id: string; title: string; created_at: string; updated_at: string }
type TutorMessage = { id: number; session_id: number; role: 'user' | 'assistant'; content: string; created_at: string; request_id: string }
type KnowledgeContext = { item_id: number; source_id: number | null; category: string; mastery: number; company: string; position: string; round: string; question: string; answer: string; score: number; ref: string }

class TutorError extends Error {
  constructor(message: string, readonly statusCode = 422) { super(message) }
}
const route = (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => { handler(req, res).catch(next) }
const positiveId = (value: unknown, label: string): number => { const id = Number(value); if (!Number.isSafeInteger(id) || id <= 0) throw new TutorError(`${label} 非法`, 404); return id }
const text = (value: unknown, maximum: number) => typeof value === 'string' ? value.trim().slice(0, maximum) : ''

async function session(workspaceId: string, id: number): Promise<TutorSession | null> {
  const rows = await getPostgresSql().unsafe('SELECT * FROM workspace_tutor_sessions WHERE workspace_id=$1 AND id=$2', [workspaceId, id]) as TutorSession[]
  return rows[0] ?? null
}

async function citations(workspaceId: string, messageIds: number[]): Promise<Record<number, Array<{ ref: string; item_id: number; source_id: number | null; question: string }>>> {
  if (!messageIds.length) return {}
  const sql = getPostgresSql()
  const rows = await sql.unsafe(`SELECT c.message_id,c.citation_key,i.id AS item_id,i.source_id,i.question
    FROM workspace_tutor_message_citations c
    JOIN workspace_tutor_messages m ON m.id=c.message_id
    JOIN workspace_tutor_sessions s ON s.id=m.session_id
    JOIN knowledge_items i ON i.id=c.knowledge_item_id AND i.workspace_id=s.workspace_id
    WHERE s.workspace_id=$1 AND c.message_id=ANY($2::int[]) ORDER BY c.message_id,c.rank`, [workspaceId, sql.array(messageIds, 23)]) as Array<{ message_id: number; citation_key: string; item_id: number; source_id: number | null; question: string }>
  return rows.reduce<Record<number, Array<{ ref: string; item_id: number; source_id: number | null; question: string }>>>((result, row) => {
    ;(result[row.message_id] ??= []).push({ ref: row.citation_key, item_id: row.item_id, source_id: row.source_id, question: row.question })
    return result
  }, {})
}

async function history(sessionId: number): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const newest = await getPostgresSql().unsafe(`SELECT role,content FROM workspace_tutor_messages WHERE session_id=$1 ORDER BY id DESC LIMIT $2`, [sessionId, HISTORY_LIMIT]) as Array<{ role: 'user' | 'assistant'; content: string }>
  const selected: typeof newest = []; let used = 0
  for (const message of newest) { if (selected.length && used + message.content.length > HISTORY_CHAR_BUDGET) break; selected.push(message); used += message.content.length }
  return selected.reverse()
}

async function retrieve(workspaceId: string, query: string): Promise<KnowledgeContext[]> {
  const sql = getPostgresSql()
  const rows = await sql.unsafe(`SELECT i.id AS item_id,i.source_id,i.category,i.mastery,COALESCE(s.company,'') AS company,
      COALESCE(s.position,'') AS position,COALESCE(s.round,'') AS round,i.question,COALESCE(i.answer,'') AS answer,
      CASE WHEN i.question ILIKE $2 THEN 300 WHEN COALESCE(i.answer,'') ILIKE $2 THEN 100 ELSE 50 END AS score
    FROM knowledge_items i LEFT JOIN knowledge_sources s ON s.id=i.source_id AND s.workspace_id=i.workspace_id
    WHERE i.workspace_id=$1 AND (i.question ILIKE $2 OR COALESCE(i.answer,'') ILIKE $2 OR COALESCE(s.company,'') ILIKE $2 OR COALESCE(s.position,'') ILIKE $2)
    ORDER BY score DESC,i.updated_at DESC LIMIT $3`, [workspaceId, `%${query.slice(0, 500)}%`, CONTEXT_LIMIT * 2]) as Array<Omit<KnowledgeContext, 'ref'>>
  const selected: KnowledgeContext[] = []; let size = 0
  for (const row of rows) {
    const candidate: KnowledgeContext = { ...row, answer: row.answer.slice(0, 2500), ref: `K${selected.length + 1}` }
    const candidateSize = JSON.stringify(candidate).length
    if (selected.length && size + candidateSize > CONTEXT_CHAR_BUDGET) break
    selected.push(candidate); size += candidateSize
    if (selected.length >= CONTEXT_LIMIT) break
  }
  return selected
}

cloudTutorRouter.get('/tutor/sessions', route(async (req, res) => {
  const workspaceId = requireWorkspaceId(req)
  const rows = await getPostgresSql().unsafe(`SELECT s.id,s.title,s.created_at,s.updated_at,
    (SELECT COUNT(*)::int FROM workspace_tutor_messages m WHERE m.session_id=s.id) AS message_count
    FROM workspace_tutor_sessions s WHERE s.workspace_id=$1 ORDER BY s.updated_at DESC`, [workspaceId])
  res.json(rows)
}))

cloudTutorRouter.get('/tutor/sessions/:id', route(async (req, res) => {
  const workspaceId = requireWorkspaceId(req); const item = await session(workspaceId, positiveId(req.params.id, '会话编号'))
  if (!item) throw new TutorError('会话不存在', 404)
  const messages = await getPostgresSql().unsafe('SELECT id,role,content,created_at FROM workspace_tutor_messages WHERE session_id=$1 ORDER BY id', [item.id]) as Array<Omit<TutorMessage, 'session_id' | 'request_id'>>
  const assistantIds = messages.filter(message => message.role === 'assistant').map(message => message.id)
  const [byMessage, feedbackRows] = await Promise.all([
    citations(workspaceId, assistantIds),
    assistantIds.length ? getPostgresSql().unsafe(`SELECT f.message_id,f.value FROM workspace_tutor_message_feedback f JOIN workspace_tutor_messages m ON m.id=f.message_id WHERE m.session_id=$1`, [item.id]) as Promise<Array<{ message_id: number; value: -1 | 1 }>> : Promise.resolve([])
  ])
  const feedback = new Map(feedbackRows.map(row => [row.message_id, row.value]))
  res.json({ session: item, messages: messages.map(message => ({ ...message, citations: byMessage[message.id] ?? [], feedback: feedback.get(message.id) ?? null })) })
}))

cloudTutorRouter.patch('/tutor/sessions/:id', route(async (req, res) => {
  const workspaceId = requireWorkspaceId(req); const id = positiveId(req.params.id, '会话编号'); const title = text(req.body?.title, 50)
  if (!title) throw new TutorError('标题不能为空')
  const rows = await getPostgresSql().unsafe('UPDATE workspace_tutor_sessions SET title=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *', [workspaceId, id, title])
  if (!rows.length) throw new TutorError('会话不存在', 404); res.json(rows[0])
}))

cloudTutorRouter.delete('/tutor/sessions/:id', route(async (req, res) => {
  const workspaceId = requireWorkspaceId(req); const rows = await getPostgresSql().unsafe('DELETE FROM workspace_tutor_sessions WHERE workspace_id=$1 AND id=$2 RETURNING id', [workspaceId, positiveId(req.params.id, '会话编号')])
  if (!rows.length) throw new TutorError('会话不存在', 404); res.json({ ok: true })
}))

cloudTutorRouter.put('/tutor/messages/:id/feedback', route(async (req, res) => {
  const workspaceId = requireWorkspaceId(req); const messageId = positiveId(req.params.id, '消息编号'); const value = Number(req.body?.value)
  if (![0, -1, 1].includes(value)) throw new TutorError('value 只能是 -1、0 或 1')
  const rows = await getPostgresSql().unsafe(`SELECT m.id FROM workspace_tutor_messages m JOIN workspace_tutor_sessions s ON s.id=m.session_id
    WHERE s.workspace_id=$1 AND m.id=$2 AND m.role='assistant'`, [workspaceId, messageId])
  if (!rows.length) throw new TutorError('助教回答不存在', 404)
  const sql = getPostgresSql()
  if (value === 0) { await sql.unsafe('DELETE FROM workspace_tutor_message_feedback WHERE message_id=$1', [messageId]); return void res.json({ message_id: messageId, feedback: null }) }
  await sql.unsafe(`INSERT INTO workspace_tutor_message_feedback(message_id,value) VALUES ($1,$2)
    ON CONFLICT(message_id) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [messageId, value])
  res.json({ message_id: messageId, feedback: value })
}))

cloudTutorRouter.post('/ai/knowledge/tutor', route(async (req, res) => {
  const workspaceId = requireWorkspaceId(req); const content = text(req.body?.content, 10_000)
  if (!content) throw new TutorError('content 不能为空')
  const requestedSessionId = Number(req.body?.session_id) || 0
  if (requestedSessionId && !await session(workspaceId, requestedSessionId)) throw new TutorError('会话不存在，请新开对话', 404)
  const supplied = text(req.body?.request_id, 128); const requestId = /^[a-zA-Z0-9_-]{8,128}$/.test(supplied) ? supplied : randomUUID()
  const sql = getPostgresSql()
  if (requestedSessionId) {
    const replay = await sql.unsafe(`SELECT id,content FROM workspace_tutor_messages WHERE session_id=$1 AND role='assistant' AND request_id=$2`, [requestedSessionId, requestId]) as Array<{ id: number; content: string }>
    if (replay[0]) return void res.json({ session_id: requestedSessionId, assistant_message_id: replay[0].id, reply: replay[0].content, citations: (await citations(workspaceId, [replay[0].id]))[replay[0].id] ?? [], request_id: requestId, replayed: true })
  }
  const [messages, context] = await Promise.all([requestedSessionId ? history(requestedSessionId) : Promise.resolve([]), retrieve(workspaceId, content)])
  const userMessage = context.length ? `<knowledge_context>\n${JSON.stringify(context)}\n</knowledge_context>\n\n<question>\n${content}\n</question>` : `<question>\n${content}\n</question>`
  let completion
  try { completion = await completeChat([{ role: 'system', content: loadPrompt('learn-tutor.system.md') }, ...messages, { role: 'user', content: userMessage }], { task: 'tutor', model: tutorModel() || undefined, skipAudit: true, workspaceId }) }
  catch (error) { throw error instanceof AiError ? error : new TutorError((error as Error).message || 'AI 助教回复失败', 502) }
  const referenced = new Set(Array.from(completion.content.matchAll(/\[K(\d+)\]/g), match => `K${Number(match[1])}`))
  const used = context.filter(item => referenced.has(item.ref))
  const saved = await sql.begin(async transaction => {
    let sessionId = requestedSessionId
    if (!sessionId) {
      const created = await transaction.unsafe('INSERT INTO workspace_tutor_sessions(workspace_id,title) VALUES ($1,$2) RETURNING id', [workspaceId, content.slice(0, 20)]) as Array<{ id: number }>
      sessionId = created[0].id
    }
    await transaction.unsafe(`INSERT INTO workspace_tutor_messages(session_id,role,content,request_id) VALUES ($1,'user',$2,$3)`, [sessionId, content, requestId])
    const assistant = await transaction.unsafe(`INSERT INTO workspace_tutor_messages(session_id,role,content,request_id) VALUES ($1,'assistant',$2,$3) RETURNING id`, [sessionId, completion.content, requestId]) as Array<{ id: number }>
    for (const item of used) await transaction.unsafe(`INSERT INTO workspace_tutor_message_citations(message_id,knowledge_item_id,citation_key,rank,score) VALUES ($1,$2,$3,$4,$5)`, [assistant[0].id, item.item_id, item.ref, Number(item.ref.slice(1)), Math.round(item.score)])
    await transaction.unsafe('UPDATE workspace_tutor_sessions SET updated_at=now() WHERE workspace_id=$1 AND id=$2', [workspaceId, sessionId])
    return { sessionId, assistantMessageId: assistant[0].id }
  })
  res.json({ session_id: saved.sessionId, assistant_message_id: saved.assistantMessageId, reply: completion.content, citations: (await citations(workspaceId, [saved.assistantMessageId]))[saved.assistantMessageId] ?? [], contextCount: context.length, request_id: requestId })
}))

cloudTutorRouter.use((error: Error, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(error)
  const status = error instanceof TutorError ? error.statusCode : error instanceof AiError ? error.statusCode : 500
  res.status(status).json({ message: error.message || 'AI 助教请求失败' })
})
