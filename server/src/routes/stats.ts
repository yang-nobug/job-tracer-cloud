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
  // 顶部提示会明确标记今天已过的安排为「进行中/已过」，因此不能在服务端把
  // 今天较早的记录过滤掉。只按日期过滤也能避免不同历史库中 varchar/timestamptz
  // 时间字段与当前时间字符串直接比较造成类型冲突。
  const today = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const rows = await getPostgresSql().unsafe(
    `SELECT i.id,i.round,LEFT(i.scheduled_at::text,16) AS scheduled_at,i.location,a.id AS application_id,a.company,a.position
     FROM interviews i JOIN applications a ON a.workspace_id=i.workspace_id AND a.id=i.application_id
     WHERE i.workspace_id=$1 AND i.done=false AND i.scheduled_at::text >= $2
     ORDER BY i.scheduled_at ASC LIMIT 30`, [workspaceId, today]
  ) as Array<Record<string, unknown> & { id: number; round: string; scheduled_at: string }>
  const interviews = rows.map(row => ({
    ...row, key: `interview:${row.id}`, kind: 'interview', title: row.round, event_type: 'interview', time_mode: 'fixed', due_at: row.scheduled_at,
    due_kind: 'scheduled', window_start_at: null, window_end_at: null, deadline_at: null, duration_minutes: null
  }))
  // 邮箱 AI 复核后自动创建的招聘日程同样进入顶部提醒；没有关联投递时前端会打开日程页。
  const schedules = await getPostgresSql().unsafe(
    `SELECT id,application_id,title,company,position,location,event_type,time_mode,
       LEFT(scheduled_at::text,16) AS scheduled_at,
       LEFT(window_start_at::text,16) AS window_start_at,
       LEFT(window_end_at::text,16) AS window_end_at,
       LEFT(deadline_at::text,16) AS deadline_at,
       duration_minutes,
       CASE
         WHEN scheduled_at IS NOT NULL THEN LEFT(scheduled_at::text,16)
         WHEN window_end_at IS NOT NULL THEN LEFT(window_end_at::text,16)
         ELSE LEFT(deadline_at::text,16)
       END AS due_at
     FROM workspace_recruitment_schedules WHERE workspace_id=$1 AND status='active'
       AND CASE
         WHEN scheduled_at IS NOT NULL THEN scheduled_at::text
         WHEN window_end_at IS NOT NULL THEN window_end_at::text
         ELSE deadline_at::text
       END >= $2
     ORDER BY CASE
       WHEN scheduled_at IS NOT NULL THEN scheduled_at::text
       WHEN window_end_at IS NOT NULL THEN window_end_at::text
       ELSE deadline_at::text
     END ASC LIMIT 30`, [workspaceId, today]
  ) as Array<Record<string, unknown> & { id: number; title: string; event_type: string; time_mode: string }>
  const mailSchedules = schedules.map(row => ({
    ...row, key: `mail-schedule:${row.id}`, kind: 'schedule',
    due_kind: row.scheduled_at ? 'scheduled' : row.window_end_at ? 'window_end' : 'deadline'
  }))
  res.json([...interviews, ...mailSchedules].sort((left, right) => String(left.due_at).localeCompare(String(right.due_at))).slice(0, 30))
})
