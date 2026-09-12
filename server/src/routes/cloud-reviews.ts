import { Router } from 'express'
import type { Request, Response } from 'express'
import { AiError, completeChat, isAiTaskEnabled, resolveAiTask } from '../ai.js'
import { getPostgresSql } from '../database/client.js'
import { parsePositiveId, requireWorkspaceId } from '../auth/workspace.js'
import { loadPrompt, renderTemplate } from '../prompt-loader.js'

export const cloudReviewsRouter = Router()
const marker = "'cloud-review'"
const text = (value: unknown, maximum: number) => typeof value === 'string' ? value.trim().slice(0, maximum) : ''

async function interview(workspaceId: string, id: number) {
  const rows = await getPostgresSql().unsafe(`SELECT i.id,i.round,i.scheduled_at,a.company,a.position,a.jd_text
    FROM interviews i JOIN applications a ON a.workspace_id=i.workspace_id AND a.id=i.application_id
    WHERE i.workspace_id=$1 AND i.id=$2`, [workspaceId, id]) as Array<{ id: number; round: string; scheduled_at: string; company: string; position: string; jd_text: string | null }>
  return rows[0] ?? null
}

export async function saveCloudInterviewReview(workspaceId: string, interviewId: number, content: string, source = 'manual'): Promise<void> {
  await getPostgresSql().unsafe(`INSERT INTO workspace_interview_reviews (workspace_id,interview_id,content,source)
    VALUES ($1,$2,$3,$4) ON CONFLICT(interview_id) DO UPDATE SET content=EXCLUDED.content,source=EXCLUDED.source,updated_at=now()`, [workspaceId, interviewId, content, source])
}

cloudReviewsRouter.get('/interviews/:id/review', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '面试编号')
  if (!id || !await interview(workspaceId, id)) return res.status(404).json({ message: '面试不存在' })
  const rows = await getPostgresSql().unsafe('SELECT content,source,updated_at FROM workspace_interview_reviews WHERE workspace_id=$1 AND interview_id=$2', [workspaceId, id]) as Array<{ content: string; source: string; updated_at: string }>
  res.json(rows[0] ?? { content: '', source: null, updated_at: null })
})

cloudReviewsRouter.put('/interviews/:id/review', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '面试编号'); const content = text(req.body?.content, 80_000)
  if (!id || !await interview(workspaceId, id)) return res.status(404).json({ message: '面试不存在' })
  if (!content) return res.status(422).json({ message: '复盘内容不能为空' })
  await saveCloudInterviewReview(workspaceId, id, content)
  res.json({ ok: true })
})

cloudReviewsRouter.get('/reviews', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req)
  const rows = await getPostgresSql().unsafe(`SELECT i.id,i.round,i.scheduled_at,i.done::integer AS done,
    CASE WHEN r.id IS NULL THEN NULL ELSE ${marker} END AS review_file,a.id AS application_id,a.company,a.position
    FROM interviews i JOIN applications a ON a.id=i.application_id AND a.workspace_id=i.workspace_id
    LEFT JOIN workspace_interview_reviews r ON r.interview_id=i.id AND r.workspace_id=i.workspace_id
    WHERE i.workspace_id=$1 ORDER BY i.scheduled_at DESC`, [workspaceId])
  res.json(rows)
})

cloudReviewsRouter.post('/ai/review-advice', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = Number(req.body?.interviewId)
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(422).json({ message: 'interviewId 不能为空' })
  const info = await interview(workspaceId, id)
  if (!info) return res.status(404).json({ message: '面试不存在' })
  const rows = await getPostgresSql().unsafe('SELECT content FROM workspace_interview_reviews WHERE workspace_id=$1 AND interview_id=$2', [workspaceId, id]) as Array<{ content: string }>
  const review = rows[0]?.content ?? ''
  if (!review.trim() || review.trim() === review.replace(/[-\s#*:：]/g, '')) return res.status(422).json({ message: '复盘还是空模板，先写点内容再让 AI 点评吧' })
  if (!isAiTaskEnabled('reviewAdvice') || !resolveAiTask('reviewAdvice')) return res.status(422).json({ message: '请先配置可用的复盘点评模型' })
  try {
    const content = renderTemplate(loadPrompt('review-advice.user.md'), { company: info.company, position: info.position, round: info.round, jd: (info.jd_text || '（无）').slice(0, 3000), review: review.slice(0, 6000) })
    const result = await completeChat([{ role: 'system', content: loadPrompt('review-advice.system.md') }, { role: 'user', content }], { task: 'reviewAdvice', skipAudit: true, workspaceId })
    res.json({ advice: result.content })
  } catch (error) { res.status(error instanceof AiError ? error.statusCode : 502).json({ message: (error as Error).message || 'AI 点评失败' }) }
})
