import { Router } from 'express'
import type { Request, Response } from 'express'
import multer from 'multer'
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getPostgresSql } from '../database/client.js'
import { parsePositiveId, requireWorkspaceId } from '../auth/workspace.js'
import { WORKSPACE_KNOWLEDGE_IMAGES_DIR } from '../data-paths.js'
import { KNOWLEDGE_CATEGORIES, MASTERY_LEVELS } from '../types.js'
import { inspectImage } from '../application-materials.js'

/** PostgreSQL 工作区知识库。保留原 API 形状，前端无需携带或相信 workspaceId。 */
export const cloudKnowledgeRouter = Router()
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp']
const IMAGE_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.bmp': 'image/bmp'
}
mkdirSync(WORKSPACE_KNOWLEDGE_IMAGES_DIR, { recursive: true })

function fixedFilename(name: string): string {
  const bytes = Buffer.from(name, 'latin1'); const decoded = bytes.toString('utf8')
  return decoded !== name && Buffer.from(decoded, 'utf8').equals(bytes) ? decoded : name
}
function workspaceImagePath(workspaceId: string, storedName: string): string {
  return path.join(WORKSPACE_KNOWLEDGE_IMAGES_DIR, workspaceId, path.basename(storedName))
}
function validCategory(value: unknown): string { return typeof value === 'string' && KNOWLEDGE_CATEGORIES.includes(value) ? value : '其他' }
function sourceOwner(value: unknown): 'mine' | 'others' { return value === 'mine' ? 'mine' : 'others' }
function nullableText(value: unknown, max = 20_000): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : null
}
function markdownQuote(value: string): string { return value.replace(/\r\n?/g, '\n').split('\n').map(line => `> ${line}`).join('\n') }
function filenamePart(value: string): string { return value.trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').slice(0, 80) || '未命名' }
function conflict(res: Response): void { res.status(409).json({ message: '这条题目已被其他操作更新，请刷新后再试', error_type: 'knowledge_item_conflict' }) }

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, callback) => {
      const workspaceId = req.auth?.workspaceId
      if (!workspaceId) return callback(new Error('当前账号没有可用工作区'), '')
      const directory = path.join(WORKSPACE_KNOWLEDGE_IMAGES_DIR, workspaceId)
      mkdirSync(directory, { recursive: true }); callback(null, directory)
    },
    filename: (_req, file, callback) => callback(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { files: 2, fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => callback(null, IMAGE_EXTENSIONS.includes(path.extname(file.originalname).toLowerCase()))
})

async function sourceById(workspaceId: string, id: number): Promise<Record<string, unknown> | null> {
  const rows = await getPostgresSql().unsafe('SELECT * FROM knowledge_sources WHERE workspace_id=$1 AND id=$2', [workspaceId, id])
  return rows[0] as Record<string, unknown> | undefined ?? null
}
async function itemById(workspaceId: string, id: number): Promise<Record<string, unknown> | null> {
  const rows = await getPostgresSql().unsafe('SELECT * FROM knowledge_items WHERE workspace_id=$1 AND id=$2', [workspaceId, id])
  return rows[0] as Record<string, unknown> | undefined ?? null
}
async function applicationExists(workspaceId: string, id: number): Promise<boolean> {
  const rows = await getPostgresSql().unsafe('SELECT 1 FROM applications WHERE workspace_id=$1 AND id=$2', [workspaceId, id])
  return rows.length > 0
}
async function snapshotAnswer(workspaceId: string, itemId: number, answer: unknown, reason: string, model?: string | null): Promise<void> {
  if (typeof answer !== 'string' || !answer.trim()) return
  await getPostgresSql().unsafe(`INSERT INTO knowledge_answer_versions (workspace_id,knowledge_item_id,answer,reason,model)
    VALUES ($1,$2,$3,$4,$5)`, [workspaceId, itemId, answer.trim(), reason, model ?? null])
}

cloudKnowledgeRouter.get('/search', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 500) : ''
  if (!query) return res.status(422).json({ message: 'q 不能为空' })
  const owner = req.query.owner === 'mine' || req.query.owner === 'others' ? req.query.owner : null
  const category = typeof req.query.category === 'string' && KNOWLEDGE_CATEGORIES.includes(req.query.category) ? req.query.category : null
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 30)
  const rows = await getPostgresSql().unsafe(`SELECT i.id,i.source_id AS "sourceId",i.question,COALESCE(i.answer,'') AS answer,i.category,i.mastery,
    COALESCE(s.company,'') AS company,COALESCE(s.position,'') AS position,COALESCE(s.round,'') AS round,s.owner,
    CASE WHEN i.question ILIKE $2 THEN 3 WHEN COALESCE(i.answer,'') ILIKE $2 THEN 1 ELSE .5 END AS score
    FROM knowledge_items i LEFT JOIN knowledge_sources s ON s.id=i.source_id AND s.workspace_id=i.workspace_id
    WHERE i.workspace_id=$1 AND (i.question ILIKE $2 OR COALESCE(i.answer,'') ILIKE $2 OR COALESCE(s.company,'') ILIKE $2 OR COALESCE(s.position,'') ILIKE $2)
      AND ($3::text IS NULL OR s.owner=$3) AND ($4::text IS NULL OR i.category=$4)
    ORDER BY score DESC,i.updated_at DESC LIMIT $5`, [workspaceId, `%${query}%`, owner, category, limit])
  res.json({ queryHash: null, mode: 'like', durationMs: 0, items: rows.map(row => ({ ...row, duplicateCount: 1, matchedBy: ['like'] })) })
})

cloudKnowledgeRouter.get('/sources', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const owner = req.query.owner === 'mine' || req.query.owner === 'others' ? req.query.owner : null
  const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim().slice(0, 200) : ''
  const rows = await getPostgresSql().unsafe(`WITH sources AS (
    SELECT s.*,COUNT(*) OVER (PARTITION BY s.owner,s.company,COALESCE(s.position,''),COALESCE(s.round,'')) AS duplicate_count,
      ROW_NUMBER() OVER (PARTITION BY s.owner,s.company,COALESCE(s.position,''),COALESCE(s.round,'') ORDER BY s.id) AS duplicate_index
    FROM knowledge_sources s WHERE s.workspace_id=$1
  ) SELECT s.*,
    (SELECT COUNT(*) FROM knowledge_items i WHERE i.workspace_id=$1 AND i.source_id=s.id) AS item_count,
    (SELECT COUNT(*) FROM knowledge_images m WHERE m.workspace_id=$1 AND m.source_id=s.id) AS image_count
    FROM sources s WHERE ($2::text IS NULL OR s.owner=$2)
      AND ($3::text='' OR s.company ILIKE '%' || $3 || '%' OR COALESCE(s.position,'') ILIKE '%' || $3 || '%' OR COALESCE(s.round,'') ILIKE '%' || $3 || '%')
    ORDER BY s.created_at DESC`, [workspaceId, owner, keyword])
  res.json(rows)
})

cloudKnowledgeRouter.post('/sources', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const company = nullableText(req.body?.company, 200)
  if (!company) return res.status(422).json({ message: '公司不能为空' })
  const owner = sourceOwner(req.body?.owner); const applicationId = owner === 'mine' && Number.isSafeInteger(req.body?.application_id) ? Number(req.body.application_id) : null
  if (applicationId && !await applicationExists(workspaceId, applicationId)) return res.status(422).json({ message: '关联投递不存在' })
  const sourceType = ['text', 'image', 'manual'].includes(req.body?.source_type) ? req.body.source_type : 'manual'
  const rows = await getPostgresSql().unsafe(`INSERT INTO knowledge_sources (workspace_id,owner,company,position,round,source_type,note,application_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [workspaceId, owner, company, nullableText(req.body?.position, 200), nullableText(req.body?.round, 40), sourceType, nullableText(req.body?.note), applicationId])
  res.status(201).json(rows[0])
})

cloudKnowledgeRouter.put('/sources/:id', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '面经编号'); if (!id) return res.status(404).json({ message: '面经不存在' })
  const source = await sourceById(workspaceId, id); if (!source) return res.status(404).json({ message: '面经不存在' })
  const company = Object.hasOwn(req.body ?? {}, 'company') ? nullableText(req.body.company, 200) : String(source.company)
  if (!company) return res.status(422).json({ message: '公司不能为空' })
  const rows = await getPostgresSql().unsafe(`UPDATE knowledge_sources SET company=$3,position=$4,round=$5,note=$6,updated_at=now()
    WHERE workspace_id=$1 AND id=$2 RETURNING *`, [workspaceId, id, company,
    Object.hasOwn(req.body ?? {}, 'position') ? nullableText(req.body.position, 200) : typeof source.position === 'string' ? source.position : null,
    Object.hasOwn(req.body ?? {}, 'round') ? nullableText(req.body.round, 40) : typeof source.round === 'string' ? source.round : null,
    Object.hasOwn(req.body ?? {}, 'note') ? nullableText(req.body.note) : typeof source.note === 'string' ? source.note : null])
  res.json(rows[0])
})

cloudKnowledgeRouter.delete('/sources/:id', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '面经编号'); if (!id) return res.status(404).json({ message: '面经不存在' })
  const source = await sourceById(workspaceId, id); if (!source) return res.status(404).json({ message: '面经不存在' })
  const images = await getPostgresSql().unsafe('SELECT stored_name,inference_stored_name FROM knowledge_images WHERE workspace_id=$1 AND source_id=$2', [workspaceId, id]) as Array<{ stored_name: string; inference_stored_name: string | null }>
  await getPostgresSql().unsafe('DELETE FROM knowledge_sources WHERE workspace_id=$1 AND id=$2', [workspaceId, id])
  for (const image of images) for (const name of [image.stored_name, image.inference_stored_name]) if (name) try { unlinkSync(workspaceImagePath(workspaceId, name)) } catch { /* 数据库删除成功即可 */ }
  res.json({ ok: true })
})

cloudKnowledgeRouter.get('/sources/:id/export.md', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '面经编号'); if (!id) return res.status(404).json({ message: '面经不存在' })
  const source = await sourceById(workspaceId, id) as { owner: string; company: string; position: string | null; round: string | null; note: string | null; created_at: string } | null
  if (!source) return res.status(404).json({ message: '面经不存在' })
  const items = await getPostgresSql().unsafe('SELECT question,answer,category,mastery FROM knowledge_items WHERE workspace_id=$1 AND source_id=$2 ORDER BY id', [workspaceId, id]) as Array<{ question: string; answer: string | null; category: string; mastery: number }>
  const duplicated = await getPostgresSql().unsafe(`SELECT COUNT(*)::int AS count FROM knowledge_sources WHERE workspace_id=$1 AND owner=$2 AND company=$3
    AND COALESCE(position,'')=COALESCE($4,'') AND COALESCE(round,'')=COALESCE($5,'') AND id<=$6`, [workspaceId, source.owner, source.company, source.position, source.round, id]) as Array<{ count: number }>
  const lines = [`# ${[source.company, source.position, source.round].filter(Boolean).join(' · ')}`, '', `- 面经来源：${source.owner === 'mine' ? '我的面试' : '他人面经'}`,
    `- 录入时间：${source.created_at.slice(0, 10)}`, `- 题目数量：${items.length}`, ...(source.note ? [`- 备注：${source.note}`] : []), '', '---']
  const mastery = ['未掌握', '模糊', '已掌握']
  items.forEach((item, index) => lines.push('', `## ${index + 1}. 问题`, '', markdownQuote(item.question), '', `- 分类：${item.category}`, `- 掌握度：${mastery[item.mastery] ?? '未知'}`, '', '### 参考答案', '', item.answer?.trim() || '> 暂无参考答案'))
  const filename = `${[filenamePart(source.company), source.position ? filenamePart(source.position) : '', source.round ? filenamePart(source.round) : '', `面经（${duplicated[0]?.count ?? 1}）`].filter(Boolean).join('-')}.md`
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="interview-notes.md"; filename*=UTF-8''${encodeURIComponent(filename)}`); res.send(`${lines.join('\n')}\n`)
})

cloudKnowledgeRouter.get('/sources/:id', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '面经编号'); if (!id) return res.status(404).json({ message: '面经不存在' })
  const source = await sourceById(workspaceId, id); if (!source) return res.status(404).json({ message: '面经不存在' })
  const sql = getPostgresSql(); const [items, images] = await Promise.all([
    sql.unsafe('SELECT * FROM knowledge_items WHERE workspace_id=$1 AND source_id=$2 ORDER BY id', [workspaceId, id]),
    sql.unsafe('SELECT id,filename,created_at FROM knowledge_images WHERE workspace_id=$1 AND source_id=$2 ORDER BY id', [workspaceId, id])
  ])
  res.json({ ...source, items, images })
})

cloudKnowledgeRouter.get('/items', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const owner = req.query.owner === 'mine' || req.query.owner === 'others' ? req.query.owner : null
  const category = typeof req.query.category === 'string' && KNOWLEDGE_CATEGORIES.includes(req.query.category) ? req.query.category : null
  const mastery = MASTERY_LEVELS.includes(Number(req.query.mastery) as 0 | 1 | 2) ? Number(req.query.mastery) : null
  const sourceId = parsePositiveId(req.query.source_id, '面经编号'); const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim().slice(0, 500) : ''
  const rows = await getPostgresSql().unsafe(`SELECT i.*,s.company AS source_company,s.position AS source_position,s.round AS source_round,s.owner AS source_owner
    FROM knowledge_items i LEFT JOIN knowledge_sources s ON s.id=i.source_id AND s.workspace_id=i.workspace_id
    WHERE i.workspace_id=$1 AND ($2::text IS NULL OR s.owner=$2) AND ($3::text IS NULL OR i.category=$3)
      AND ($4::int IS NULL OR i.mastery=$4) AND ($5::int IS NULL OR i.source_id=$5)
      AND ($6::text='' OR i.question ILIKE '%' || $6 || '%' OR COALESCE(i.answer,'') ILIKE '%' || $6 || '%')
    ORDER BY i.updated_at DESC`, [workspaceId, owner, category, mastery, sourceId, keyword])
  res.json(rows)
})

cloudKnowledgeRouter.post('/items', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const question = nullableText(req.body?.question, 2_000)
  if (!question) return res.status(422).json({ message: '问题不能为空' })
  const sourceId = parsePositiveId(req.body?.source_id, '面经编号'); if (sourceId && !await sourceById(workspaceId, sourceId)) return res.status(422).json({ message: '面经不存在' })
  const rows = await getPostgresSql().unsafe(`INSERT INTO knowledge_items (workspace_id,source_id,question,answer,category)
    VALUES ($1,$2,$3,$4,$5) RETURNING *`, [workspaceId, sourceId, question, nullableText(req.body?.answer), validCategory(req.body?.category)])
  res.status(201).json(rows[0])
})

cloudKnowledgeRouter.post('/items/batch', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const sourceId = parsePositiveId(req.body?.source_id, '面经编号'); const items = req.body?.items
  if (!sourceId || !await sourceById(workspaceId, sourceId)) return res.status(422).json({ message: '面经不存在' })
  if (!Array.isArray(items) || !items.length) return res.status(422).json({ message: '题目列表不能为空' }); if (items.length > 100) return res.status(422).json({ message: '单批最多 100 条' })
  const valid = items.map(item => ({ question: nullableText(item?.question, 2_000), answer: nullableText(item?.answer), category: validCategory(item?.category) })).filter(item => item.question)
  if (!valid.length) return res.status(422).json({ message: '没有有效题目' })
  const inserted = await getPostgresSql().begin(async transaction => {
    const rows: unknown[] = []; for (const item of valid) rows.push(...await transaction.unsafe(`INSERT INTO knowledge_items (workspace_id,source_id,question,answer,category) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [workspaceId, sourceId, item.question, item.answer, item.category])); return rows
  })
  res.status(201).json(inserted)
})

cloudKnowledgeRouter.put('/items/:id', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '题目编号'); if (!id) return res.status(404).json({ message: '题目不存在' })
  const item = await itemById(workspaceId, id) as { question: string; answer: string | null; category: string; updated_at: string } | null; if (!item) return res.status(404).json({ message: '题目不存在' })
  const question = Object.hasOwn(req.body ?? {}, 'question') ? nullableText(req.body.question, 2_000) : item.question; if (!question) return res.status(422).json({ message: '问题不能为空' })
  const answer = Object.hasOwn(req.body ?? {}, 'answer') ? nullableText(req.body.answer) : item.answer; const expected = typeof req.body?.expected_updated_at === 'string' ? req.body.expected_updated_at : null
  if (expected && expected !== item.updated_at) return conflict(res)
  const sql = getPostgresSql(); const updated = await sql.begin(async transaction => {
    if (answer !== item.answer) await snapshotAnswer(workspaceId, id, item.answer, 'before_manual_edit')
    return transaction.unsafe(`UPDATE knowledge_items SET question=$3,answer=$4,category=$5,updated_at=now() WHERE workspace_id=$1 AND id=$2${expected ? ' AND updated_at=$6::timestamptz' : ''} RETURNING *`, expected ? [workspaceId, id, question, answer, validCategory(req.body?.category ?? item.category), expected] : [workspaceId, id, question, answer, validCategory(req.body?.category ?? item.category)])
  })
  if (!updated.length) return conflict(res); res.json(updated[0])
})

cloudKnowledgeRouter.get('/items/:id/answer-versions', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '题目编号'); if (!id || !await itemById(workspaceId, id)) return res.status(404).json({ message: '题目不存在' })
  res.json(await getPostgresSql().unsafe('SELECT id,answer,reason,model,created_at FROM knowledge_answer_versions WHERE workspace_id=$1 AND knowledge_item_id=$2 ORDER BY id DESC LIMIT 30', [workspaceId, id]))
})

cloudKnowledgeRouter.post('/items/:id/answer-versions/:versionId/restore', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '题目编号'); const versionId = parsePositiveId(req.params.versionId, '答案版本编号'); if (!id || !versionId) return res.status(404).json({ message: '题目或答案版本不存在' })
  const item = await itemById(workspaceId, id) as { answer: string | null; updated_at: string } | null
  const versions = await getPostgresSql().unsafe('SELECT answer FROM knowledge_answer_versions WHERE workspace_id=$1 AND knowledge_item_id=$2 AND id=$3', [workspaceId, id, versionId]) as Array<{ answer: string }>
  if (!item || !versions[0]) return res.status(404).json({ message: '题目或答案版本不存在' }); const expected = typeof req.body?.expected_updated_at === 'string' ? req.body.expected_updated_at : null; if (expected && expected !== item.updated_at) return conflict(res)
  const updated = await getPostgresSql().begin(async transaction => { if (versions[0].answer !== item.answer) await snapshotAnswer(workspaceId, id, item.answer, 'before_restore'); return transaction.unsafe(`UPDATE knowledge_items SET answer=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2${expected ? ' AND updated_at=$4::timestamptz' : ''} RETURNING *`, expected ? [workspaceId, id, versions[0].answer, expected] : [workspaceId, id, versions[0].answer]) })
  if (!updated.length) return conflict(res); res.json(updated[0])
})

cloudKnowledgeRouter.patch('/items/:id/mastery', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '题目编号'); const mastery = Number(req.body?.mastery)
  if (!id || !MASTERY_LEVELS.includes(mastery as 0 | 1 | 2)) return res.status(422).json({ message: 'mastery 应为 0/1/2' })
  const rows = await getPostgresSql().unsafe('UPDATE knowledge_items SET mastery=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *', [workspaceId, id, mastery]); if (!rows.length) return res.status(404).json({ message: '条目不存在' }); res.json(rows[0])
})

cloudKnowledgeRouter.delete('/items/:id', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '题目编号'); if (!id) return res.status(404).json({ message: '条目不存在' })
  const rows = await getPostgresSql().unsafe('DELETE FROM knowledge_items WHERE workspace_id=$1 AND id=$2 RETURNING id', [workspaceId, id]); if (!rows.length) return res.status(404).json({ message: '条目不存在' }); res.json({ ok: true })
})

cloudKnowledgeRouter.post('/images', upload.fields([{ name: 'file', maxCount: 1 }, { name: 'inference_file', maxCount: 1 }]), async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>; const original = files.file?.[0]; const inference = files.inference_file?.[0]
  const cleanup = () => [original?.path, inference?.path].filter(Boolean).forEach(file => { try { unlinkSync(file!) } catch { /* no-op */ } })
  const sourceId = parsePositiveId(req.body?.source_id, '面经编号'); if (!sourceId || !await sourceById(workspaceId, sourceId)) { cleanup(); return res.status(422).json({ message: '面经不存在' }) }
  if (!original || !inference) { cleanup(); return res.status(422).json({ message: '请选择图片；图片推理副本缺失时请刷新页面后重试' }) }
  try {
    const info = inspectImage(readFileSync(inference.path)); if (!Object.values(IMAGE_TYPES).includes(info.mime) || Math.max(info.width, info.height) > 2048) throw new Error('图片推理副本格式或尺寸不正确')
    const rows = await getPostgresSql().unsafe(`INSERT INTO knowledge_images (workspace_id,source_id,filename,stored_name,inference_stored_name,inference_mime) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [workspaceId, sourceId, fixedFilename(original.originalname), original.filename, inference.filename, info.mime]); res.status(201).json(rows[0])
  } catch (error) { cleanup(); res.status(422).json({ message: (error as Error).message || '图片处理失败' }) }
})

cloudKnowledgeRouter.get('/images/:id/file', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '截图编号'); if (!id) return res.status(404).json({ message: '截图不存在' })
  const rows = await getPostgresSql().unsafe('SELECT filename,stored_name FROM knowledge_images WHERE workspace_id=$1 AND id=$2', [workspaceId, id]) as Array<{ filename: string; stored_name: string }>; const image = rows[0]; if (!image) return res.status(404).json({ message: '截图不存在' })
  const file = workspaceImagePath(workspaceId, image.stored_name); if (!existsSync(file)) return res.status(404).json({ message: '截图文件已丢失' }); const ext = path.extname(image.stored_name).toLowerCase(); res.setHeader('Content-Type', IMAGE_TYPES[ext] ?? 'application/octet-stream'); res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(image.filename)}`); res.sendFile(file)
})

cloudKnowledgeRouter.delete('/images/:id', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '截图编号'); if (!id) return res.status(404).json({ message: '截图不存在' })
  const rows = await getPostgresSql().unsafe('DELETE FROM knowledge_images WHERE workspace_id=$1 AND id=$2 RETURNING stored_name,inference_stored_name', [workspaceId, id]) as Array<{ stored_name: string; inference_stored_name: string | null }>; const image = rows[0]; if (!image) return res.status(404).json({ message: '截图不存在' }); for (const name of [image.stored_name, image.inference_stored_name]) if (name) try { unlinkSync(workspaceImagePath(workspaceId, name)) } catch { /* file already absent */ }; res.json({ ok: true })
})
