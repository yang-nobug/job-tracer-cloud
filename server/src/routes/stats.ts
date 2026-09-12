import { Router } from 'express'
import type { Request, Response } from 'express'
import { getPostgresSql } from '../database/client.js'
import { requireWorkspaceId } from '../auth/workspace.js'
import { STATUS_ORDER, type Status } from '../types.js'

export const statsRouter = Router()

const statusRank = (status: string) => Math.max(0, (STATUS_ORDER as readonly string[]).indexOf(status))

statsRouter.get('/stats', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req)
  const sql = getPostgresSql()
  const apps = await sql.unsafe('SELECT id,status,applied_at,rejected_at,channel FROM applications WHERE workspace_id=$1', [workspaceId]) as Array<{
    id: number; status: Status; applied_at: string | null; rejected_at: string | null; channel: string | null
  }>
  const interviewRows = await sql.unsafe('SELECT application_id,round FROM interviews WHERE workspace_id=$1', [workspaceId]) as Array<{ application_id: number; round: string }>
  const stageApps = new Map<string, Set<number>>()
  for (const row of interviewRows) {
    if (!stageApps.has(row.round)) stageApps.set(row.round, new Set())
    stageApps.get(row.round)!.add(row.application_id)
  }
  const statusRound: Partial<Record<Status, string>> = { assessment: '心理测评', testing: '笔试', ai: 'AI面', round1: '一面', round2: '二面', round3: '三面', hr: 'HR面' }
  for (const app of apps) {
    const round = statusRound[app.status]
    if (!round) continue
    if (!stageApps.has(round)) stageApps.set(round, new Set())
    stageApps.get(round)!.add(app.id)
  }
  const stages = ['心理测评', '笔试', 'AI面', '一面', '二面', '三面', 'HR面'].map(name => ({ name, value: stageApps.get(name)?.size ?? 0 }))
  const other = stageApps.get('其他')?.size
  if (other) stages.push({ name: '其他', value: other })
  const applied = apps.filter(app => app.status !== 'unsent' && app.applied_at)
  const rejected = apps.filter(app => app.rejected_at)
  const offers = apps.filter(app => app.status === 'offer' && !app.rejected_at)
  const active = applied.filter(app => !app.rejected_at && app.status !== 'offer')
  const weekly: Array<{ week: string; count: number }> = []
  const current = new Date()
  const format = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  for (let index = 7; index >= 0; index--) {
    const start = new Date(current.getFullYear(), current.getMonth(), current.getDate() - current.getDay() + 1 - index * 7)
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7)
    const day = format(start); const nextDay = format(end)
    weekly.push({ week: day.slice(5), count: applied.filter(app => app.applied_at! >= day && app.applied_at! < nextDay).length })
  }
  const channelMap = new Map<string, number>()
  for (const app of applied) channelMap.set(app.channel || '未填写', (channelMap.get(app.channel || '未填写') ?? 0) + 1)
  res.json({
    cards: { total: apps.length, active: active.length, rejected: rejected.length, offer: offers.length },
    funnel: [
      { name: '投递', value: applied.length },
      { name: '面试', value: applied.filter(app => statusRank(app.status) >= statusRank('round1')).length },
      { name: '终面', value: applied.filter(app => statusRank(app.status) >= statusRank('round3')).length },
      { name: 'Offer', value: apps.filter(app => app.status === 'offer').length }
    ],
    stages, weekly, channels: [...channelMap.entries()].map(([name, value]) => ({ name, value }))
  })
})

statsRouter.get('/meta', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req)
  const companies = await getPostgresSql().unsafe(
    'SELECT company,MAX(location) AS location,MAX(channel) AS channel,COUNT(*)::integer AS count FROM applications WHERE workspace_id=$1 GROUP BY company ORDER BY count DESC', [workspaceId]
  )
  res.json({ companies })
})

statsRouter.get('/upcoming', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req)
  const date = new Date(); const pad = (value: number) => String(value).padStart(2, '0')
  const now = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  const rows = await getPostgresSql().unsafe(
    `SELECT i.id,i.round,i.scheduled_at,i.location,a.id AS application_id,a.company,a.position
     FROM interviews i JOIN applications a ON a.workspace_id=i.workspace_id AND a.id=i.application_id
     WHERE i.workspace_id=$1 AND i.done=false AND i.scheduled_at >= $2 ORDER BY i.scheduled_at ASC LIMIT 30`, [workspaceId, now]
  ) as Array<Record<string, unknown> & { id: number; round: string; scheduled_at: string }>
  res.json(rows.map(row => ({
    ...row, key: `interview:${row.id}`, kind: 'interview', title: row.round, event_type: 'interview', time_mode: 'fixed', due_at: row.scheduled_at,
    due_kind: 'scheduled', window_start_at: null, window_end_at: null, deadline_at: null, duration_minutes: null
  })))
})
