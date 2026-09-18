import { Router } from 'express'
import type { Request, Response } from 'express'
import multer from 'multer'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { getPostgresSql } from '../database/client.js'
import { parsePositiveId, requireWorkspaceId } from '../auth/workspace.js'
import { AiError, completeStructured } from '../ai.js'
import { inspectImage } from '../application-materials.js'
import { STUDY_ASSET_STAGING_DIR } from '../data-paths.js'
import { loadOssConfig, ossDelete, ossPut, ossSignedUrl } from '../oss.js'

/** 固定知识地图。它只负责目录归类，不会自动生成学习任务或复习提醒。 */
export const STUDY_DIRECTORY_KEYS = [
  'computer-basics', 'language-runtime', 'data-backend', 'frontend-browser',
  'cloud-engineering', 'ai-llm', 'project-interview', 'custom'
] as const

export const studyRouter = Router()
mkdirSync(STUDY_ASSET_STAGING_DIR, { recursive: true })
const studyImageUpload = multer({ storage: multer.diskStorage({ destination: STUDY_ASSET_STAGING_DIR, filename: (_req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`) }), limits: { fileSize: 5 * 1024 * 1024, files: 1 } })

type BookRow = Record<string, unknown> & { id: number; workspace_id: string | null; visibility: string }

function text(value: unknown, max = 20_000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}
function jsonList(value: unknown, maxItems = 30): string[] {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n|,/) : []
  return source.map(item => String(item).trim()).filter(Boolean).slice(0, maxItems)
}
function directoryKey(value: unknown): string | null {
  return typeof value === 'string' && (STUDY_DIRECTORY_KEYS as readonly string[]).includes(value) ? value : null
}
function numberOr(value: unknown, fallback = 0): number {
  const result = Number(value)
  return Number.isFinite(result) ? result : fallback
}
function exposeBook(row: Record<string, unknown>, canEdit: boolean): Record<string, unknown> {
  return {
    ...row,
    chapter_count: numberOr(row.chapter_count),
    card_count: numberOr(row.card_count),
    document_count: numberOr(row.document_count),
    can_edit: canEdit
  }
}
function exposeCard(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    followups: jsonList(row.followups_json),
    tags: jsonList(row.tags_json),
    familiarity: numberOr(row.familiarity),
    note: typeof row.note === 'string' ? row.note : ''
  }
}

async function findAccessibleBook(id: number, workspaceId: string): Promise<BookRow | null> {
  const rows = await getPostgresSql().unsafe(
    `SELECT b.*,
      (SELECT COUNT(*)::int FROM study_chapters c WHERE c.book_id=b.id) AS chapter_count,
      (SELECT COUNT(*)::int FROM study_cards q JOIN study_chapters c ON c.id=q.chapter_id WHERE c.book_id=b.id) AS card_count,
      (SELECT COUNT(*)::int FROM study_documents d JOIN study_chapters c ON c.id=d.chapter_id WHERE c.book_id=b.id) AS document_count
    FROM study_books b
    WHERE b.id=$1 AND (b.visibility='public' OR b.workspace_id=$2)`,
    [id, workspaceId]
  )
  return rows[0] as BookRow | undefined ?? null
}
function canEdit(req: Request, book: BookRow, workspaceId: string): boolean {
  return book.visibility === 'public' ? Boolean(req.auth?.isAdmin) : book.workspace_id === workspaceId
}
async function bookForChapter(chapterId: number, workspaceId: string): Promise<BookRow | null> {
  const rows = await getPostgresSql().unsafe(
    `SELECT b.* FROM study_chapters c JOIN study_books b ON b.id=c.book_id
     WHERE c.id=$1 AND (b.visibility='public' OR b.workspace_id=$2)`, [chapterId, workspaceId]
  )
  return rows[0] as BookRow | undefined ?? null
}
async function bookForCard(cardId: number, workspaceId: string): Promise<BookRow | null> {
  const rows = await getPostgresSql().unsafe(
    `SELECT b.* FROM study_cards q JOIN study_chapters c ON c.id=q.chapter_id JOIN study_books b ON b.id=c.book_id
     WHERE q.id=$1 AND (b.visibility='public' OR b.workspace_id=$2)`, [cardId, workspaceId]
  )
  return rows[0] as BookRow | undefined ?? null
}
async function nextSort(table: 'study_chapters' | 'study_cards' | 'study_documents', foreignKey: 'book_id' | 'chapter_id', id: number): Promise<number> {
  const rows = await getPostgresSql().unsafe(`SELECT COALESCE(MAX(sort), 0)::int + 1 AS next_sort FROM ${table} WHERE ${foreignKey}=$1`, [id])
  return numberOr(rows[0]?.next_sort, 1)
}
async function nextChapterSort(bookId: number, parentId: number | null): Promise<number> {
  const rows = await getPostgresSql().unsafe(
    'SELECT COALESCE(MAX(sort), 0)::int + 1 AS next_sort FROM study_chapters WHERE book_id=$1 AND parent_id IS NOT DISTINCT FROM $2',
    [bookId, parentId]
  )
  return numberOr(rows[0]?.next_sort, 1)
}
async function validateDirectoryParent(bookId: number, parentId: number | null, movingId?: number): Promise<string | null> {
  if (parentId === null) return null
  if (movingId === parentId) return '目录不能移动到自身之下'
  const sql = getPostgresSql()
  const parentRows = await sql.unsafe('SELECT id,book_id FROM study_chapters WHERE id=$1', [parentId]) as Array<Record<string, unknown>>
  if (!parentRows[0] || numberOr(parentRows[0].book_id) !== bookId) return '父目录必须属于当前八股册'
  if (!movingId) return null
  const rows = await sql.unsafe(
    `WITH RECURSIVE ancestors AS (
       SELECT id,parent_id FROM study_chapters WHERE id=$1
       UNION ALL
       SELECT c.id,c.parent_id FROM study_chapters c JOIN ancestors a ON c.id=a.parent_id
     ) SELECT 1 FROM ancestors WHERE id=$2 LIMIT 1`,
    [parentId, movingId]
  )
  return rows.length ? '目录不能移动到自己的子目录中' : null
}
function rejectReadOnly(res: Response): boolean {
  res.status(403).json({ message: '这套公共八股册仅管理员可修改' })
  return false
}
/** 数据库级级联删除不会通知 OSS；删除内容前主动清理对应对象。 */
async function removeStudyAssetObjects(objectKeys: string[]): Promise<void> {
  if (!objectKeys.length) return
  const oss = loadOssConfig()
  if (!oss) return
  await Promise.all(objectKeys.map(async objectKey => {
    try { await ossDelete(oss, objectKey) }
    catch (error) { console.warn(`[study] OSS 图解清理失败: ${objectKey}`, error) }
  }))
}
async function studyAssetKeys(whereSql: string, params: unknown[]): Promise<string[]> {
  const rows = await getPostgresSql().unsafe(
    `SELECT a.object_key FROM study_assets a
     JOIN study_documents d ON d.id=a.document_id
     JOIN study_chapters c ON c.id=d.chapter_id
     WHERE ${whereSql}`,
    params
  ) as Array<Record<string, unknown>>
  return rows.map(row => String(row.object_key)).filter(Boolean)
}
function normalized(value: string): string { return value.trim().toLocaleLowerCase('zh-CN').replace(/[\s\-_（）()【】\[\]：:，,。.!！?？]/g, '') }
function safePath(value: unknown): string[] { return Array.isArray(value) ? value.map(item => text(item, 160)).filter(Boolean).slice(0, 6) : [] }
type PlannedUnit = { directory_key: string; book_title: string; path: string[]; document_title: string; summary: string; sections: Array<{ title: string; content: string }> }
function validateImportPlan(value: unknown): { units: PlannedUnit[] } {
  if (!value || typeof value !== 'object' || !Array.isArray((value as Record<string, unknown>).units)) throw new Error('缺少知识单元列表')
  const units = (value as Record<string, unknown>).units.slice(0, 30).map(raw => {
    if (!raw || typeof raw !== 'object') throw new Error('知识单元格式错误')
    const item = raw as Record<string, unknown>; const key = directoryKey(item.directory_key); const sections = Array.isArray(item.sections) ? item.sections.slice(0, 30).map(section => {
      const source = section as Record<string, unknown>; const title = text(source?.title, 240); const content = text(source?.content, 30_000); if (!title || !content) throw new Error('章节缺少标题或正文'); return { title, content }
    }) : []
    const bookTitle = text(item.book_title, 160); const documentTitle = text(item.document_title, 240)
    if (!key || !bookTitle || !documentTitle || !sections.length) throw new Error('知识单元缺少归属或正文')
    return { directory_key: key, book_title: bookTitle, path: safePath(item.path), document_title: documentTitle, summary: text(item.summary, 4_000), sections }
  })
  if (!units.length) throw new Error('没有识别到可导入的知识单元'); return { units }
}
async function importJobFor(req: Request, id: number, workspaceId: string): Promise<Record<string, unknown> | null> {
  const rows = await getPostgresSql().unsafe('SELECT * FROM study_import_jobs WHERE id=$1 AND (workspace_id=$2 OR created_by_user_id=$3)', [id, workspaceId, req.auth!.userId])
  return rows[0] as Record<string, unknown> | undefined ?? null
}

studyRouter.post('/imports/plan', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const raw = text(req.body?.text, 20_000); const visibility = req.body?.visibility === 'public' && req.auth?.isAdmin ? 'public' : 'private'
  if (!raw) return res.status(422).json({ message: '请粘贴需要整理的资料' })
  const schema = { type: 'object', additionalProperties: false, required: ['units'], properties: { units: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'object', additionalProperties: false, required: ['directory_key', 'book_title', 'path', 'document_title', 'summary', 'sections'], properties: { directory_key: { type: 'string', enum: [...STUDY_DIRECTORY_KEYS] }, book_title: { type: 'string' }, path: { type: 'array', items: { type: 'string' } }, document_title: { type: 'string' }, summary: { type: 'string' }, sections: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'content'], properties: { title: { type: 'string' }, content: { type: 'string' } } } } } } } } }
  try {
    const planned = await completeStructured([{ role: 'system', content: `你负责把混合面试资料拆成独立知识单元。每个单元必须归入一个固定大目录，并给出八股册、目录路径、文章主题和有序章节。不同技术主题必须拆开；不要编造；不要把不同主题合并。只返回 JSON。\n固定大目录：${STUDY_DIRECTORY_KEYS.join('、')}\nSchema：${JSON.stringify(schema)}` }, { role: 'user', content: `<untrusted_source_material>\n${raw}\n</untrusted_source_material>` }], { task: 'knowledgeExtract', schemaName: 'study_import_plan', schema, validate: validateImportPlan, workspaceId })
    const sql = getPostgresSql(); const jobRows = await sql.unsafe(`INSERT INTO study_import_jobs (workspace_id,visibility,source_text,created_by_user_id) VALUES ($1,$2,$3,$4) RETURNING *`, [visibility === 'public' ? null : workspaceId, visibility, raw, req.auth!.userId]); const job = jobRows[0] as Record<string, unknown>
    const items = []
    for (const [sort, unit] of planned.value.units.entries()) {
      const matches = await sql.unsafe(`SELECT d.id FROM study_documents d JOIN study_chapters c ON c.id=d.chapter_id JOIN study_books b ON b.id=c.book_id WHERE b.visibility=$1 AND b.directory_key=$2 AND lower(b.title)=lower($3) AND lower(d.title)=lower($4) LIMIT 1`, [visibility, unit.directory_key, unit.book_title, unit.document_title]) as Array<{ id: number }>
      const action = matches[0] ? 'needs_review' : 'create_document'; const reason = matches[0] ? '发现可能相同的已有文章，需按章节确认合并，不会自动覆盖' : '未发现同主题文章，将新建文章'
      const inserted = await sql.unsafe(`INSERT INTO study_import_items (job_id,sort,status,action,directory_key,book_title,path_json,document_title,summary,sections_json,target_document_id,match_confidence,reason) VALUES ($1,$2,'planned',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [job.id, sort + 1, action, unit.directory_key, unit.book_title, JSON.stringify(unit.path), unit.document_title, unit.summary, JSON.stringify(unit.sections), matches[0]?.id ?? null, matches[0] ? 65 : 100, reason])
      items.push(inserted[0])
    }
    res.status(201).json({ job, items })
  } catch (error) { res.status(error instanceof AiError ? error.statusCode : 502).json({ message: error instanceof Error ? error.message : 'AI 拆分失败' }) }
})

studyRouter.get('/imports/:id', async (req: Request, res: Response) => { const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '导入任务编号'); const job = id ? await importJobFor(req, id, workspaceId) : null; if (!job) return res.status(404).json({ message: '导入任务不存在' }); const items = await getPostgresSql().unsafe('SELECT * FROM study_import_items WHERE job_id=$1 ORDER BY sort,id', [id]); res.json({ job, items }) })

studyRouter.post('/imports/:id/apply', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '导入任务编号'); const job = id ? await importJobFor(req, id, workspaceId) : null
  if (!job) return res.status(404).json({ message: '导入任务不存在' }); if (job.visibility === 'public' && !req.auth?.isAdmin) return res.status(403).json({ message: '仅管理员可以发布公共八股资料' })
  const selected = Array.isArray(req.body?.item_ids) ? req.body.item_ids.map(value => parsePositiveId(value, '导入项编号')).filter(Boolean) : null
  const sql = getPostgresSql(); const items = await sql.unsafe(`SELECT * FROM study_import_items WHERE job_id=$1 AND status='planned'${selected?.length ? ` AND id = ANY($2::int[])` : ''} ORDER BY sort,id`, selected?.length ? [id, selected] : [id]) as Array<Record<string, unknown>>
  let created = 0; const skipped: number[] = []
  await sql.begin(async transaction => {
    for (const item of items) {
      if (item.action !== 'create_document') { skipped.push(numberOr(item.id)); continue }
      const visibility = String(job.visibility); const scope = visibility === 'public' ? null : workspaceId
      let books = await transaction.unsafe(`SELECT id FROM study_books WHERE visibility=$1 AND directory_key=$2 AND lower(title)=lower($3) AND workspace_id IS NOT DISTINCT FROM $4 LIMIT 1`, [visibility, item.directory_key, item.book_title, scope]) as Array<{ id: number }>
      let bookId = books[0]?.id
      if (!bookId) { const row = await transaction.unsafe(`INSERT INTO study_books (workspace_id,visibility,directory_key,title,description,created_by_user_id) VALUES ($1,$2,$3,$4,'',$5) RETURNING id`, [scope, visibility, item.directory_key, item.book_title, req.auth!.userId]); bookId = numberOr(row[0]?.id) }
      let parentId: number | null = null
      for (const segment of safePath(JSON.parse(String(item.path_json)))) {
        const found = await transaction.unsafe('SELECT id FROM study_chapters WHERE book_id=$1 AND parent_id IS NOT DISTINCT FROM $2 AND lower(title)=lower($3) LIMIT 1', [bookId, parentId, segment]) as Array<{ id: number }>
        if (found[0]) parentId = found[0].id
        else { const row = await transaction.unsafe(`INSERT INTO study_chapters (book_id,parent_id,title,sort) VALUES ($1,$2,$3,(SELECT COALESCE(MAX(sort),0)+1 FROM study_chapters WHERE book_id=$1 AND parent_id IS NOT DISTINCT FROM $2)) RETURNING id`, [bookId, parentId, segment]); parentId = numberOr(row[0]?.id) }
      }
      if (!parentId) { const row = await transaction.unsafe(`INSERT INTO study_chapters (book_id,title,sort) VALUES ($1,$2,(SELECT COALESCE(MAX(sort),0)+1 FROM study_chapters WHERE book_id=$1)) RETURNING id`, [bookId, item.document_title]); parentId = numberOr(row[0]?.id) }
      const sections = JSON.parse(String(item.sections_json)) as Array<{ title: string; content: string }>; const content = sections.map(section => `## ${section.title}\n\n${section.content}`).join('\n\n')
      const doc = await transaction.unsafe(`INSERT INTO study_documents (chapter_id,title,summary,content,source_name,sort) VALUES ($1,$2,$3,$4,'AI 批量导入',(SELECT COALESCE(MAX(sort),0)+1 FROM study_documents WHERE chapter_id=$1)) RETURNING id`, [parentId, item.document_title, item.summary, content])
      const documentId = numberOr(doc[0]?.id)
      for (const [sort, section] of sections.entries()) await transaction.unsafe('INSERT INTO study_document_sections (document_id,title,canonical_key,content,sort) VALUES ($1,$2,$3,$4,$5)', [documentId, section.title, normalized(section.title), section.content, sort + 1])
      await transaction.unsafe("UPDATE study_import_items SET status='applied',updated_at=now() WHERE id=$1", [item.id]); created++
    }
    await transaction.unsafe("UPDATE study_import_jobs SET status=CASE WHEN EXISTS(SELECT 1 FROM study_import_items WHERE job_id=$1 AND status='planned') THEN 'partially_applied' ELSE 'applied' END,updated_at=now() WHERE id=$1", [id])
  })
  res.json({ created, needs_review_item_ids: skipped })
})

studyRouter.get('/books', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req)
  const category = directoryKey(req.query.directory)
  const scope = req.query.scope === 'mine' ? 'mine' : req.query.scope === 'public' ? 'public' : 'all'
  const rows = await getPostgresSql().unsafe(
    `SELECT b.*,
      (SELECT COUNT(*)::int FROM study_chapters c WHERE c.book_id=b.id) AS chapter_count,
      (SELECT COUNT(*)::int FROM study_cards q JOIN study_chapters c ON c.id=q.chapter_id WHERE c.book_id=b.id) AS card_count,
      (SELECT COUNT(*)::int FROM study_documents d JOIN study_chapters c ON c.id=d.chapter_id WHERE c.book_id=b.id) AS document_count
     FROM study_books b
     WHERE (b.visibility='public' OR b.workspace_id=$1)
       AND ($2::text IS NULL OR b.directory_key=$2)
       AND ($3::text='all' OR ($3='public' AND b.visibility='public') OR ($3='mine' AND b.workspace_id=$1))
     ORDER BY CASE WHEN b.visibility='public' THEN 0 ELSE 1 END, b.updated_at DESC, b.id DESC`,
    [workspaceId, category, scope]
  )
  res.json(rows.map(row => exposeBook(row as Record<string, unknown>, canEdit(req, row as BookRow, workspaceId))))
})

studyRouter.post('/books', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req)
  const title = text(req.body?.title, 160); const key = directoryKey(req.body?.directory_key)
  if (!title || !key) return res.status(422).json({ message: '请填写八股册名称并选择目录' })
  const isPublic = req.auth?.isAdmin && req.body?.visibility === 'public'
  const rows = await getPostgresSql().unsafe(
    `INSERT INTO study_books (workspace_id,visibility,directory_key,title,description,created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [isPublic ? null : workspaceId, isPublic ? 'public' : 'private', key, title, text(req.body?.description, 2_000), req.auth!.userId]
  )
  res.status(201).json(exposeBook(rows[0] as Record<string, unknown>, true))
})

studyRouter.get('/books/:id', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '八股册编号')
  if (!id) return res.status(404).json({ message: '八股册不存在' })
  const book = await findAccessibleBook(id, workspaceId)
  if (!book) return res.status(404).json({ message: '八股册不存在或无权访问' })
  const sql = getPostgresSql()
  const [chapters, cards, documents] = await Promise.all([
    sql.unsafe('SELECT * FROM study_chapters WHERE book_id=$1 ORDER BY sort,id', [id]),
    sql.unsafe(`SELECT q.*,COALESCE(p.familiarity,0) AS familiarity,COALESCE(p.note,'') AS note,p.last_opened_at
      FROM study_cards q JOIN study_chapters c ON c.id=q.chapter_id
      LEFT JOIN study_card_progress p ON p.card_id=q.id AND p.user_id=$2
      WHERE c.book_id=$1 ORDER BY c.sort,c.id,q.sort,q.id`, [id, req.auth!.userId])
    , sql.unsafe(`SELECT d.* FROM study_documents d JOIN study_chapters c ON c.id=d.chapter_id
      WHERE c.book_id=$1 ORDER BY c.sort,c.id,d.sort,d.id`, [id])
  ])
  const cardMap = new Map<number, Record<string, unknown>[]>()
  for (const row of cards as Record<string, unknown>[]) {
    const chapterId = numberOr(row.chapter_id)
    cardMap.set(chapterId, [...(cardMap.get(chapterId) ?? []), exposeCard(row)])
  }
  const documentMap = new Map<number, Record<string, unknown>[]>()
  for (const row of documents as Record<string, unknown>[]) {
    const chapterId = numberOr(row.chapter_id)
    documentMap.set(chapterId, [...(documentMap.get(chapterId) ?? []), row])
  }
  res.json({
    book: exposeBook(book, canEdit(req, book, workspaceId)),
    chapters: (chapters as Record<string, unknown>[]).map(chapter => ({ ...chapter, cards: cardMap.get(numberOr(chapter.id)) ?? [], documents: documentMap.get(numberOr(chapter.id)) ?? [] }))
  })
})

studyRouter.put('/books/:id', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '八股册编号')
  const book = id ? await findAccessibleBook(id, workspaceId) : null
  if (!book) return res.status(404).json({ message: '八股册不存在' })
  if (!canEdit(req, book, workspaceId)) return rejectReadOnly(res)
  const title = Object.hasOwn(req.body ?? {}, 'title') ? text(req.body.title, 160) : String(book.title)
  const key = Object.hasOwn(req.body ?? {}, 'directory_key') ? directoryKey(req.body.directory_key) : String(book.directory_key)
  if (!title || !key) return res.status(422).json({ message: '请填写八股册名称并选择目录' })
  const rows = await getPostgresSql().unsafe(`UPDATE study_books SET title=$2,directory_key=$3,description=$4,updated_at=now() WHERE id=$1 RETURNING *`,
    [id, title, key, Object.hasOwn(req.body ?? {}, 'description') ? text(req.body.description, 2_000) : String(book.description ?? '')])
  res.json(exposeBook(rows[0] as Record<string, unknown>, true))
})

studyRouter.delete('/books/:id', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '八股册编号')
  const book = id ? await findAccessibleBook(id, workspaceId) : null
  if (!book) return res.status(404).json({ message: '八股册不存在' })
  if (!canEdit(req, book, workspaceId)) return rejectReadOnly(res)
  const assetKeys = await studyAssetKeys('c.book_id=$1', [id])
  await getPostgresSql().unsafe('DELETE FROM study_books WHERE id=$1', [id])
  await removeStudyAssetObjects(assetKeys)
  res.json({ ok: true })
})

studyRouter.post('/books/:id/chapters', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '八股册编号')
  const book = id ? await findAccessibleBook(id, workspaceId) : null; const title = text(req.body?.title, 160)
  if (!book) return res.status(404).json({ message: '八股册不存在' }); if (!canEdit(req, book, workspaceId)) return rejectReadOnly(res)
  if (!title) return res.status(422).json({ message: '章节名称不能为空' })
  const parentId = req.body?.parent_id == null ? null : parsePositiveId(req.body.parent_id, '父目录编号')
  if (req.body?.parent_id != null && !parentId) return res.status(422).json({ message: '父目录编号无效' })
  const parentError = await validateDirectoryParent(id, parentId)
  if (parentError) return res.status(422).json({ message: parentError })
  const rows = await getPostgresSql().unsafe('INSERT INTO study_chapters (book_id,parent_id,title,sort) VALUES ($1,$2,$3,$4) RETURNING *', [id, parentId, title, await nextChapterSort(id, parentId)])
  res.status(201).json(rows[0])
})

studyRouter.put('/chapters/:id', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '章节编号')
  const book = id ? await bookForChapter(id, workspaceId) : null
  if (!book) return res.status(404).json({ message: '章节不存在' }); if (!canEdit(req, book, workspaceId)) return rejectReadOnly(res)
  const current = await getPostgresSql().unsafe('SELECT * FROM study_chapters WHERE id=$1', [id]) as Array<Record<string, unknown>>
  if (!current[0]) return res.status(404).json({ message: '章节不存在' })
  const title = Object.hasOwn(req.body ?? {}, 'title') ? text(req.body.title, 160) : String(current[0].title)
  if (!title) return res.status(422).json({ message: '章节名称不能为空' })
  const parentId = Object.hasOwn(req.body ?? {}, 'parent_id') ? (req.body.parent_id == null ? null : parsePositiveId(req.body.parent_id, '父目录编号')) : numberOr(current[0].parent_id, 0) || null
  if (Object.hasOwn(req.body ?? {}, 'parent_id') && req.body.parent_id != null && !parentId) return res.status(422).json({ message: '父目录编号无效' })
  const parentError = await validateDirectoryParent(Number(book.id), parentId, id)
  if (parentError) return res.status(422).json({ message: parentError })
  const rows = await getPostgresSql().unsafe('UPDATE study_chapters SET parent_id=$2,title=$3,updated_at=now() WHERE id=$1 RETURNING *', [id, parentId, title])
  res.json(rows[0])
})

studyRouter.delete('/chapters/:id', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '章节编号')
  const book = id ? await bookForChapter(id, workspaceId) : null
  if (!book) return res.status(404).json({ message: '章节不存在' }); if (!canEdit(req, book, workspaceId)) return rejectReadOnly(res)
  const assetKeys = await studyAssetKeys(`c.id IN (
    WITH RECURSIVE subtree AS (
      SELECT id FROM study_chapters WHERE id=$1
      UNION ALL SELECT child.id FROM study_chapters child JOIN subtree parent ON child.parent_id=parent.id
    ) SELECT id FROM subtree
  )`, [id])
  await getPostgresSql().unsafe('DELETE FROM study_chapters WHERE id=$1', [id])
  await removeStudyAssetObjects(assetKeys); res.json({ ok: true })
})

studyRouter.post('/chapters/:id/documents', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const chapterId = parsePositiveId(req.params.id, '目录编号')
  const book = chapterId ? await bookForChapter(chapterId, workspaceId) : null
  if (!book) return res.status(404).json({ message: '目录不存在' }); if (!canEdit(req, book, workspaceId)) return rejectReadOnly(res)
  const title = text(req.body?.title, 240); if (!title) return res.status(422).json({ message: '文章标题不能为空' })
  const rows = await getPostgresSql().unsafe(`INSERT INTO study_documents (chapter_id,title,summary,content,source_url,source_name,sort)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [chapterId, title, text(req.body?.summary, 4_000), text(req.body?.content, 80_000), text(req.body?.source_url, 2_000) || null, text(req.body?.source_name, 240) || null, await nextSort('study_documents', 'chapter_id', chapterId)])
  res.status(201).json(rows[0])
})

studyRouter.put('/documents/:id', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '文章编号')
  const rows = id ? await getPostgresSql().unsafe(`SELECT d.* FROM study_documents d JOIN study_chapters c ON c.id=d.chapter_id JOIN study_books b ON b.id=c.book_id WHERE d.id=$1 AND (b.visibility='public' OR b.workspace_id=$2)`, [id, workspaceId]) as Array<Record<string, unknown>> : []
  const current = rows[0]; const book = id ? await bookForChapter(numberOr(current?.chapter_id), workspaceId) : null
  if (!current || !book) return res.status(404).json({ message: '文章不存在' }); if (!canEdit(req, book, workspaceId)) return rejectReadOnly(res)
  const title = Object.hasOwn(req.body ?? {}, 'title') ? text(req.body.title, 240) : String(current.title); if (!title) return res.status(422).json({ message: '文章标题不能为空' })
  const chapterId = Object.hasOwn(req.body ?? {}, 'chapter_id') ? parsePositiveId(req.body.chapter_id, '目录编号') : numberOr(current.chapter_id)
  const destination = chapterId ? await bookForChapter(chapterId, workspaceId) : null
  if (!chapterId || !destination || destination.id !== book.id) return res.status(422).json({ message: '文章只能移动到当前八股册内的目录' })
  const updated = await getPostgresSql().unsafe(`UPDATE study_documents SET chapter_id=$2,title=$3,summary=$4,content=$5,source_url=$6,source_name=$7,updated_at=now() WHERE id=$1 RETURNING *`, [id, chapterId, title, Object.hasOwn(req.body ?? {}, 'summary') ? text(req.body.summary, 4_000) : String(current.summary ?? ''), Object.hasOwn(req.body ?? {}, 'content') ? text(req.body.content, 80_000) : String(current.content ?? ''), Object.hasOwn(req.body ?? {}, 'source_url') ? text(req.body.source_url, 2_000) || null : current.source_url, Object.hasOwn(req.body ?? {}, 'source_name') ? text(req.body.source_name, 240) || null : current.source_name])
  res.json(updated[0])
})

studyRouter.delete('/documents/:id', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '文章编号')
  const rows = id ? await getPostgresSql().unsafe(`SELECT c.id AS chapter_id FROM study_documents d JOIN study_chapters c ON c.id=d.chapter_id JOIN study_books b ON b.id=c.book_id WHERE d.id=$1 AND (b.visibility='public' OR b.workspace_id=$2)`, [id, workspaceId]) as Array<Record<string, unknown>> : []
  const book = rows[0] ? await bookForChapter(numberOr(rows[0].chapter_id), workspaceId) : null
  if (!book) return res.status(404).json({ message: '文章不存在' }); if (!canEdit(req, book, workspaceId)) return rejectReadOnly(res)
  const assetKeys = await studyAssetKeys('d.id=$1', [id])
  await getPostgresSql().unsafe('DELETE FROM study_documents WHERE id=$1', [id])
  await removeStudyAssetObjects(assetKeys); res.json({ ok: true })
})

async function accessibleStudyDocument(id: number, workspaceId: string): Promise<{ document: Record<string, unknown>; book: BookRow } | null> {
  const rows = await getPostgresSql().unsafe(`SELECT d.*,b.id AS book_id,b.workspace_id AS book_workspace_id,b.visibility AS book_visibility
    FROM study_documents d JOIN study_chapters c ON c.id=d.chapter_id JOIN study_books b ON b.id=c.book_id
    WHERE d.id=$1 AND (b.visibility='public' OR b.workspace_id=$2)`, [id, workspaceId]) as Array<Record<string, unknown>>
  const row = rows[0]; if (!row) return null
  return { document: row, book: { id: numberOr(row.book_id), workspace_id: typeof row.book_workspace_id === 'string' ? row.book_workspace_id : null, visibility: String(row.book_visibility) } as BookRow }
}

studyRouter.post('/documents/:id/assets', studyImageUpload.single('image'), async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const documentId = parsePositiveId(req.params.id, '文章编号'); const file = req.file
  const cleanup = () => { try { if (file?.path) unlinkSync(file.path) } catch {} }
  let uploaded: { objectKey: string; oss: NonNullable<ReturnType<typeof loadOssConfig>> } | null = null
  try {
    const access = documentId ? await accessibleStudyDocument(documentId, workspaceId) : null
    if (!access) return res.status(404).json({ message: '文章不存在' }); if (!canEdit(req, access.book, workspaceId)) return rejectReadOnly(res)
    if (!file) return res.status(422).json({ message: '请选择图片文件' })
    const bytes = readFileSync(file.path); const image = inspectImage(bytes)
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(image.mime)) return res.status(422).json({ message: '仅支持 PNG、JPEG、静态 WebP 图片' })
    const oss = loadOssConfig(); if (!oss) return res.status(422).json({ message: 'OSS 未配置，无法保存八股图解' })
    const scope = access.book.visibility === 'public' ? 'public' : `workspaces/${workspaceId}`
    const assetId = randomUUID(); const objectKey = `job-tracer/study-assets/${scope}/${documentId}/${assetId}.${image.ext}`
    await ossPut(oss, objectKey, file.path, image.mime)
    uploaded = { objectKey, oss }
    const rows = await getPostgresSql().unsafe(`INSERT INTO study_assets (id,document_id,object_key,original_name,mime,bytes,width,height,content_hash,alt)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [assetId, documentId, objectKey, path.basename(file.originalname).slice(0, 240), image.mime, bytes.length, image.width, image.height, createHash('sha256').update(bytes).digest('hex'), text(req.body?.alt, 500)])
    res.status(201).json({ ...rows[0], markdown: `![${text(req.body?.alt, 500) || '图解'}](/api/study/assets/${assetId})` })
  } catch (error) {
    if (uploaded) await ossDelete(uploaded.oss, uploaded.objectKey).catch(cleanupError => console.warn('[study] 失败上传的 OSS 图解清理失败', cleanupError))
    res.status(error instanceof AiError ? error.statusCode : 422).json({ message: error instanceof Error ? error.message : '图片上传失败' })
  } finally { cleanup() }
})

studyRouter.get('/assets/:id', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = typeof req.params.id === 'string' ? req.params.id : ''
  const rows = await getPostgresSql().unsafe(`SELECT a.object_key,b.workspace_id,b.visibility FROM study_assets a JOIN study_documents d ON d.id=a.document_id JOIN study_chapters c ON c.id=d.chapter_id JOIN study_books b ON b.id=c.book_id WHERE a.id=$1 AND (b.visibility='public' OR b.workspace_id=$2)`, [id, workspaceId]) as Array<Record<string, unknown>>
  const row = rows[0]; if (!row) return res.status(404).json({ message: '图片不存在或无权访问' })
  const oss = loadOssConfig(); if (!oss) return res.status(503).json({ message: 'OSS 未配置' })
  res.redirect(302, ossSignedUrl(oss, String(row.object_key), 300))
})

studyRouter.use((error: unknown, _req: Request, res: Response, next: (error: unknown) => void) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE' ? '图片大小不能超过 5MB' : '图片上传参数不正确'
    return res.status(422).json({ message })
  }
  next(error)
})

/** 用户主动粘贴的资料由模型整理为一篇可阅读的 Markdown；不会抓取或转载外部网页。 */
studyRouter.post('/books/:id/ai-parse', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '八股册编号')
  const book = id ? await findAccessibleBook(id, workspaceId) : null
  if (!book) return res.status(404).json({ message: '八股册不存在' }); if (!canEdit(req, book, workspaceId)) return rejectReadOnly(res)
  const raw = text(req.body?.text, 20_000); const chapterId = parsePositiveId(req.body?.chapter_id, '目录编号')
  const destination = chapterId ? await bookForChapter(chapterId, workspaceId) : null
  if (!raw) return res.status(422).json({ message: '请先粘贴需要整理的资料' })
  if (!destination || destination.id !== book.id) return res.status(422).json({ message: '请选择当前八股册中的目录' })
  const schema = { type: 'object', additionalProperties: false, required: ['title', 'summary', 'content'], properties: {
    title: { type: 'string', minLength: 1, maxLength: 240 }, summary: { type: 'string', maxLength: 4000 }, content: { type: 'string', minLength: 1, maxLength: 80000 }
  } }
  try {
    const result = await completeStructured([{ role: 'system', content: `你是面试知识整理助手。把用户主动提供的资料整理成准确、可阅读的中文 Markdown 文章。保留事实和关键术语；使用二级、三级标题、列表、必要的代码块；不要编造资料中没有的结论。只返回符合下列 JSON Schema 的 JSON 对象，不要 Markdown 围栏、解释、前言或题卡。\n\nJSON Schema:\n${JSON.stringify(schema)}` }, { role: 'user', content: `<untrusted_source_material>\n${raw}\n</untrusted_source_material>` }], { task: 'knowledgeExtract', schemaName: 'study_document', schema, validate: value => {
      if (!value || typeof value !== 'object') throw new Error('结果不是对象')
      const item = value as Record<string, unknown>
      if (typeof item.title !== 'string' || !item.title.trim()) throw new Error('缺少文章标题')
      if (typeof item.summary !== 'string') throw new Error('摘要格式错误')
      if (typeof item.content !== 'string' || !item.content.trim()) throw new Error('缺少文章正文')
      return { title: item.title, summary: item.summary, content: item.content }
    }, workspaceId })
    res.json({ title: text(result.value.title, 240), summary: text(result.value.summary, 4000), content: text(result.value.content, 80_000) })
  } catch (error) { res.status(error instanceof AiError ? error.statusCode : 502).json({ message: error instanceof Error ? error.message : 'AI 解析失败' }) }
})

studyRouter.post('/chapters/:id/cards', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const chapterId = parsePositiveId(req.params.id, '章节编号')
  const book = chapterId ? await bookForChapter(chapterId, workspaceId) : null; const question = text(req.body?.question, 2_000)
  if (!book) return res.status(404).json({ message: '章节不存在' }); if (!canEdit(req, book, workspaceId)) return rejectReadOnly(res)
  if (!question) return res.status(422).json({ message: '题目不能为空' })
  const rows = await getPostgresSql().unsafe(`INSERT INTO study_cards (chapter_id,question,summary,answer,followups_json,tags_json,difficulty,sort)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [chapterId, question, text(req.body?.summary, 4_000), text(req.body?.answer), JSON.stringify(jsonList(req.body?.followups)), JSON.stringify(jsonList(req.body?.tags)), ['基础', '进阶', '深入'].includes(req.body?.difficulty) ? req.body.difficulty : '基础', await nextSort('study_cards', 'chapter_id', chapterId)])
  res.status(201).json(exposeCard(rows[0] as Record<string, unknown>))
})

studyRouter.put('/cards/:id', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '题目编号')
  const book = id ? await bookForCard(id, workspaceId) : null
  if (!book) return res.status(404).json({ message: '题目不存在' }); if (!canEdit(req, book, workspaceId)) return rejectReadOnly(res)
  const current = await getPostgresSql().unsafe('SELECT * FROM study_cards WHERE id=$1', [id]) as Array<Record<string, unknown>>
  if (!current[0]) return res.status(404).json({ message: '题目不存在' })
  const question = Object.hasOwn(req.body ?? {}, 'question') ? text(req.body.question, 2_000) : String(current[0].question)
  if (!question) return res.status(422).json({ message: '题目不能为空' })
  const chapterId = Object.hasOwn(req.body ?? {}, 'chapter_id') ? parsePositiveId(req.body.chapter_id, '章节编号') : numberOr(current[0].chapter_id)
  const destinationBook = chapterId ? await bookForChapter(chapterId, workspaceId) : null
  if (!chapterId || !destinationBook || destinationBook.id !== book.id) return res.status(422).json({ message: '只能移动到当前八股册内的章节' })
  const rows = await getPostgresSql().unsafe(`UPDATE study_cards SET chapter_id=$2,question=$3,summary=$4,answer=$5,followups_json=$6,tags_json=$7,difficulty=$8,updated_at=now() WHERE id=$1 RETURNING *`, [id, chapterId, question,
    Object.hasOwn(req.body ?? {}, 'summary') ? text(req.body.summary, 4_000) : String(current[0].summary ?? ''),
    Object.hasOwn(req.body ?? {}, 'answer') ? text(req.body.answer) : String(current[0].answer ?? ''),
    Object.hasOwn(req.body ?? {}, 'followups') ? JSON.stringify(jsonList(req.body.followups)) : String(current[0].followups_json),
    Object.hasOwn(req.body ?? {}, 'tags') ? JSON.stringify(jsonList(req.body.tags)) : String(current[0].tags_json),
    ['基础', '进阶', '深入'].includes(req.body?.difficulty) ? req.body.difficulty : String(current[0].difficulty ?? '基础')])
  res.json(exposeCard(rows[0] as Record<string, unknown>))
})

studyRouter.delete('/cards/:id', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '题目编号')
  const book = id ? await bookForCard(id, workspaceId) : null
  if (!book) return res.status(404).json({ message: '题目不存在' }); if (!canEdit(req, book, workspaceId)) return rejectReadOnly(res)
  await getPostgresSql().unsafe('DELETE FROM study_cards WHERE id=$1', [id]); res.json({ ok: true })
})

studyRouter.put('/cards/:id/progress', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '题目编号')
  const book = id ? await bookForCard(id, workspaceId) : null
  if (!book) return res.status(404).json({ message: '题目不存在或无权访问' })
  const familiarity = [0, 1, 2].includes(Number(req.body?.familiarity)) ? Number(req.body.familiarity) : 0
  const note = Object.hasOwn(req.body ?? {}, 'note') ? text(req.body.note, 10_000) : null
  const rows = await getPostgresSql().unsafe(`INSERT INTO study_card_progress (user_id,card_id,familiarity,note,last_opened_at,updated_at)
    VALUES ($1,$2,$3,COALESCE($4,''),now(),now())
    ON CONFLICT (user_id,card_id) DO UPDATE SET familiarity=EXCLUDED.familiarity,note=COALESCE($4,study_card_progress.note),last_opened_at=now(),updated_at=now()
    RETURNING familiarity,note,last_opened_at,updated_at`, [req.auth!.userId, id, familiarity, note])
  res.json(rows[0])
})
