import { Router } from 'express'
import type { Request, Response } from 'express'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { AiError, completeStructured, type ChatContent, visionArkModel } from '../ai.js'
import { ANSWER_GENERATION_SCHEMA, KNOWLEDGE_EXTRACTION_SCHEMA, validateAnswerGeneration, validateKnowledgeExtraction } from '../ai-contracts.js'
import { loadPrompt } from '../prompt-loader.js'
import { getPostgresSql } from '../database/client.js'
import { parsePositiveId, requireWorkspaceId } from '../auth/workspace.js'
import { WORKSPACE_KNOWLEDGE_IMAGES_DIR } from '../data-paths.js'

/** 已迁入云端的知识库 AI。调用不写入旧 SQLite 审计库，避免跨工作区保存材料。 */
export const cloudKnowledgeAiRouter = Router()
const EXTRACT_MAX_TEXT = 10_000
const ANSWER_BATCH_LIMIT = 5

function sendAiError(res: Response, error: unknown): void {
  const err = error as Error
  res.status(err instanceof AiError ? err.statusCode : 502).json({ message: err.message || 'AI 处理失败' })
}
function workspaceImagePath(workspaceId: string, name: string): string {
  return path.join(WORKSPACE_KNOWLEDGE_IMAGES_DIR, workspaceId, path.basename(name))
}

cloudKnowledgeAiRouter.post('/ai/knowledge/extract-text', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req)
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
  if (!text) return res.status(422).json({ message: 'text 不能为空' })
  try {
    const { value } = await completeStructured([
      { role: 'system', content: `${loadPrompt('knowledge-extract.system.md')}\n\nJSON Schema:\n${JSON.stringify(KNOWLEDGE_EXTRACTION_SCHEMA)}` },
      { role: 'user', content: `<untrusted_interview_material>\n${text.slice(0, EXTRACT_MAX_TEXT)}\n</untrusted_interview_material>` }
    ], { task: 'knowledgeExtract', schemaName: 'knowledge_extraction', schema: KNOWLEDGE_EXTRACTION_SCHEMA, validate: validateKnowledgeExtraction, skipAudit: true, workspaceId })
    res.json(value)
  } catch (error) { sendAiError(res, error) }
})

cloudKnowledgeAiRouter.post('/ai/knowledge/extract-image', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.body?.image_id, '截图编号')
  if (!id) return res.status(404).json({ message: '截图不存在' })
  const rows = await getPostgresSql().unsafe('SELECT stored_name,inference_stored_name,inference_mime FROM knowledge_images WHERE workspace_id=$1 AND id=$2', [workspaceId, id]) as Array<{ stored_name: string; inference_stored_name: string | null; inference_mime: string | null }>
  const image = rows[0]; if (!image) return res.status(404).json({ message: '截图不存在' })
  const name = image.inference_stored_name ?? image.stored_name; const file = workspaceImagePath(workspaceId, name)
  if (!existsSync(file)) return res.status(404).json({ message: '截图文件已丢失' })
  const model = visionArkModel(); if (!model) return res.status(422).json({ message: '当前模型不支持图片输入，请在 config.json 配置 vision: true 的模型' })
  const ext = path.extname(name).toLowerCase(); const mime = image.inference_mime ?? ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.bmp': 'image/bmp' }[ext] ?? 'image/png')
  const content: ChatContent = [{ type: 'image_url', image_url: { url: `data:${mime};base64,${readFileSync(file).toString('base64')}` } }, { type: 'text', text: '请从这张面试题截图中拆出题目列表。' }]
  try {
    const { value } = await completeStructured([
      { role: 'system', content: `${loadPrompt('knowledge-extract.system.md')}\n\nJSON Schema:\n${JSON.stringify(KNOWLEDGE_EXTRACTION_SCHEMA)}` },
      { role: 'user', content }
    ], { task: 'knowledgeExtract', model, schemaName: 'knowledge_extraction', schema: KNOWLEDGE_EXTRACTION_SCHEMA, validate: validateKnowledgeExtraction, skipAudit: true, workspaceId })
    res.json(value)
  } catch (error) { sendAiError(res, error) }
})

cloudKnowledgeAiRouter.post('/ai/knowledge/generate-answers', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req)
  const ids: number[] = Array.isArray(req.body?.ids) ? Array.from(new Set(req.body.ids.map(Number).filter((id): id is number => Number.isSafeInteger(id) && id > 0))) : []
  const mode = req.body?.mode === 'replace' ? 'replace' : 'missing'
  const expected = req.body?.expected_updated_at && typeof req.body.expected_updated_at === 'object' && !Array.isArray(req.body.expected_updated_at) ? req.body.expected_updated_at as Record<string, unknown> : {}
  if (!ids.length) return res.status(422).json({ message: 'ids 不能为空' }); if (ids.length > ANSWER_BATCH_LIMIT) return res.status(422).json({ message: `单批最多 ${ANSWER_BATCH_LIMIT} 条` })
  // PostgreSQL int4 的 OID 为 23；显式标注避免驱动把 JS 数组当 JSON。
  const sql = getPostgresSql(); const idsParameter = sql.array(ids, 23)
  const rows = await sql.unsafe(`SELECT i.id,i.question,i.answer,i.category,i.updated_at,COALESCE(s.company,'') AS company,COALESCE(s.position,'') AS position,COALESCE(s.round,'') AS round
    FROM knowledge_items i LEFT JOIN knowledge_sources s ON s.id=i.source_id AND s.workspace_id=i.workspace_id
    WHERE i.workspace_id=$1 AND i.id=ANY($2::int[])`, [workspaceId, idsParameter]) as Array<{ id: number; question: string; answer: string | null; category: string; updated_at: string; company: string; position: string; round: string }>
  if (rows.length !== ids.length) return res.status(404).json({ message: '部分题目不存在' })
  const todo = mode === 'replace' ? rows : rows.filter(item => !item.answer?.trim())
  if (!todo.length) return res.json({ items: [], generated: 0, mode })
  for (const item of todo) if (Object.hasOwn(expected, String(item.id)) && expected[String(item.id)] !== item.updated_at) return res.status(409).json({ message: '这条题目已被其他操作更新，请刷新后再重新生成', error_type: 'knowledge_item_conflict' })
  try {
    const questionList = todo.map(item => ({ id: item.id, question: item.question, category: item.category, source: { company: item.company || null, position: item.position || null, round: item.round || null } }))
    const { value, completion } = await completeStructured([
      { role: 'system', content: `${loadPrompt('knowledge-answer.system.md')}\n\nJSON Schema:\n${JSON.stringify(ANSWER_GENERATION_SCHEMA)}` },
      { role: 'user', content: `<untrusted_questions>\n${JSON.stringify(questionList)}\n</untrusted_questions>` }
    ], { task: 'answerGenerate', schemaName: 'knowledge_answers', schema: ANSWER_GENERATION_SCHEMA, validate: result => validateAnswerGeneration(result, todo.map(item => item.id)), skipAudit: true, workspaceId })
    const answers = new Map(value.answers.map(answer => [answer.id, answer.answer]))
    const refreshed = await sql.begin(async transaction => {
      for (const item of todo) {
        const answer = answers.get(item.id); if (!answer || answer === item.answer) continue
        if (mode === 'replace' && item.answer?.trim()) await transaction.unsafe('INSERT INTO knowledge_answer_versions (workspace_id,knowledge_item_id,answer,reason,model) VALUES ($1,$2,$3,$4,$5)', [workspaceId, item.id, item.answer, 'before_ai_regenerate', completion.model])
        const updated = await transaction.unsafe('UPDATE knowledge_items SET answer=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND updated_at=$4::timestamptz RETURNING id', [workspaceId, item.id, answer, item.updated_at])
        if (!updated.length) throw new Error('knowledge_item_conflict')
      }
      return transaction.unsafe('SELECT * FROM knowledge_items WHERE workspace_id=$1 AND id=ANY($2::int[])', [workspaceId, transaction.array(ids, 23)])
    })
    res.json({ items: refreshed, generated: value.answers.length, mode })
  } catch (error) {
    if ((error as Error).message === 'knowledge_item_conflict') return res.status(409).json({ message: '生成期间题目内容已变化，请刷新后再试', error_type: 'knowledge_item_conflict' })
    sendAiError(res, error)
  }
})
