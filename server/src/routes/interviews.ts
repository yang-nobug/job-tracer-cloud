import { Router } from 'express'
import type { Request, Response } from 'express'
import { getPostgresSql } from '../database/client.js'
import { localDate, parsePositiveId, requireWorkspaceId } from '../auth/workspace.js'
import { STATUS_LABELS, type Status } from '../types.js'
import { canAutomaticallyAdvanceStatus } from '../status-transition.js'

export const interviewsRouter = Router()

const ROUND_TO_STATUS: Record<string, Status> = {
  心理测评: 'assessment', 笔试: 'testing', AI面: 'ai', 一面: 'round1', 二面: 'round2', 三面: 'round3', HR面: 'hr'
}
const fields = 'id, application_id, round, scheduled_at, location, review_file, done::integer AS done, created_at'

async function ownedInterview(workspaceId: string, id: number) {
  const rows = await getPostgresSql().unsafe(`SELECT ${fields} FROM interviews WHERE workspace_id=$1 AND id=$2`, [workspaceId, id]) as Array<{
    id: number; application_id: number; round: string; scheduled_at: string; location: string | null; review_file: string | null; done: number
  }>
  return rows[0] ?? null
}

interviewsRouter.post('/applications/:id/interviews', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const appId = parsePositiveId(req.params.id, '投递编号')
  if (!appId) return res.status(404).json({ message: '记录不存在' })
  const round = typeof req.body?.round === 'string' ? req.body.round.trim() : ''
  const scheduledAt = typeof req.body?.scheduled_at === 'string' ? req.body.scheduled_at.trim() : ''
  if (!round) return res.status(422).json({ message: '轮次不能为空' })
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(scheduledAt)) return res.status(422).json({ message: '时间格式应为 YYYY-MM-DD HH:mm' })
  const sql = getPostgresSql()
  const apps = await sql.unsafe('SELECT id,status FROM applications WHERE workspace_id=$1 AND id=$2', [workspaceId, appId]) as Array<{ id: number; status: Status }>
  const app = apps[0]
  if (!app) return res.status(404).json({ message: '记录不存在' })
  const location = typeof req.body?.location === 'string' ? req.body.location.trim() || null : null
  const created = await sql.unsafe(
    `INSERT INTO interviews (workspace_id,application_id,round,scheduled_at,location) VALUES ($1,$2,$3,$4,$5) RETURNING ${fields}`,
    [workspaceId, appId, round, scheduledAt, location]
  )
  await sql.unsafe(`INSERT INTO application_events (workspace_id,application_id,type,event_date,content) VALUES ($1,$2,'interview',$3,$4)`, [workspaceId, appId, localDate(), `添加面试：${round} ${scheduledAt}${location ? ` @${location}` : ''}`])
  const target = ROUND_TO_STATUS[round]
  if (target && canAutomaticallyAdvanceStatus(app.status, target)) {
    await sql.unsafe('UPDATE applications SET status=$1,updated_at=now() WHERE workspace_id=$2 AND id=$3', [target, workspaceId, appId])
    await sql.unsafe(`INSERT INTO application_events (workspace_id,application_id,type,event_date,content) VALUES ($1,$2,'status',$3,$4)`, [workspaceId, appId, localDate(), `状态：${STATUS_LABELS[app.status]} -> ${STATUS_LABELS[target]}`])
  }
  res.status(201).json(created[0])
})

interviewsRouter.patch('/interviews/:id', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '面试编号')
  if (!id) return res.status(404).json({ message: '面试不存在' })
  const previous = await ownedInterview(workspaceId, id)
  if (!previous) return res.status(404).json({ message: '面试不存在' })
  const round = typeof req.body?.round === 'string' && req.body.round.trim() ? req.body.round.trim() : previous.round
  const requested = req.body?.scheduled_at
  if (requested !== undefined && (typeof requested !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(requested.trim()))) return res.status(422).json({ message: '时间格式应为 YYYY-MM-DD HH:mm' })
  const scheduledAt = typeof requested === 'string' ? requested.trim() : previous.scheduled_at
  const location = req.body?.location === undefined ? previous.location : (typeof req.body.location === 'string' ? req.body.location.trim() || null : null)
  const done = req.body?.done === undefined ? previous.done === 1 : Boolean(req.body.done)
  const rows = await getPostgresSql().unsafe(
    `UPDATE interviews SET round=$1,scheduled_at=$2,location=$3,done=$4 WHERE workspace_id=$5 AND id=$6 RETURNING ${fields}`,
    [round, scheduledAt, location, done, workspaceId, id]
  )
  if (scheduledAt !== previous.scheduled_at) await getPostgresSql().unsafe(
    `INSERT INTO application_events (workspace_id,application_id,type,event_date,content) VALUES ($1,$2,'interview',$3,$4)`,
    [workspaceId, previous.application_id, localDate(), `调整面试时间：${previous.round} ${previous.scheduled_at} -> ${scheduledAt}`]
  )
  res.json(rows[0])
})

interviewsRouter.delete('/interviews/:id', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '面试编号')
  if (!id) return res.status(404).json({ message: '面试不存在' })
  const interview = await ownedInterview(workspaceId, id)
  if (!interview) return res.status(404).json({ message: '面试不存在' })
  await getPostgresSql().unsafe('DELETE FROM interviews WHERE workspace_id=$1 AND id=$2', [workspaceId, id])
  res.json({ ok: true })
})

interviewsRouter.post('/interviews/:id/checklist', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const interviewId = parsePositiveId(req.params.id, '面试编号')
  if (!interviewId || !await ownedInterview(workspaceId, interviewId)) return res.status(404).json({ message: '面试不存在' })
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : ''
  if (!content) return res.status(422).json({ message: '内容不能为空' })
  const rows = await getPostgresSql().unsafe(
    `INSERT INTO checklist_items (workspace_id,interview_id,content,sort)
     VALUES ($1,$2,$3,COALESCE((SELECT MAX(sort)+1 FROM checklist_items WHERE workspace_id=$1 AND interview_id=$2),1))
     RETURNING id,interview_id,content,done::integer AS done,sort`, [workspaceId, interviewId, content]
  )
  res.status(201).json(rows[0])
})

interviewsRouter.patch('/checklist/:id', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '清单编号')
  if (!id) return res.status(404).json({ message: '清单项不存在' })
  const current = await getPostgresSql().unsafe('SELECT id,content,done::integer AS done FROM checklist_items WHERE workspace_id=$1 AND id=$2', [workspaceId, id]) as Array<{ id: number; content: string; done: number }>
  if (!current[0]) return res.status(404).json({ message: '清单项不存在' })
  const content = typeof req.body?.content === 'string' && req.body.content.trim() ? req.body.content.trim() : current[0].content
  const done = req.body?.done === undefined ? current[0].done === 1 : Boolean(req.body.done)
  const rows = await getPostgresSql().unsafe('UPDATE checklist_items SET content=$1,done=$2 WHERE workspace_id=$3 AND id=$4 RETURNING id,interview_id,content,done::integer AS done,sort', [content, done, workspaceId, id])
  res.json(rows[0])
})

interviewsRouter.delete('/checklist/:id', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '清单编号')
  if (!id) return res.status(404).json({ message: '清单项不存在' })
  const rows = await getPostgresSql().unsafe('DELETE FROM checklist_items WHERE workspace_id=$1 AND id=$2 RETURNING id', [workspaceId, id])
  if (!rows.length) return res.status(404).json({ message: '清单项不存在' })
  res.json({ ok: true })
})
