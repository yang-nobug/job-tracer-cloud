import { Router } from 'express'
import type { Request, Response } from 'express'
import { getPostgresSql } from '../database/client.js'
import { parsePositiveId, requireWorkspaceId } from '../auth/workspace.js'

/** 固定知识地图。它只负责目录归类，不会自动生成学习任务或复习提醒。 */
export const STUDY_DIRECTORY_KEYS = [
  'computer-basics', 'language-runtime', 'data-backend', 'frontend-browser',
  'cloud-engineering', 'ai-llm', 'project-interview', 'custom'
] as const

export const studyRouter = Router()

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
      (SELECT COUNT(*)::int FROM study_cards q JOIN study_chapters c ON c.id=q.chapter_id WHERE c.book_id=b.id) AS card_count
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
async function nextSort(table: 'study_chapters' | 'study_cards', foreignKey: 'book_id' | 'chapter_id', id: number): Promise<number> {
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

studyRouter.get('/books', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req)
  const category = directoryKey(req.query.directory)
  const scope = req.query.scope === 'mine' ? 'mine' : req.query.scope === 'public' ? 'public' : 'all'
  const rows = await getPostgresSql().unsafe(
    `SELECT b.*,
      (SELECT COUNT(*)::int FROM study_chapters c WHERE c.book_id=b.id) AS chapter_count,
      (SELECT COUNT(*)::int FROM study_cards q JOIN study_chapters c ON c.id=q.chapter_id WHERE c.book_id=b.id) AS card_count
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
  const [chapters, cards] = await Promise.all([
    sql.unsafe('SELECT * FROM study_chapters WHERE book_id=$1 ORDER BY sort,id', [id]),
    sql.unsafe(`SELECT q.*,COALESCE(p.familiarity,0) AS familiarity,COALESCE(p.note,'') AS note,p.last_opened_at
      FROM study_cards q JOIN study_chapters c ON c.id=q.chapter_id
      LEFT JOIN study_card_progress p ON p.card_id=q.id AND p.user_id=$2
      WHERE c.book_id=$1 ORDER BY c.sort,c.id,q.sort,q.id`, [id, req.auth!.userId])
  ])
  const cardMap = new Map<number, Record<string, unknown>[]>()
  for (const row of cards as Record<string, unknown>[]) {
    const chapterId = numberOr(row.chapter_id)
    cardMap.set(chapterId, [...(cardMap.get(chapterId) ?? []), exposeCard(row)])
  }
  res.json({
    book: exposeBook(book, canEdit(req, book, workspaceId)),
    chapters: (chapters as Record<string, unknown>[]).map(chapter => ({ ...chapter, cards: cardMap.get(numberOr(chapter.id)) ?? [] }))
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
  await getPostgresSql().unsafe('DELETE FROM study_books WHERE id=$1', [id])
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
  await getPostgresSql().unsafe('DELETE FROM study_chapters WHERE id=$1', [id]); res.json({ ok: true })
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
