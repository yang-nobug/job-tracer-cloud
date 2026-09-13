import { Router } from 'express'
import type { Request, Response } from 'express'
import { getPostgresSql } from '../database/client.js'
import { parsePositiveId, requireWorkspaceId } from '../auth/workspace.js'
import { STATUS_LABELS, type Status } from '../types.js'

/**
 * 互惠共享岗位：只有明确同意共享的用户才能查看，同时只返回岗位公开字段。
 * 这里绝不能返回原投递记录中的联系人、简历、备注、日程或面试数据。
 */
export const sharedJobsRouter = Router()

type DuplicateKind = 'jd_link' | 'company_position'
interface PersonalApplication {
  id: number
  company: string
  position: string
  status: Status
  jd_link: string | null
  rejected_at: string | null
  reject_type: 'company' | 'me' | null
}
interface SharedSource {
  id: number
  company: string
  position: string
  location: string | null
  channel: string | null
  jd_link: string | null
  jd_text: string | null
  created_at: string
  updated_at: string
}

function normalizedText(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\s\-_—–·•()（）【】\[\]{}]/g, '')
}

/** 忽略锚点和常见追踪参数；不能解析的旧链接仍以原文本比较。 */
function normalizedUrl(value: string | null | undefined): string {
  const text = value?.trim()
  if (!text) return ''
  try {
    const url = new URL(text)
    if (!['http:', 'https:'].includes(url.protocol)) return text
    url.protocol = url.protocol.toLowerCase()
    url.hostname = url.hostname.toLowerCase()
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_[^=]*|gclid|fbclid|spm|from|source)$/i.test(key)) url.searchParams.delete(key)
    }
    url.searchParams.sort()
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString()
  } catch {
    return text
  }
}

function duplicateFor(source: Pick<SharedSource, 'company' | 'position' | 'jd_link'>, personal: PersonalApplication[]) {
  const sourceJd = normalizedUrl(source.jd_link)
  const sourceCompany = normalizedText(source.company)
  const sourcePosition = normalizedText(source.position)
  const jdMatch = sourceJd ? personal.find(item => normalizedUrl(item.jd_link) === sourceJd) : undefined
  const companyPositionMatch = personal.find(item => normalizedText(item.company) === sourceCompany && normalizedText(item.position) === sourcePosition)
  const application = jdMatch ?? companyPositionMatch
  if (!application) return null
  const kind: DuplicateKind = jdMatch ? 'jd_link' : 'company_position'
  return {
    applicationId: application.id,
    kind,
    status: application.status,
    statusLabel: STATUS_LABELS[application.status],
    rejectedAt: application.rejected_at,
    rejectType: application.reject_type,
    company: application.company,
    position: application.position
  }
}

async function consented(userId: string): Promise<boolean> {
  const rows = await getPostgresSql().unsafe('SELECT shared_jobs_consent_at FROM users WHERE id=$1', [userId]) as Array<{ shared_jobs_consent_at: string | null }>
  return Boolean(rows[0]?.shared_jobs_consent_at)
}

function requireConsent(req: Request): Promise<void> {
  const userId = req.auth?.userId
  if (!userId) throw new Error('请先登录')
  return consented(userId).then(enabled => {
    if (!enabled) {
      const error = new Error('同意共享岗位后才能查看岗位广场') as Error & { status?: number; code?: string }
      error.status = 403
      error.code = 'shared_jobs_consent_required'
      throw error
    }
  })
}

async function personalApplications(workspaceId: string): Promise<PersonalApplication[]> {
  return await getPostgresSql().unsafe(
    'SELECT id,company,position,status,jd_link,rejected_at,reject_type FROM applications WHERE workspace_id=$1 ORDER BY updated_at DESC,id DESC',
    [workspaceId]
  ) as PersonalApplication[]
}

function sharedPredicate(alias = 'a'): string {
  return `EXISTS (SELECT 1 FROM workspace_members wm JOIN users owner ON owner.id=wm.user_id
    WHERE wm.workspace_id=${alias}.workspace_id AND wm.role='owner' AND owner.shared_jobs_consent_at IS NOT NULL)`
}

async function sharedSource(id: number): Promise<SharedSource | null> {
  const rows = await getPostgresSql().unsafe(
    `SELECT a.id,a.company,a.position,a.location,a.channel,a.jd_link,a.jd_text,a.created_at,a.updated_at
     FROM applications a WHERE a.id=$1 AND ${sharedPredicate('a')}`,
    [id]
  ) as SharedSource[]
  return rows[0] ?? null
}

function publicJob(source: SharedSource, personal: PersonalApplication[]) {
  return {
    id: source.id,
    company: source.company,
    position: source.position,
    location: source.location,
    channel: source.channel,
    jdLink: source.jd_link,
    jdText: source.jd_text,
    createdAt: source.created_at,
    updatedAt: source.updated_at,
    duplicate: duplicateFor(source, personal)
  }
}

/**
 * 岗位广场以“岗位”而非“谁录入过它”为单位展示。
 * 查询已按更新时间倒序，因此相同岗位只保留资料最新的一条；匹配规则与个人去重一致。
 */
function sameSharedJob(left: SharedSource, right: SharedSource): boolean {
  const leftJd = normalizedUrl(left.jd_link)
  const rightJd = normalizedUrl(right.jd_link)
  if (leftJd && rightJd && leftJd === rightJd) return true
  return normalizedText(left.company) === normalizedText(right.company)
    && normalizedText(left.position) === normalizedText(right.position)
}

function deduplicateSharedSources(rows: SharedSource[]): SharedSource[] {
  const unique: SharedSource[] = []
  for (const row of rows) {
    if (!unique.some(existing => sameSharedJob(existing, row))) unique.push(row)
  }
  return unique
}

sharedJobsRouter.get('/shared-jobs/status', async (req, res, next) => {
  try {
    const userId = req.auth?.userId
    if (!userId) return res.status(401).json({ message: '请先登录' })
    res.json({ consented: await consented(userId) })
  } catch (error) { next(error) }
})

sharedJobsRouter.put('/shared-jobs/consent', async (req, res, next) => {
  try {
    const userId = req.auth?.userId
    if (!userId) return res.status(401).json({ message: '请先登录' })
    if (typeof req.body?.consented !== 'boolean') return res.status(422).json({ message: '请明确选择是否同意共享' })
    const enabled = req.body.consented
    await getPostgresSql().unsafe('UPDATE users SET shared_jobs_consent_at=$2,updated_at=now() WHERE id=$1', [userId, enabled ? new Date() : null])
    res.json({ consented: enabled })
  } catch (error) { next(error) }
})

sharedJobsRouter.get('/shared-jobs', async (req, res, next) => {
  try {
    await requireConsent(req)
    const workspaceId = requireWorkspaceId(req)
    const clauses = [sharedPredicate('a')]
    const values: unknown[] = []
    const add = (value: unknown) => { values.push(value); return `$${values.length}` }
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim().slice(0, 120) : ''
    const location = typeof req.query.location === 'string' ? req.query.location.trim().slice(0, 80) : ''
    if (keyword) {
      const value = `%${keyword}%`
      const company = add(value); const position = add(value); const jd = add(value)
      clauses.push(`(a.company ILIKE ${company} OR a.position ILIKE ${position} OR COALESCE(a.jd_text,'') ILIKE ${jd})`)
    }
    if (location) clauses.push(`COALESCE(a.location,'') ILIKE ${add(`%${location}%`)}`)
    const rows = await getPostgresSql().unsafe(
      `SELECT a.id,a.company,a.position,a.location,a.channel,a.jd_link,a.jd_text,a.created_at,a.updated_at
       FROM applications a WHERE ${clauses.join(' AND ')} ORDER BY a.updated_at DESC,a.id DESC LIMIT 200`,
      values as never[]
    ) as SharedSource[]
    const personal = await personalApplications(workspaceId)
    res.json(deduplicateSharedSources(rows).map(source => publicJob(source, personal)))
  } catch (error) { next(error) }
})

sharedJobsRouter.get('/shared-jobs/:id', async (req, res, next) => {
  try {
    await requireConsent(req)
    const workspaceId = requireWorkspaceId(req)
    const id = parsePositiveId(req.params.id, '岗位编号')
    if (!id) return res.status(404).json({ message: '共享岗位不存在' })
    const source = await sharedSource(id)
    if (!source) return res.status(404).json({ message: '共享岗位不存在或已撤回共享' })
    res.json(publicJob(source, await personalApplications(workspaceId)))
  } catch (error) { next(error) }
})

sharedJobsRouter.post('/shared-jobs/:id/add', async (req, res, next) => {
  try {
    await requireConsent(req)
    const workspaceId = requireWorkspaceId(req)
    const id = parsePositiveId(req.params.id, '岗位编号')
    if (!id) return res.status(404).json({ message: '共享岗位不存在' })
    const source = await sharedSource(id)
    if (!source) return res.status(404).json({ message: '共享岗位不存在或已撤回共享' })
    const duplicate = duplicateFor(source, await personalApplications(workspaceId))
    if (duplicate) return res.status(409).json({ message: '该岗位已在你的投递列表中', duplicate })
    const rows = await getPostgresSql().unsafe(
      `INSERT INTO applications(workspace_id,company,position,status,channel,location,jd_link,jd_text,notes)
       VALUES($1,$2,$3,'unsent',$4,$5,$6,$7,$8)
       RETURNING id,company,position,status,applied_at,applied_time,channel,location,resume_id,jd_link,jd_text,contact_name,contact_info,notes,rejected_at,reject_type,created_at,updated_at`,
      [workspaceId, source.company, source.position, source.channel || '共享岗位', source.location, source.jd_link, source.jd_text, '来自共享岗位']
    )
    res.status(201).json(rows[0])
  } catch (error) { next(error) }
})
