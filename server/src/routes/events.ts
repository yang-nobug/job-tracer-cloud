import { Router } from 'express'
import type { Request, Response } from 'express'
import { getPostgresSql } from '../database/client.js'
import { localDate, parsePositiveId, requireWorkspaceId } from '../auth/workspace.js'

export const eventsRouter = Router()

eventsRouter.post('/applications/:id/events', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const applicationId = parsePositiveId(req.params.id, '投递编号')
  if (!applicationId) return res.status(404).json({ message: '记录不存在' })
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : ''
  if (!content) return res.status(422).json({ message: '内容不能为空' })
  const apps = await getPostgresSql().unsafe('SELECT id FROM applications WHERE workspace_id=$1 AND id=$2', [workspaceId, applicationId])
  if (!apps.length) return res.status(404).json({ message: '记录不存在' })
  const type = ['note', 'status', 'interview', 'other'].includes(req.body?.type) ? req.body.type : 'note'
  const eventDate = typeof req.body?.event_date === 'string' && req.body.event_date ? req.body.event_date : localDate()
  const rows = await getPostgresSql().unsafe(
    `INSERT INTO application_events (workspace_id,application_id,type,event_date,content) VALUES ($1,$2,$3,$4,$5)
     RETURNING id,application_id,type,event_date,content,created_at`, [workspaceId, applicationId, type, eventDate, content]
  )
  res.status(201).json(rows[0])
})

eventsRouter.delete('/events/:id', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '动态编号')
  if (!id) return res.status(404).json({ message: '事件不存在' })
  const rows = await getPostgresSql().unsafe('DELETE FROM application_events WHERE workspace_id=$1 AND id=$2 RETURNING id', [workspaceId, id])
  if (!rows.length) return res.status(404).json({ message: '事件不存在' })
  res.json({ ok: true })
})
