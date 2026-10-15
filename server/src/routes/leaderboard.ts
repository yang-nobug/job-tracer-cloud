import { Router } from 'express'
import type { Request, Response } from 'express'
import { getPostgresSql } from '../database/client.js'
import { requireSharedJobsConsent } from './shared-jobs.js'

/**
 * 投递数量榜只聚合已同意共享岗位的账号，不返回公司、岗位、链接或投递进度。
 * 一个账号默认拥有一个 owner 工作区；只统计 owner 工作区，避免团队成员被重复计数。
 */
export const leaderboardRouter = Router()

type Period = 'week' | 'month' | 'all'
type LeaderboardRow = {
  user_id: string
  display_name: string
  application_count: number
  rank: number
}

function chinaDay(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now)
  const value = (name: string) => parts.find(part => part.type === name)?.value ?? '00'
  return `${value('year')}-${value('month')}-${value('day')}`
}

function addDays(day: string, amount: number): string {
  const value = new Date(`${day}T00:00:00+08:00`)
  value.setUTCDate(value.getUTCDate() + amount)
  return value.toISOString().slice(0, 10)
}

function periodStart(period: Period, today = chinaDay()): string | null {
  if (period === 'all') return null
  if (period === 'month') return `${today.slice(0, 8)}01`
  const weekday = new Date(`${today}T00:00:00+08:00`).getUTCDay()
  return addDays(today, -((weekday + 6) % 7))
}

function parsedPeriod(value: unknown): Period | null {
  return value === 'week' || value === 'month' || value === 'all' ? value : null
}

const periodLabels: Record<Period, string> = { week: '本周', month: '本月', all: '全部' }

leaderboardRouter.get('/leaderboard', async (req: Request, res: Response, next) => {
  try {
    await requireSharedJobsConsent(req)
    const period = parsedPeriod(req.query.period) ?? 'week'
    const start = periodStart(period)
    const values: unknown[] = []
    const dateFilter = start ? ` AND a.applied_at >= $${values.push(start)}` : ''
    const rows = await getPostgresSql().unsafe(
      `WITH participant_workspaces AS (
         SELECT u.id AS user_id,u.display_name,wm.workspace_id
         FROM users u
         JOIN workspace_members wm ON wm.user_id=u.id AND wm.role='owner'
         WHERE u.status='active' AND u.shared_jobs_consent_at IS NOT NULL
       ), counts AS (
         SELECT p.user_id,p.display_name,COUNT(a.id)::integer AS application_count
         FROM participant_workspaces p
         LEFT JOIN applications a ON a.workspace_id=p.workspace_id
           AND a.status <> 'unsent' AND a.applied_at IS NOT NULL${dateFilter}
         GROUP BY p.user_id,p.display_name
       )
       SELECT user_id,display_name,application_count,
         DENSE_RANK() OVER (ORDER BY application_count DESC)::integer AS rank
       FROM counts
       ORDER BY application_count DESC,display_name ASC,user_id ASC`,
      values as never[]
    ) as LeaderboardRow[]
    const currentUserId = req.auth!.userId
    const totalApplications = rows.reduce((sum, item) => sum + item.application_count, 0)
    res.json({
      period,
      periodLabel: periodLabels[period],
      startsAt: start,
      totalParticipants: rows.length,
      totalApplications,
      entries: rows.slice(0, 100).map(item => ({ userId: item.user_id, displayName: item.display_name, count: item.application_count, rank: item.rank })),
      currentUser: (() => {
        const item = rows.find(row => row.user_id === currentUserId)
        return item ? { userId: item.user_id, displayName: item.display_name, count: item.application_count, rank: item.rank } : null
      })()
    })
  } catch (error) { next(error) }
})
