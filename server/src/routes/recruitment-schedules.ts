import { Router } from 'express'
import type { Request, Response } from 'express'
import { getPostgresSql } from '../database/client.js'
import { localDate, parsePositiveId, requireWorkspaceId } from '../auth/workspace.js'
import { validateRecruitmentScheduleInput, ScheduleValidationError, type RecruitmentScheduleInput } from '../recruitment-schedule.js'
import { canAutomaticallyAdvanceStatus } from '../status-transition.js'
import { STATUS_LABELS, type Status } from '../types.js'

export const recruitmentSchedulesRouter = Router()

type ScheduleRow = Record<string, unknown> & { id: number; application_id: number | null; interview_id: number | null }

const eventLabels: Record<string, string> = {
  assessment: '在线测评', written_test: '笔试', interview: '面试', ai_interview: 'AI 面试', offer: 'Offer / 录用', other: '招聘流程事项'
}

function first<T>(rows: T[]): T | null { return rows[0] ?? null }
function parseInstructions(value: unknown): string[] {
  try { const parsed = typeof value === 'string' ? JSON.parse(value) : value; return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [] } catch { return [] }
}

export function scheduleTarget(eventType: string, round: string): Status | null {
  if (eventType === 'assessment') return 'assessment'
  if (eventType === 'written_test') return 'testing'
  if (eventType === 'ai_interview') return 'ai'
  if (eventType === 'offer') return 'offer'
  if (eventType !== 'interview') return null
  const value = round.replace(/\s/g, '').toLowerCase()
  if (/^(一面|1面|第一轮|第1轮)/.test(value)) return 'round1'
  if (/^(二面|2面|第二轮|第2轮)/.test(value)) return 'round2'
  if (/^(三面|3面|第三轮|第3轮)/.test(value)) return 'round3'
  if (/^(hr|人力资源)/i.test(value)) return 'hr'
  return null
}

export function scheduleTitle(input: RecruitmentScheduleInput): string {
  return input.title || [...new Set([input.company, input.position, input.round, eventLabels[input.eventType]].filter(Boolean))].join(' · ')
}

export function publicSchedule(value: ScheduleRow) {
  return {
    id: value.id, applicationId: value.application_id, sourceCandidateId: value.source_mail_candidate_id ?? null,
    source: value.source, interviewId: value.interview_id, eventType: value.event_type, round: value.round || '',
    title: value.title, company: value.company || '', position: value.position || '', timeMode: value.time_mode,
    scheduledAt: value.scheduled_at, windowStartAt: value.window_start_at, windowEndAt: value.window_end_at,
    deadlineAt: value.deadline_at, durationMinutes: value.duration_minutes, timezone: value.timezone,
    location: value.location, meetingLink: value.meeting_link, actionLink: value.action_link, contact: value.contact,
    instructions: parseInstructions(value.instructions_json), status: value.status, createdAt: value.created_at, updatedAt: value.updated_at
  }
}

async function loadSchedule(workspaceId: string, id: number): Promise<ScheduleRow | null> {
  const rows = await getPostgresSql().unsafe('SELECT * FROM workspace_recruitment_schedules WHERE workspace_id=$1 AND id=$2', [workspaceId, id]) as ScheduleRow[]
  return first(rows)
}

async function requireApplication(workspaceId: string, id: number) {
  const rows = await getPostgresSql().unsafe('SELECT id,company,position,status,rejected_at FROM applications WHERE workspace_id=$1 AND id=$2', [workspaceId, id]) as Array<{ id: number; company: string; position: string; status: Status; rejected_at: string | null }>
  return first(rows)
}

async function advanceApplication(workspaceId: string, applicationId: number, input: RecruitmentScheduleInput, source: string): Promise<void> {
  const target = scheduleTarget(input.eventType, input.round)
  if (!target) return
  const app = await requireApplication(workspaceId, applicationId)
  if (!app || app.rejected_at || !canAutomaticallyAdvanceStatus(app.status, target)) return
  const sql = getPostgresSql()
  await sql.begin(async transaction => {
    await transaction.unsafe('UPDATE applications SET status=$1,updated_at=now() WHERE workspace_id=$2 AND id=$3', [target, workspaceId, applicationId])
    await transaction.unsafe("INSERT INTO application_events (workspace_id,application_id,type,event_date,content) VALUES ($1,$2,'status',$3,$4)", [workspaceId, applicationId, localDate(), `${source}：${STATUS_LABELS[app.status]} -> ${STATUS_LABELS[target]}`])
  })
}

function inputFromRequest(body: unknown, applicationId: number, company: string, position: string): RecruitmentScheduleInput {
  const data = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
  return validateRecruitmentScheduleInput({ ...data, applicationId, company: data.company || company, position: data.position || position })
}

async function createInterviewForSchedule(workspaceId: string, schedule: ScheduleRow): Promise<number> {
  if (!schedule.application_id) throw new ScheduleValidationError('独立日程不能创建面试准备，请先关联投递')
  if (!schedule.scheduled_at) throw new ScheduleValidationError('请先填写固定开始时间，再创建面试准备')
  if (schedule.interview_id) return Number(schedule.interview_id)
  const round = String(schedule.round || eventLabels[String(schedule.event_type)] || '面试').slice(0, 40)
  const sql = getPostgresSql()
  const created = await sql.unsafe(
    'INSERT INTO interviews (workspace_id,application_id,round,scheduled_at,location) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [workspaceId, schedule.application_id, round, schedule.scheduled_at, schedule.location || null]
  ) as Array<{ id: number }>
  await sql.unsafe('UPDATE workspace_recruitment_schedules SET interview_id=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2', [workspaceId, schedule.id, created[0].id])
  return created[0].id
}

recruitmentSchedulesRouter.post('/applications/:id/schedules', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req)
  const applicationId = parsePositiveId(req.params.id, '投递编号')
  if (!applicationId) return res.status(404).json({ message: '投递不存在' })
  const application = await requireApplication(workspaceId, applicationId)
  if (!application) return res.status(404).json({ message: '投递不存在' })
  try {
    const input = inputFromRequest(req.body, applicationId, application.company, application.position)
    const sql = getPostgresSql()
    const inserted = await sql.unsafe(
      `INSERT INTO workspace_recruitment_schedules (workspace_id,application_id,source,event_type,round,title,company,position,time_mode,scheduled_at,window_start_at,window_end_at,deadline_at,duration_minutes,timezone,location,meeting_link,action_link,contact,instructions_json)
       VALUES ($1,$2,'manual',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [workspaceId, applicationId, input.eventType, input.round, scheduleTitle(input), input.company, input.position, input.timeMode, input.scheduledAt, input.windowStartAt, input.windowEndAt, input.deadlineAt, input.durationMinutes, input.timezone, input.location, input.meetingLink, input.actionLink, input.contact, JSON.stringify(input.instructions)]
    ) as ScheduleRow[]
    await sql.unsafe("INSERT INTO application_events (workspace_id,application_id,type,event_date,content) VALUES ($1,$2,'interview',$3,$4)", [workspaceId, applicationId, localDate(), `新增招聘日程：${scheduleTitle(input)}`])
    await advanceApplication(workspaceId, applicationId, input, '手动新增日程')
    let schedule = inserted[0]
    if (req.body?.createInterview === true) {
      await createInterviewForSchedule(workspaceId, schedule)
      schedule = (await loadSchedule(workspaceId, schedule.id))!
    }
    res.status(201).json(publicSchedule(schedule))
  } catch (error) { res.status(error instanceof ScheduleValidationError ? 422 : 500).json({ message: error instanceof Error ? error.message : '新增日程失败' }) }
})

recruitmentSchedulesRouter.patch('/schedules/:id', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '日程编号')
  if (!id) return res.status(404).json({ message: '日程不存在' })
  const previous = await loadSchedule(workspaceId, id)
  if (!previous) return res.status(404).json({ message: '日程不存在' })
  try {
    const app = previous.application_id ? await requireApplication(workspaceId, previous.application_id) : null
    const data = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {}
    const input = validateRecruitmentScheduleInput({
      applicationId: previous.application_id, eventType: data.eventType ?? previous.event_type, round: data.round ?? previous.round,
      title: data.title ?? previous.title, company: data.company ?? previous.company ?? app?.company ?? '', position: data.position ?? previous.position ?? app?.position ?? '',
      timeMode: data.timeMode ?? previous.time_mode, scheduledAt: data.scheduledAt ?? previous.scheduled_at, windowStartAt: data.windowStartAt ?? previous.window_start_at,
      windowEndAt: data.windowEndAt ?? previous.window_end_at, deadlineAt: data.deadlineAt ?? previous.deadline_at, durationMinutes: data.durationMinutes ?? previous.duration_minutes,
      location: data.location ?? previous.location, meetingLink: data.meetingLink ?? previous.meeting_link, actionLink: data.actionLink ?? previous.action_link,
      contact: data.contact ?? previous.contact, instructions: data.instructions ?? parseInstructions(previous.instructions_json)
    })
    const rows = await getPostgresSql().unsafe(
      `UPDATE workspace_recruitment_schedules SET event_type=$1,round=$2,title=$3,company=$4,position=$5,time_mode=$6,scheduled_at=$7,window_start_at=$8,window_end_at=$9,deadline_at=$10,duration_minutes=$11,timezone=$12,location=$13,meeting_link=$14,action_link=$15,contact=$16,instructions_json=$17,updated_at=now()
       WHERE workspace_id=$18 AND id=$19 RETURNING *`,
      [input.eventType, input.round, scheduleTitle(input), input.company, input.position, input.timeMode, input.scheduledAt, input.windowStartAt, input.windowEndAt, input.deadlineAt, input.durationMinutes, input.timezone, input.location, input.meetingLink, input.actionLink, input.contact, JSON.stringify(input.instructions), workspaceId, id]
    ) as ScheduleRow[]
    if (previous.interview_id && input.scheduledAt) await getPostgresSql().unsafe('UPDATE interviews SET round=$1,scheduled_at=$2,location=$3 WHERE workspace_id=$4 AND id=$5', [input.round || eventLabels[input.eventType], input.scheduledAt, input.location || null, workspaceId, previous.interview_id])
    res.json(publicSchedule(rows[0]))
  } catch (error) { res.status(error instanceof ScheduleValidationError ? 422 : 500).json({ message: error instanceof Error ? error.message : '更新日程失败' }) }
})

recruitmentSchedulesRouter.post('/schedules/:id/interview', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '日程编号')
  if (!id) return res.status(404).json({ message: '日程不存在' })
  try { const schedule = await loadSchedule(workspaceId, id); if (!schedule) return res.status(404).json({ message: '日程不存在' }); const interviewId = await createInterviewForSchedule(workspaceId, schedule); res.json({ interviewId, schedule: publicSchedule((await loadSchedule(workspaceId, id))!) }) }
  catch (error) { res.status(error instanceof ScheduleValidationError ? 422 : 500).json({ message: error instanceof Error ? error.message : '创建面试准备失败' }) }
})

recruitmentSchedulesRouter.delete('/schedules/:id', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '日程编号')
  if (!id) return res.status(404).json({ message: '日程不存在' })
  const schedule = await loadSchedule(workspaceId, id)
  if (!schedule) return res.status(404).json({ message: '日程不存在' })
  const sql = getPostgresSql()
  await sql.begin(async transaction => {
    if (schedule.interview_id) await transaction.unsafe('DELETE FROM interviews WHERE workspace_id=$1 AND id=$2', [workspaceId, schedule.interview_id])
    await transaction.unsafe('DELETE FROM workspace_recruitment_schedules WHERE workspace_id=$1 AND id=$2', [workspaceId, id])
    if (schedule.application_id) await transaction.unsafe("INSERT INTO application_events (workspace_id,application_id,type,event_date,content) VALUES ($1,$2,'note',$3,$4)", [workspaceId, schedule.application_id, localDate(), `删除招聘日程：${schedule.title}`])
  })
  res.json({ ok: true })
})
