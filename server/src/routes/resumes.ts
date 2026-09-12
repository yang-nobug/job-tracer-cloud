import { Router } from 'express'
import type { Request, Response } from 'express'
import multer from 'multer'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getPostgresSql } from '../database/client.js'
import { parsePositiveId, requireWorkspaceId } from '../auth/workspace.js'
import { WORKSPACE_RESUMES_DIR } from '../data-paths.js'
import { cloudResumePath, cloudResumeWithText, listCloudResumes, requestCloudResumeExtraction } from '../cloud-resume-text.js'

export const resumesRouter = Router()
const allowedExtensions = ['.pdf', '.doc', '.docx']
mkdirSync(WORKSPACE_RESUMES_DIR, { recursive: true })

function fixedFilename(name: string): string {
  const bytes = Buffer.from(name, 'latin1'); const decoded = bytes.toString('utf8')
  return decoded !== name && Buffer.from(decoded, 'utf8').equals(bytes) ? decoded : name
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, callback) => {
      const workspaceId = req.auth?.workspaceId
      if (!workspaceId) return callback(new Error('当前账号没有可用工作区'), '')
      const directory = path.join(WORKSPACE_RESUMES_DIR, workspaceId)
      mkdirSync(directory, { recursive: true })
      callback(null, directory)
    },
    filename: (_req, file, callback) => callback(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase()
    callback(null, allowedExtensions.includes(extension))
  }
})

async function ownedResume(workspaceId: string, id: number): Promise<{ id: number; filename: string; stored_name: string } | null> {
  const rows = await getPostgresSql().unsafe('SELECT id,filename,stored_name FROM resumes WHERE workspace_id=$1 AND id=$2', [workspaceId, id]) as Array<{ id: number; filename: string; stored_name: string }>
  return rows[0] ?? null
}

resumesRouter.get('/', async (req: Request, res: Response) => {
  res.json(await listCloudResumes(requireWorkspaceId(req)))
})

resumesRouter.post('/', upload.single('file'), async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req)
  if (!req.file) return res.status(422).json({ message: '请选择 PDF / Word 文件' })
  const extension = path.extname(req.file.originalname).toLowerCase()
  if (!allowedExtensions.includes(extension)) {
    try { unlinkSync(req.file.path) } catch { /* 无需覆盖原始错误 */ }
    return res.status(422).json({ message: '仅支持 PDF / Word 文件' })
  }
  try {
    const rows = await getPostgresSql().unsafe(
      `INSERT INTO resumes (workspace_id,filename,stored_name,size,note) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [workspaceId, fixedFilename(req.file.originalname), req.file.filename, req.file.size, typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 80) || null : null]
    ) as Array<{ id: number }>
    res.status(202).json(await requestCloudResumeExtraction(workspaceId, rows[0].id))
  } catch (error) {
    try { unlinkSync(req.file.path) } catch { /* 无需覆盖数据库错误 */ }
    throw error
  }
})

resumesRouter.post('/:id/extract', async (req: Request, res: Response) => {
  const id = parsePositiveId(req.params.id, '简历编号')
  if (!id) return res.status(422).json({ message: '简历编号无效' })
  try { res.status(202).json(await requestCloudResumeExtraction(requireWorkspaceId(req), id)) }
  catch (error) { res.status(404).json({ message: (error as Error).message || '简历不存在' }) }
})

resumesRouter.get('/:id/file', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '简历编号')
  if (!id) return res.status(404).json({ message: '简历不存在' })
  const resume = await ownedResume(workspaceId, id)
  if (!resume) return res.status(404).json({ message: '简历不存在' })
  const file = cloudResumePath(workspaceId, resume.stored_name)
  if (!existsSync(file)) return res.status(404).json({ message: '简历文件已丢失' })
  res.setHeader('Content-Type', path.extname(resume.stored_name).toLowerCase() === '.pdf' ? 'application/pdf' : 'application/octet-stream')
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(resume.filename)}`)
  res.sendFile(file)
})

resumesRouter.get('/:id/text', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '简历编号')
  if (!id || !await ownedResume(workspaceId, id)) return res.status(404).json({ message: '简历不存在' })
  const rows = await getPostgresSql().unsafe(
    `SELECT r.id AS resume_id,r.filename,t.text_content AS text,t.extraction_method,t.model AS extraction_model,t.page_count,t.extracted_at
     FROM resumes r JOIN resume_texts t ON t.resume_id=r.id AND t.workspace_id=r.workspace_id
     WHERE r.workspace_id=$1 AND r.id=$2 AND t.status='completed' AND length(COALESCE(t.text_content,''))>0`, [workspaceId, id]
  )
  if (!rows.length) return res.status(409).json({ message: '简历文字尚未提取完成' })
  res.json(rows[0])
})

resumesRouter.delete('/:id', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '简历编号')
  if (!id) return res.status(404).json({ message: '简历不存在' })
  const resume = await ownedResume(workspaceId, id)
  if (!resume) return res.status(404).json({ message: '简历不存在' })
  const sql = getPostgresSql()
  await sql.begin(async transaction => {
    await transaction.unsafe('UPDATE applications SET resume_id=NULL,updated_at=now() WHERE workspace_id=$1 AND resume_id=$2', [workspaceId, id])
    await transaction.unsafe('DELETE FROM resumes WHERE workspace_id=$1 AND id=$2', [workspaceId, id])
  })
  try { unlinkSync(cloudResumePath(workspaceId, resume.stored_name)) } catch { /* 文件已丢失不影响数据库删除 */ }
  res.json({ ok: true })
})
