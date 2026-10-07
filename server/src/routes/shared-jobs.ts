import { Router } from 'express'
import type { Request, Response } from 'express'
import { createHash } from 'node:crypto'
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

interface SharedJobGroup {
  sources: SharedSource[]
  representative: SharedSource
  alternatePositions: string[]
  updatedAt: string
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

/** JD 正文只作为同一公司的强标识，避免不同公司的通用模板被误合并。 */
function jdTextKey(source: SharedSource): string | null {
  const company = normalizedText(source.company)
  const text = (source.jd_text ?? '').normalize('NFKC').replace(/\s+/g, '')
  if (!company || !text) return null
  return `jd:${company}:${createHash('sha256').update(text).digest('hex')}`
}

function fallbackKey(source: SharedSource): string | null {
  const company = normalizedText(source.company)
  const position = normalizedText(source.position)
  return company && position ? `name:${company}:${position}` : null
}

function strongKeys(source: SharedSource): string[] {
  const keys: string[] = []
  const url = normalizedUrl(source.jd_link)
  if (url) keys.push(`url:${url}`)
  const text = jdTextKey(source)
  if (text) keys.push(text)
  return keys
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

function publicJob(group: SharedJobGroup, personal: PersonalApplication[]) {
  const source = group.representative
  return {
    id: source.id,
    company: source.company,
    position: source.position,
    location: source.location,
    channel: source.channel,
    jdLink: source.jd_link,
    jdText: source.jd_text,
    createdAt: source.created_at,
    updatedAt: group.updatedAt,
    alternatePositions: group.alternatePositions,
    sharedSourceCount: group.sources.length,
    duplicate: duplicateFor(source, personal)
  }
}

/**
 * 岗位广场以岗位而不是投递记录为单位展示。
 * JD 链接和同公司 JD 正文是强标识；只有两者都缺失时才退回公司+岗位名。
 * 这样“同一 JD、不同岗位名”会合并，而“同名、不同 JD”不会被误合并。
 */
function groupSharedSources(rows: SharedSource[]): SharedJobGroup[] {
  const parent = rows.map((_, index) => index)
  const find = (index: number): number => {
    let root = index
    while (parent[root] !== root) root = parent[root]
    while (parent[index] !== index) {
      const next = parent[index]
      parent[index] = root
      index = next
    }
    return root
  }
  const join = (left: number, right: number): void => {
    const a = find(left); const b = find(right)
    if (a !== b) parent[b] = a
  }

  const firstByStrongKey = new Map<string, number>()
  const hasStrongKey = rows.map(source => strongKeys(source))
  hasStrongKey.forEach((keys, index) => {
    for (const key of keys) {
      const first = firstByStrongKey.get(key)
      if (first === undefined) firstByStrongKey.set(key, index)
      else join(first, index)
    }
  })

  const groups = new Map<number, SharedSource[]>()
  for (let index = 0; index < rows.length; index++) {
    if (!hasStrongKey[index].length) continue
    const root = find(index)
    const group = groups.get(root) ?? []
    group.push(rows[index])
    groups.set(root, group)
  }

  // 无 JD 标识的旧记录只在对应公司+岗位只命中一个强标识岗位时附着；
  // 若同名岗位已有多个不同 JD，宁可单列，也不把它们错误合并。
  const strongGroupsByName = new Map<string, Set<number>>()
  for (const [root, sources] of groups) {
    for (const source of sources) {
      const key = fallbackKey(source)
      if (!key) continue
      const matches = strongGroupsByName.get(key) ?? new Set<number>()
      matches.add(root)
      strongGroupsByName.set(key, matches)
    }
  }
  const fallbackGroups = new Map<string, SharedSource[]>()
  rows.forEach((source, index) => {
    if (hasStrongKey[index].length) return
    const key = fallbackKey(source)
    const candidates = key ? strongGroupsByName.get(key) : undefined
    if (candidates?.size === 1) {
      const root = [...candidates][0]
      groups.get(root)!.push(source)
      return
    }
    const fallback = key || `record:${source.id}`
    const group = fallbackGroups.get(fallback) ?? []
    group.push(source)
    fallbackGroups.set(fallback, group)
  })

  const allGroups = [...groups.values(), ...fallbackGroups.values()]
  return allGroups.map(sources => {
    const ranked = [...sources].sort((left, right) => {
      const textDelta = (right.jd_text?.trim().length ?? 0) - (left.jd_text?.trim().length ?? 0)
      if (textDelta) return textDelta
      const linkDelta = Number(Boolean(right.jd_link?.trim())) - Number(Boolean(left.jd_link?.trim()))
      if (linkDelta) return linkDelta
      return right.updated_at.localeCompare(left.updated_at) || right.id - left.id
    })
    const representative = ranked[0]
    const representativeName = normalizedText(representative.position)
    const alternatePositions = [...new Set(sources.map(source => source.position.trim())
      .filter(position => position && normalizedText(position) !== representativeName))]
    return {
      sources,
      representative,
      alternatePositions,
      updatedAt: sources.reduce((latest, source) => source.updated_at > latest ? source.updated_at : latest, representative.updated_at)
    }
  }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.representative.id - left.representative.id)
}

async function sharedSources(filters: { keyword?: string; location?: string } = {}): Promise<SharedSource[]> {
  const clauses = [sharedPredicate('a')]
  const values: unknown[] = []
  const add = (value: unknown) => { values.push(value); return `$${values.length}` }
  if (filters.keyword) {
    const value = `%${filters.keyword}%`
    const company = add(value); const position = add(value); const jd = add(value)
    clauses.push(`(a.company ILIKE ${company} OR a.position ILIKE ${position} OR COALESCE(a.jd_text,'') ILIKE ${jd})`)
  }
  if (filters.location) clauses.push(`COALESCE(a.location,'') ILIKE ${add(`%${filters.location}%`)}`)
  return await getPostgresSql().unsafe(
    `SELECT a.id,a.company,a.position,a.location,a.channel,a.jd_link,a.jd_text,a.created_at,a.updated_at
     FROM applications a WHERE ${clauses.join(' AND ')} ORDER BY a.updated_at DESC,a.id DESC`,
    values as never[]
  ) as SharedSource[]
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
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim().slice(0, 120) : ''
    const location = typeof req.query.location === 'string' ? req.query.location.trim().slice(0, 80) : ''
    const requestedPage = typeof req.query.page === 'string' ? Number(req.query.page) : 1
    const requestedSize = typeof req.query.pageSize === 'string' ? Number(req.query.pageSize) : 40
    const pageSize = Number.isSafeInteger(requestedSize) ? Math.max(12, Math.min(100, requestedSize)) : 40
    const rows = await sharedSources({ keyword, location })
    const groups = groupSharedSources(rows)
    const totalPages = Math.max(1, Math.ceil(groups.length / pageSize))
    const page = Number.isSafeInteger(requestedPage) ? Math.max(1, Math.min(totalPages, requestedPage)) : 1
    const personal = await personalApplications(workspaceId)
    res.json({
      items: groups.slice((page - 1) * pageSize, page * pageSize).map(group => publicJob(group, personal)),
      totalJobs: groups.length,
      totalSources: rows.length,
      locations: [...new Set(rows.map(row => row.location?.trim()).filter((value): value is string => Boolean(value)))].sort((left, right) => left.localeCompare(right, 'zh-CN')),
      page,
      pageSize,
      totalPages
    })
  } catch (error) { next(error) }
})

sharedJobsRouter.get('/shared-jobs/:id', async (req, res, next) => {
  try {
    await requireConsent(req)
    const workspaceId = requireWorkspaceId(req)
    const id = parsePositiveId(req.params.id, '岗位编号')
    if (!id) return res.status(404).json({ message: '共享岗位不存在' })
    const group = groupSharedSources(await sharedSources()).find(item => item.representative.id === id)
    if (!group) return res.status(404).json({ message: '共享岗位不存在或已撤回共享' })
    res.json(publicJob(group, await personalApplications(workspaceId)))
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
