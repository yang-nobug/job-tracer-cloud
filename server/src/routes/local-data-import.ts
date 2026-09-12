import { Router } from 'express'
import type { Request, Response } from 'express'
import multer from 'multer'
import AdmZip from 'adm-zip'
import Database from 'better-sqlite3'
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getPostgresSql } from '../database/client.js'
import { requireWorkspaceId } from '../auth/workspace.js'
import {
  DATA_DIR,
  WORKSPACE_APPLICATION_MATERIALS_DIR,
  WORKSPACE_KNOWLEDGE_IMAGES_DIR,
  WORKSPACE_RESUMES_DIR
} from '../data-paths.js'

/**
 * 将旧版 data 目录压缩包迁入当前账号的个人工作区。
 * 只读取明确支持的数据与附件；绝不解压 secrets、浏览器配置或自动化目录。
 */
export const localDataImportRouter = Router()

const IMPORTS_DIR = path.join(DATA_DIR, 'local-data-imports')
const MAX_ARCHIVE_BYTES = 300 * 1024 * 1024
const MAX_UNCOMPRESSED_BYTES = 420 * 1024 * 1024
const MAX_ENTRIES = 12_000

mkdirSync(IMPORTS_DIR, { recursive: true })

class LocalDataImportError extends Error {
  constructor(message: string, public readonly status = 422) { super(message) }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, IMPORTS_DIR),
    filename: (_req, file, callback) => callback(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase() || '.zip'}`)
  }),
  limits: { files: 1, fileSize: MAX_ARCHIVE_BYTES },
  fileFilter: (_req, file, callback) => callback(null, path.extname(file.originalname).toLowerCase() === '.zip')
})

type LegacyRow = Record<string, unknown>
type ImportResult = {
  applications: number
  events: number
  interviews: number
  checklistItems: number
  resumes: number
  resumeTexts: number
  knowledgeSources: number
  knowledgeItems: number
  knowledgeImages: number
  answerVersions: number
  applicationImports: number
  applicationMaterials: number
  missingFiles: number
  skippedDrafts: number
}

function text(value: unknown, max = 20_000): string | null {
  if (value === null || value === undefined) return null
  const normalized = String(value).replace(/\u0000/g, '').trim()
  return normalized ? normalized.slice(0, max) : null
}

function required(value: unknown, fallback: string, max = 20_000): string {
  return text(value, max) ?? fallback
}

function numberValue(value: unknown, fallback = 0): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.trunc(number) : fallback
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true'
}

function timestamp(value: unknown): string {
  const raw = text(value)
  if (!raw) return new Date().toISOString()
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

function zipName(value: string): string {
  const name = value.replace(/\\/g, '/')
  if (!name || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new LocalDataImportError('压缩包包含不安全的文件路径')
  const parts = name.split('/').filter(Boolean)
  if (parts.some(part => part === '.' || part === '..')) throw new LocalDataImportError('压缩包包含不安全的文件路径')
  return parts.join('/')
}

function safeLeaf(value: unknown): string | null {
  const raw = text(value, 180)
  if (!raw) return null
  const leaf = path.basename(raw).replace(/[\\/:*?"<>|]/g, '_')
  return leaf && leaf !== '.' && leaf !== '..' ? leaf : null
}

function extension(...values: unknown[]): string {
  for (const value of values) {
    const candidate = safeLeaf(value)
    const ext = candidate ? path.extname(candidate).toLowerCase() : ''
    if (/^\.[a-z0-9]{1,10}$/.test(ext)) return ext
  }
  return ''
}

function archiveEntries(archivePath: string): Map<string, AdmZip.IZipEntry> {
  let zip: AdmZip
  try { zip = new AdmZip(archivePath) } catch { throw new LocalDataImportError('无法打开 ZIP 文件，请确认上传的是完整的 data 压缩包') }
  const entries = zip.getEntries()
  if (!entries.length || entries.length > MAX_ENTRIES) throw new LocalDataImportError('压缩包文件数量异常')
  let totalSize = 0
  const normalized = entries.filter(entry => !entry.isDirectory).map(entry => ({ entry, name: zipName(entry.entryName) }))
  for (const item of normalized) {
    totalSize += Number(item.entry.header.size) || 0
    if (totalSize > MAX_UNCOMPRESSED_BYTES) throw new LocalDataImportError('压缩包解压后的数据超过 420MB，暂不支持导入')
  }
  const databaseEntries = normalized.filter(item => item.name === 'job-tracer.db' || item.name.endsWith('/job-tracer.db'))
  if (databaseEntries.length !== 1) throw new LocalDataImportError('压缩包中应且只能包含一个 job-tracer.db；请直接压缩 F:\\job-tracer\\data 目录')
  const databaseName = databaseEntries[0].name
  const root = databaseName.slice(0, -'job-tracer.db'.length)
  const files = new Map<string, AdmZip.IZipEntry>()
  for (const item of normalized) {
    if (!item.name.startsWith(root)) continue
    const relative = item.name.slice(root.length)
    if (!relative || files.has(relative)) throw new LocalDataImportError('压缩包存在重复或无效的文件路径')
    files.set(relative, item.entry)
  }
  if (!files.has('job-tracer.db')) throw new LocalDataImportError('未找到本地数据库文件 job-tracer.db')
  return files
}

function readableRows(database: Database.Database, table: string): LegacyRow[] {
  const allowed = new Set(['applications', 'application_events', 'interviews', 'checklist_items', 'resumes', 'resume_texts', 'knowledge_sources', 'knowledge_items', 'knowledge_images', 'knowledge_answer_versions', 'application_imports', 'application_materials'])
  if (!allowed.has(table)) return []
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
  return exists ? database.prepare(`SELECT * FROM ${table}`).all() as LegacyRow[] : []
}

function clearWorkspaceFiles(workspaceId: string): void {
  for (const root of [WORKSPACE_RESUMES_DIR, WORKSPACE_KNOWLEDGE_IMAGES_DIR, WORKSPACE_APPLICATION_MATERIALS_DIR]) {
    rmSync(path.join(root, workspaceId), { recursive: true, force: true })
  }
}

function ensureDirectory(file: string): void { mkdirSync(path.dirname(file), { recursive: true }) }

function writeArchiveFile(entries: Map<string, AdmZip.IZipEntry>, relative: string, destination: string): boolean {
  const entry = entries.get(relative)
  if (!entry) return false
  ensureDirectory(destination)
  writeFileSync(destination, entry.getData(), { flag: 'wx' })
  return true
}

function fileEntry(directory: string, storedName: unknown): string | null {
  const leaf = safeLeaf(storedName)
  return leaf ? `${directory}/${leaf}` : null
}

localDataImportRouter.post('/', upload.single('archive'), async (req: Request, res: Response, next) => {
  const file = req.file
  try {
    const workspaceId = requireWorkspaceId(req)
    if (!file) throw new LocalDataImportError('请选择从 F:\\job-tracer\\data 压缩得到的 ZIP 文件')
    if (req.body?.replace_workspace !== 'true') throw new LocalDataImportError('请确认清空当前个人工作区的测试数据后再导入')

    const entries = archiveEntries(file.path)
    const stage = path.join(IMPORTS_DIR, randomUUID())
    mkdirSync(stage, { recursive: true })
    const legacyDatabasePath = path.join(stage, 'job-tracer.db')
    try {
      writeFileSync(legacyDatabasePath, entries.get('job-tracer.db')!.getData(), { flag: 'wx' })
      const legacy = new Database(legacyDatabasePath, { readonly: true, fileMustExist: true })
      let data: Record<string, LegacyRow[]>
      try {
        data = {
          resumes: readableRows(legacy, 'resumes'), resumeTexts: readableRows(legacy, 'resume_texts'), applications: readableRows(legacy, 'applications'),
          events: readableRows(legacy, 'application_events'), interviews: readableRows(legacy, 'interviews'), checklistItems: readableRows(legacy, 'checklist_items'),
          knowledgeSources: readableRows(legacy, 'knowledge_sources'), knowledgeItems: readableRows(legacy, 'knowledge_items'), knowledgeImages: readableRows(legacy, 'knowledge_images'),
          answerVersions: readableRows(legacy, 'knowledge_answer_versions'), applicationImports: readableRows(legacy, 'application_imports'), applicationMaterials: readableRows(legacy, 'application_materials')
        }
      } finally { legacy.close() }
      if (!data.applications.length && !data.knowledgeSources.length && !data.resumes.length) throw new LocalDataImportError('job-tracer.db 中没有可导入的投递、面经或简历数据')

      const result: ImportResult = { applications: 0, events: 0, interviews: 0, checklistItems: 0, resumes: 0, resumeTexts: 0, knowledgeSources: 0, knowledgeItems: 0, knowledgeImages: 0, answerVersions: 0, applicationImports: 0, applicationMaterials: 0, missingFiles: 0, skippedDrafts: 0 }
      const sql = getPostgresSql()
      const writeImportedFile = (relative: string | null, target: string): boolean => {
        if (!relative || !writeArchiveFile(entries, relative, target)) { result.missingFiles++; return false }
        return true
      }
      clearWorkspaceFiles(workspaceId)
      try {
        await sql.begin(async transaction => {
          // 当前用户明确确认过覆盖；只删除该工作区已迁移的业务数据，绝不影响账号或其他用户。
          await transaction.unsafe('DELETE FROM application_imports WHERE workspace_id=$1', [workspaceId])
          await transaction.unsafe('DELETE FROM knowledge_sources WHERE workspace_id=$1', [workspaceId])
          await transaction.unsafe('DELETE FROM applications WHERE workspace_id=$1', [workspaceId])
          await transaction.unsafe('DELETE FROM resumes WHERE workspace_id=$1', [workspaceId])
          await transaction.unsafe('DELETE FROM legacy_core_imports WHERE workspace_id=$1', [workspaceId])

          const resumeMap = new Map<number, number>()
          for (const row of data.resumes) {
            const oldId = numberValue(row.id, -1); if (oldId <= 0) continue
            const stored = safeLeaf(row.stored_name); const displayName = required(row.filename, stored ?? '未命名简历', 300)
            const newStored = `${randomUUID()}${extension(stored, displayName) || '.bin'}`
            const target = path.join(WORKSPACE_RESUMES_DIR, workspaceId, newStored)
            writeImportedFile(fileEntry('uploads', stored), target)
            const inserted = await transaction.unsafe('INSERT INTO resumes (workspace_id,filename,stored_name,size,note,uploaded_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [workspaceId, displayName, newStored, Math.max(0, numberValue(row.size)), text(row.note, 80), timestamp(row.uploaded_at)]) as Array<{ id: number }>
            resumeMap.set(oldId, inserted[0].id); result.resumes++
          }
          for (const row of data.resumeTexts) {
            const newResumeId = resumeMap.get(numberValue(row.resume_id, -1)); if (!newResumeId) continue
            await transaction.unsafe(`INSERT INTO resume_texts (resume_id,workspace_id,status,text_content,content_hash,error_message,extraction_method,model,page_count,pages_completed,started_at,extracted_at,updated_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [newResumeId, workspaceId, required(row.status, 'pending', 24), text(row.text_content), text(row.content_hash, 64), text(row.error_message), text(row.extraction_method, 24), text(row.model, 200), numberValue(row.page_count, 0) || null, Math.max(0, numberValue(row.pages_completed)), text(row.started_at) ? timestamp(row.started_at) : null, text(row.extracted_at) ? timestamp(row.extracted_at) : null, timestamp(row.updated_at)])
            result.resumeTexts++
          }

          const applicationMap = new Map<number, number>()
          for (const row of data.applications) {
            const oldId = numberValue(row.id, -1); if (oldId <= 0) continue
            const inserted = await transaction.unsafe(`INSERT INTO applications (workspace_id,company,position,status,applied_at,applied_time,channel,location,resume_id,jd_link,application_link,jd_text,contact_name,contact_info,notes,rejected_at,reject_type,created_at,updated_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`, [workspaceId, required(row.company, '未命名公司', 300), required(row.position, '未命名岗位', 300), required(row.status, 'unsent', 24), text(row.applied_at, 10), text(row.applied_time, 8), text(row.channel), text(row.location), resumeMap.get(numberValue(row.resume_id, -1)) ?? null, text(row.jd_link), text(row.application_link), text(row.jd_text), text(row.contact_name), text(row.contact_info), text(row.notes), text(row.rejected_at, 10), text(row.reject_type, 16), timestamp(row.created_at), timestamp(row.updated_at)]) as Array<{ id: number }>
            applicationMap.set(oldId, inserted[0].id); result.applications++
          }
          for (const row of data.events) {
            const applicationId = applicationMap.get(numberValue(row.application_id, -1)); if (!applicationId) continue
            await transaction.unsafe('INSERT INTO application_events (workspace_id,application_id,type,event_date,content,created_at) VALUES ($1,$2,$3,$4,$5,$6)', [workspaceId, applicationId, required(row.type, 'note', 24), required(row.event_date, '1970-01-01', 10), required(row.content, '', 20_000), timestamp(row.created_at)]); result.events++
          }
          const interviewMap = new Map<number, number>()
          for (const row of data.interviews) {
            const applicationId = applicationMap.get(numberValue(row.application_id, -1)); const oldId = numberValue(row.id, -1); if (!applicationId || oldId <= 0) continue
            const inserted = await transaction.unsafe('INSERT INTO interviews (workspace_id,application_id,round,scheduled_at,location,review_file,done,created_at) VALUES ($1,$2,$3,$4,$5,NULL,$6,$7) RETURNING id', [workspaceId, applicationId, required(row.round, '其他', 40), required(row.scheduled_at, '1970-01-01 00:00', 16), text(row.location), booleanValue(row.done), timestamp(row.created_at)]) as Array<{ id: number }>
            interviewMap.set(oldId, inserted[0].id); result.interviews++
          }
          for (const row of data.checklistItems) {
            const interviewId = interviewMap.get(numberValue(row.interview_id, -1)); if (!interviewId) continue
            await transaction.unsafe('INSERT INTO checklist_items (workspace_id,interview_id,content,done,sort) VALUES ($1,$2,$3,$4,$5)', [workspaceId, interviewId, required(row.content, '', 20_000), booleanValue(row.done), numberValue(row.sort)]); result.checklistItems++
          }

          const sourceMap = new Map<number, number>()
          for (const row of data.knowledgeSources) {
            const oldId = numberValue(row.id, -1); if (oldId <= 0) continue
            const inserted = await transaction.unsafe('INSERT INTO knowledge_sources (workspace_id,owner,company,position,round,source_type,note,application_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id', [workspaceId, row.owner === 'mine' ? 'mine' : 'others', required(row.company, '未命名公司', 300), text(row.position), text(row.round, 40), required(row.source_type, 'manual', 16), text(row.note), applicationMap.get(numberValue(row.application_id, -1)) ?? null, timestamp(row.created_at), timestamp(row.updated_at)]) as Array<{ id: number }>
            sourceMap.set(oldId, inserted[0].id); result.knowledgeSources++
          }
          const itemMap = new Map<number, number>()
          for (const row of data.knowledgeItems) {
            const oldId = numberValue(row.id, -1); if (oldId <= 0) continue
            const sourceId = sourceMap.get(numberValue(row.source_id, -1)) ?? null
            const inserted = await transaction.unsafe('INSERT INTO knowledge_items (workspace_id,source_id,question,answer,category,sub_category,mastery,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id', [workspaceId, sourceId, required(row.question, '未命名问题', 2_000), text(row.answer), required(row.category, '其他', 32), text(row.sub_category, 100), Math.max(0, Math.min(2, numberValue(row.mastery))), timestamp(row.created_at), timestamp(row.updated_at)]) as Array<{ id: number }>
            itemMap.set(oldId, inserted[0].id); result.knowledgeItems++
          }
          for (const row of data.answerVersions) {
            const itemId = itemMap.get(numberValue(row.knowledge_item_id, -1)); if (!itemId || !text(row.answer)) continue
            await transaction.unsafe('INSERT INTO knowledge_answer_versions (workspace_id,knowledge_item_id,answer,reason,model,created_at) VALUES ($1,$2,$3,$4,$5,$6)', [workspaceId, itemId, required(row.answer, ''), required(row.reason, 'legacy_import', 40), text(row.model, 200), timestamp(row.created_at)]); result.answerVersions++
          }
          for (const row of data.knowledgeImages) {
            const sourceId = sourceMap.get(numberValue(row.source_id, -1)); const oldStored = safeLeaf(row.stored_name); if (!sourceId || !oldStored) continue
            const newStored = `${randomUUID()}${extension(oldStored, row.filename) || '.bin'}`
            const target = path.join(WORKSPACE_KNOWLEDGE_IMAGES_DIR, workspaceId, newStored)
            if (!writeImportedFile(fileEntry('knowledge_images', oldStored), target)) continue
            const oldInference = safeLeaf(row.inference_stored_name); let newInference = oldInference ? `${randomUUID()}${extension(oldInference) || '.bin'}` : null
            if (newInference && !writeImportedFile(fileEntry('knowledge_images', oldInference), path.join(WORKSPACE_KNOWLEDGE_IMAGES_DIR, workspaceId, newInference))) newInference = null
            await transaction.unsafe('INSERT INTO knowledge_images (workspace_id,source_id,filename,stored_name,inference_stored_name,inference_mime,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [workspaceId, sourceId, required(row.filename, oldStored, 300), newStored, newInference, text(row.inference_mime, 80), timestamp(row.created_at)]); result.knowledgeImages++
          }

          const importMap = new Map<string, string>()
          for (const row of data.applicationImports) {
            const oldId = text(row.id, 100); const applicationId = applicationMap.get(numberValue(row.application_id, -1)); if (!oldId || !applicationId) { result.skippedDrafts++; continue }
            const newId = randomUUID(); importMap.set(oldId, newId)
            await transaction.unsafe('INSERT INTO application_imports (id,workspace_id,application_id,analysis_json,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6)', [newId, workspaceId, applicationId, text(row.analysis_json), timestamp(row.created_at), timestamp(row.expires_at)])
            result.applicationImports++
          }
          for (const row of data.applicationMaterials) {
            const importId = importMap.get(required(row.import_id, '', 100)); const materialId = text(row.id, 40); if (!importId || !materialId) continue
            const oldStored = safeLeaf(row.stored_name); const oldInference = safeLeaf(row.inference_stored_name)
            let newStored = oldStored ? `${randomUUID()}${extension(oldStored, row.filename) || '.bin'}` : null
            let newInference = oldInference ? `${randomUUID()}${extension(oldInference) || '.bin'}` : null
            if (newStored && !writeImportedFile(fileEntry('application_materials', oldStored), path.join(WORKSPACE_APPLICATION_MATERIALS_DIR, workspaceId, newStored))) newStored = null
            if (newInference && !writeImportedFile(fileEntry('application_materials', oldInference), path.join(WORKSPACE_APPLICATION_MATERIALS_DIR, workspaceId, newInference))) newInference = null
            await transaction.unsafe('INSERT INTO application_materials (id,import_id,workspace_id,kind,text_content,filename,stored_name,mime,captured_at,inference_stored_name,inference_mime) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [materialId, importId, workspaceId, required(row.kind, 'text', 16), text(row.text_content), text(row.filename, 300), newStored, text(row.mime, 80), text(row.captured_at, 10), newInference, text(row.inference_mime, 80)])
            result.applicationMaterials++
          }
        })
      } catch (error) {
        clearWorkspaceFiles(workspaceId)
        throw error
      }
      res.json({ ok: true, result, ignored: ['secrets', 'chrome-profile', 'automation', 'recordings', 'reviews', '.test-output'], message: '本地数据已导入到你的个人工作区' })
    } finally {
      rmSync(stage, { recursive: true, force: true })
    }
  } catch (error) {
    next(error)
  } finally {
    if (file) try { unlinkSync(file.path) } catch { /* 临时文件已被清理 */ }
  }
})

localDataImportRouter.use((error: Error, _req: Request, res: Response, next: (error: Error) => void) => {
  if (error instanceof multer.MulterError) return res.status(422).json({ message: error.code === 'LIMIT_FILE_SIZE' ? '压缩包不能超过 300MB' : '压缩包上传不符合要求' })
  next(error)
})
