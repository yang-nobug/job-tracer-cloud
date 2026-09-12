import { Router } from 'express'
import type { Request, Response } from 'express'
import { getPostgresSql } from '../database/client.js'
import { localDate, parsePositiveId, requireWorkspaceId } from '../auth/workspace.js'
import { STATUS_LABELS, STATUS_ORDER, type Status } from '../types.js'
import { isCalendarDate, isClockTime } from '../../../shared/application-import.js'

export const applicationsRouter = Router()

interface AppBody {
  company?: string; position?: string; status?: Status
  applied_at?: string | null; applied_time?: string | null; channel?: string | null; location?: string | null
  resume_id?: number | null; jd_link?: string | null; application_link?: string | null; jd_text?: string | null
  contact_name?: string | null; contact_info?: string | null; notes?: string | null
}

interface ApplicationRow {
  id: number; company: string; position: string; status: Status; applied_at: string | null; applied_time: string | null
  channel: string | null; location: string | null; resume_id: number | null; jd_link: string | null; application_link: string | null
  jd_text: string | null; contact_name: string | null; contact_info: string | null; notes: string | null
  rejected_at: string | null; reject_type: 'company' | 'me' | null; created_at: string; updated_at: string
}

const columns = (table = '') => {
  const p = table ? `${table}.` : ''
  return `${p}id, ${p}company, ${p}position, ${p}status, ${p}applied_at, ${p}applied_time, ${p}channel, ${p}location,
    ${p}resume_id, ${p}jd_link, ${p}application_link, ${p}jd_text, ${p}contact_name, ${p}contact_info,
    ${p}notes, ${p}rejected_at, ${p}reject_type, ${p}created_at, ${p}updated_at`
}

function isStatus(value: unknown): value is Status {
  return typeof value === 'string' && (STATUS_ORDER as readonly string[]).includes(value)
}

function validate(body: AppBody): { error?: string; values?: Record<string, string | number | null> & { status: Status } } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '表单格式不正确' }
  for (const key of ['company', 'position', 'status', 'applied_at', 'applied_time', 'channel', 'location', 'jd_link', 'application_link', 'jd_text', 'contact_name', 'contact_info', 'notes'] as const) {
    if (body[key] != null && typeof body[key] !== 'string') return { error: `${key} 必须为文本` }
  }
  if (body.resume_id != null && (!Number.isSafeInteger(body.resume_id) || body.resume_id <= 0)) return { error: '简历编号无效' }
  const company = (body.company ?? '').trim()
  const position = (body.position ?? '').trim()
  if (!company) return { error: '公司不能为空' }
  if (!position) return { error: '职位不能为空' }
  const status = body.status != null && isStatus(body.status) ? body.status : 'unsent'
  const appliedAt = body.applied_at || null
  const appliedTime = body.applied_time || null
  if (status !== 'unsent' && !appliedAt) return { error: '请填写实际投递日期，或明确选择使用今天' }
  if (appliedAt && !isCalendarDate(appliedAt)) return { error: '投递日期不是有效的日历日期' }
  if (appliedTime && (!appliedAt || !isClockTime(appliedTime))) return { error: '投递时刻须为 HH:mm 或 HH:mm:ss，且必须有投递日期' }
  if (status === 'unsent' && (appliedAt || appliedTime)) return { error: '材料包含投递时间，请核对状态；若确实未投递，请清除日期' }
  for (const [key, label] of [['jd_link', 'JD 链接'], ['application_link', '投递进度链接']] as const) {
    const value = body[key]
    if (!value) continue
    try { if (!['http:', 'https:'].includes(new URL(value).protocol)) throw new Error() }
    catch { return { error: `${label}必须是完整的 http/https 地址` } }
  }
  return { values: {
    company, position, status, applied_at: appliedAt, applied_time: appliedTime,
    channel: body.channel?.trim() || null, location: body.location?.trim() || null, resume_id: body.resume_id ?? null,
    jd_link: body.jd_link?.trim() || null, application_link: body.application_link?.trim() || null,
    jd_text: body.jd_text || null, contact_name: body.contact_name?.trim() || null,
    contact_info: body.contact_info?.trim() || null, notes: body.notes || null
  } }
}

async function findApplication(workspaceId: string, id: number): Promise<ApplicationRow | null> {
  const rows = await getPostgresSql().unsafe(`SELECT ${columns()} FROM applications WHERE workspace_id=$1 AND id=$2`, [workspaceId, id]) as unknown as ApplicationRow[]
  return rows[0] ?? null
}

async function addStatusEvent(workspaceId: string, appId: number, from: Status, to: Status, date: string): Promise<void> {
  await getPostgresSql().unsafe(
    `INSERT INTO application_events (workspace_id, application_id, type, event_date, content) VALUES ($1,$2,'status',$3,$4)`,
    [workspaceId, appId, date, `状态：${STATUS_LABELS[from]} -> ${STATUS_LABELS[to]}`]
  )
}

async function assertResumeBelongsToWorkspace(workspaceId: string, resumeId: number | null): Promise<void> {
  if (resumeId == null) return
  const rows = await getPostgresSql().unsafe('SELECT id FROM resumes WHERE workspace_id=$1 AND id=$2', [workspaceId, resumeId])
  if (!rows.length) throw new Error('选择的简历不存在或不属于当前工作区')
}

applicationsRouter.get('/', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req)
  const clauses = ['a.workspace_id=$1']; const params: unknown[] = [workspaceId]
  const next = (value: unknown) => { params.push(value); return `$${params.length}` }
  const { status, channel, keyword, rejected, from, to } = req.query
  if (status && isStatus(status)) clauses.push(`a.status=${next(status)}`)
  if (typeof channel === 'string' && channel) clauses.push(`a.channel=${next(channel)}`)
  if (typeof keyword === 'string' && keyword) {
    const pattern = `%${keyword}%`; const first = next(pattern); const second = next(pattern)
    clauses.push(`(a.company ILIKE ${first} OR a.position ILIKE ${second})`)
  }
  if (rejected === 'true') clauses.push('a.rejected_at IS NOT NULL')
  if (rejected === 'false') clauses.push('a.rejected_at IS NULL')
  if (typeof from === 'string' && from) clauses.push(`a.applied_at>=${next(from)}`)
  if (typeof to === 'string' && to) clauses.push(`a.applied_at<=${next(to)}`)
  const rows = await getPostgresSql().unsafe(
    `SELECT ${columns('a')},
      (SELECT round FROM interviews i WHERE i.workspace_id=a.workspace_id AND i.application_id=a.id ORDER BY scheduled_at DESC, id DESC LIMIT 1) AS last_round,
      (SELECT scheduled_at FROM interviews i WHERE i.workspace_id=a.workspace_id AND i.application_id=a.id AND done=false ORDER BY scheduled_at ASC, id DESC LIMIT 1) AS next_interview_at
     FROM applications a WHERE ${clauses.join(' AND ')} ORDER BY a.updated_at DESC`, params as never[]
  )
  res.json(rows)
})

applicationsRouter.get('/:id', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '投递编号')
  if (!id) return res.status(404).json({ message: '记录不存在' })
  const app = await findApplication(workspaceId, id)
  if (!app) return res.status(404).json({ message: '记录不存在' })
  const sql = getPostgresSql()
  const events = await sql.unsafe('SELECT id, application_id, type, event_date, content, created_at FROM application_events WHERE workspace_id=$1 AND application_id=$2 ORDER BY event_date DESC,id DESC', [workspaceId, id])
  const interviews = await sql.unsafe('SELECT id, application_id, round, scheduled_at, location, review_file, done::integer AS done, created_at FROM interviews WHERE workspace_id=$1 AND application_id=$2 ORDER BY scheduled_at DESC', [workspaceId, id]) as Array<Record<string, unknown> & { id: number }>
  for (const interview of interviews) {
    interview.checklist = await sql.unsafe('SELECT id, interview_id, content, done::integer AS done, sort FROM checklist_items WHERE workspace_id=$1 AND interview_id=$2 ORDER BY sort,id', [workspaceId, interview.id])
  }
  res.json({ ...app, events, interviews, resume: null, materials: [] })
})

applicationsRouter.post('/', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req)
  if (req.body?.import_id) return res.status(409).json({ message: '招聘信息智能录入正在迁移，请先使用表单新增投递' })
  const { error, values } = validate(req.body)
  if (error || !values) return res.status(422).json({ message: error })
  await assertResumeBelongsToWorkspace(workspaceId, values.resume_id as number | null)
  const rows = await getPostgresSql().unsafe(
    `INSERT INTO applications (workspace_id,company,position,status,applied_at,applied_time,channel,location,resume_id,jd_link,application_link,jd_text,contact_name,contact_info,notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING ${columns()}`,
    [workspaceId, values.company, values.position, values.status, values.applied_at, values.applied_time, values.channel, values.location, values.resume_id, values.jd_link, values.application_link, values.jd_text, values.contact_name, values.contact_info, values.notes]
  ) as unknown as ApplicationRow[]
  const app = rows[0]
  if (app.status !== 'unsent') await addStatusEvent(workspaceId, app.id, 'unsent', app.status, app.applied_at!)
  res.status(201).json(app)
})

applicationsRouter.put('/:id', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '投递编号')
  if (!id) return res.status(404).json({ message: '记录不存在' })
  const previous = await findApplication(workspaceId, id)
  if (!previous) return res.status(404).json({ message: '记录不存在' })
  const { error, values } = validate({ ...req.body, applied_time: req.body?.applied_time === undefined ? previous.applied_time : req.body.applied_time })
  if (error || !values) return res.status(422).json({ message: error })
  await assertResumeBelongsToWorkspace(workspaceId, values.resume_id as number | null)
  const rows = await getPostgresSql().unsafe(
    `UPDATE applications SET company=$1,position=$2,status=$3,applied_at=$4,applied_time=$5,channel=$6,location=$7,resume_id=$8,jd_link=$9,application_link=$10,jd_text=$11,contact_name=$12,contact_info=$13,notes=$14,updated_at=now()
     WHERE workspace_id=$15 AND id=$16 RETURNING ${columns()}`,
    [values.company, values.position, values.status, values.applied_at, values.applied_time, values.channel, values.location, values.resume_id, values.jd_link, values.application_link, values.jd_text, values.contact_name, values.contact_info, values.notes, workspaceId, id]
  ) as unknown as ApplicationRow[]
  const app = rows[0]
  if (app.status !== previous.status) await addStatusEvent(workspaceId, id, previous.status, app.status, previous.status === 'unsent' ? app.applied_at! : localDate())
  res.json(app)
})

applicationsRouter.patch('/:id/reject', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '投递编号')
  if (!id) return res.status(404).json({ message: '记录不存在' })
  const app = await findApplication(workspaceId, id)
  if (!app) return res.status(404).json({ message: '记录不存在' })
  const sql = getPostgresSql()
  if (app.rejected_at) await sql.unsafe('UPDATE applications SET rejected_at=NULL,reject_type=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2', [workspaceId, id])
  else {
    const rejectType = req.body?.reject_type === 'me' ? 'me' : 'company'
    await sql.unsafe('UPDATE applications SET rejected_at=$1,reject_type=$2,updated_at=now() WHERE workspace_id=$3 AND id=$4', [localDate(), rejectType, workspaceId, id])
    await sql.unsafe(`INSERT INTO application_events (workspace_id,application_id,type,event_date,content) VALUES ($1,$2,'note',$3,$4)`, [workspaceId, id, localDate(), rejectType === 'me' ? '标记：我拒了' : '标记：被拒'])
  }
  res.json(await findApplication(workspaceId, id))
})

applicationsRouter.delete('/:id', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '投递编号')
  if (!id) return res.status(404).json({ message: '记录不存在' })
  const rows = await getPostgresSql().unsafe('DELETE FROM applications WHERE workspace_id=$1 AND id=$2 RETURNING id', [workspaceId, id])
  if (!rows.length) return res.status(404).json({ message: '记录不存在' })
  res.json({ ok: true })
})
