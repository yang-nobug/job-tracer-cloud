import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import AdmZip from 'adm-zip'
import multer from 'multer'
import { Router } from 'express'
import type { NextFunction, Request, Response } from 'express'
import { requireWorkspaceId, parsePositiveId } from '../auth/workspace.js'
import { getPostgresSql } from '../database/client.js'
import { WORKSPACE_PROJECT_ARCHIVES_DIR } from '../data-paths.js'
import { hasLikelySecretContent, isIgnoredSourceSegment, isProtectedSourceName } from '../source-access-policy.js'

/** 云端项目档案只扫描用户主动上传的 ZIP，不会读取服务器其它目录或修改原仓库。 */
export const cloudProjectsRouter = Router()
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
const MAX_FILES = 2_000
const MAX_FILE_BYTES = 1_000_000
const MAX_TOTAL_BYTES = 25 * 1024 * 1024
const MAX_CHUNK_CHARS = 6_000
const GENERATED = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|.*\.min\.[cm]?js|.*\.map)$/i
mkdirSync(WORKSPACE_PROJECT_ARCHIVES_DIR, { recursive: true })

type Project = { id: number; workspace_id: string; name: string; description: string; archive_filename: string; archive_stored_name: string; status: string; files_seen: number; files_indexed: number; bytes_read: number; truncated: boolean; skipped_json: string; scanned_at: string | null; created_at: string; updated_at: string }
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const clean = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : ''
const projectPath = (workspaceId: string, stored: string) => path.join(WORKSPACE_PROJECT_ARCHIVES_DIR, workspaceId, path.basename(stored))
function language(file: string): string { const ext = path.extname(file).toLowerCase(); if (['.ts','.tsx'].includes(ext)) return 'typescript'; if (['.js','.jsx','.mjs','.cjs'].includes(ext)) return 'javascript'; if (ext === '.py') return 'python'; if (ext === '.java') return 'java'; if (ext === '.go') return 'go'; if (ext === '.rs') return 'rust'; if (ext === '.vue') return 'vue'; if (ext === '.sql') return 'sql'; if (['.md','.mdx'].includes(ext)) return 'markdown'; if (ext === '.json') return 'json'; if (['.yml','.yaml'].includes(ext)) return 'yaml'; return 'other' }
function candidate(file: string): boolean { return language(file) !== 'other' || ['README','Dockerfile','Makefile'].includes(path.basename(file)) }
function safeEntry(name: string): string | null { const normalized = name.replace(/\\/g, '/').replace(/^\/+/, ''); if (!normalized || normalized.includes('\0') || normalized.split('/').some(part => !part || part === '.' || part === '..' || isIgnoredSourceSegment(part))) return null; return normalized }
function chunkLines(lines: string[]): Array<{ start: number; end: number; content: string }> { const result: Array<{ start: number; end: number; content: string }> = []; let start = 1; let current: string[] = []; let size = 0; for (let index = 0; index < lines.length; index += 1) { const line = lines[index]; if (current.length && size + line.length + 1 > MAX_CHUNK_CHARS) { result.push({ start, end: index, content: current.join('\n') }); start = index + 1; current = []; size = 0 }; current.push(line); size += line.length + 1 }; if (current.length) result.push({ start, end: lines.length, content: current.join('\n') }); return result }

const upload = multer({ storage: multer.diskStorage({ destination: (req, _file, cb) => { const workspaceId = req.auth?.workspaceId; if (!workspaceId) return cb(new Error('当前账号没有可用工作区'), ''); const dir = path.join(WORKSPACE_PROJECT_ARCHIVES_DIR, workspaceId); mkdirSync(dir, { recursive: true }); cb(null, dir) }, filename: (_req, file, cb) => cb(null, `${randomUUID()}.zip`) }), limits: { fileSize: MAX_ARCHIVE_BYTES }, fileFilter: (_req, file, cb) => cb(null, path.extname(file.originalname).toLowerCase() === '.zip') })
async function project(workspaceId: string, id: number): Promise<Project | null> { const rows = await getPostgresSql().unsafe('SELECT * FROM workspace_project_profiles WHERE workspace_id=$1 AND id=$2', [workspaceId, id]) as Project[]; return rows[0] ?? null }
function summary(row: Project) { return { ...row, root_realpath: `云端私有压缩包：${row.archive_filename}`, files_seen: row.files_seen, files_indexed: row.files_indexed, bytes_read: row.bytes_read, truncated: row.truncated, scanned_at: row.scanned_at, symbol_count: 0 } }

async function scan(workspaceId: string, item: Project): Promise<void> {
  const file = projectPath(workspaceId, item.archive_stored_name); if (!existsSync(file)) throw new Error('项目压缩包已丢失，请重新上传')
  let archive: AdmZip; try { archive = new AdmZip(readFileSync(file)) } catch { throw new Error('无法读取 ZIP 文件，请重新压缩项目后上传') }
  const skipped: Record<string, number> = {}; const skip = (name: string) => { skipped[name] = (skipped[name] ?? 0) + 1 }; let seen = 0; let bytes = 0; let truncated = false
  const collected: Array<{ path: string; data: Buffer; language: string }> = []
  for (const entry of archive.getEntries()) {
    if (entry.isDirectory) continue; seen += 1; if (collected.length >= MAX_FILES) { truncated = true; skip('file_limit'); break }
    const relative = safeEntry(entry.entryName); if (!relative) { skip('ignored_path'); continue }; if (isProtectedSourceName(path.basename(relative))) { skip('sensitive_name'); continue }; if (!candidate(relative)) { skip('unsupported_extension'); continue }
    const size = entry.header.size; if (size > MAX_FILE_BYTES) { skip('file_too_large'); continue }; if (bytes + size > MAX_TOTAL_BYTES) { truncated = true; skip('byte_limit'); break }
    let data: Buffer; try { data = entry.getData() } catch { skip('unreadable_file'); continue }
    // 不能只相信 ZIP header，解压后的实际大小也必须再次受限，避免异常压缩包耗尽内存。
    if (data.length > MAX_FILE_BYTES) { skip('file_too_large'); continue }
    if (bytes + data.length > MAX_TOTAL_BYTES) { truncated = true; skip('byte_limit'); break }
    if (data.includes(0)) { skip('binary_file'); continue }; if (hasLikelySecretContent(data)) { skip('potential_secret'); continue }
    bytes += data.length; collected.push({ path: relative, data, language: language(relative) })
  }
  const sql = getPostgresSql()
  await sql.begin(async tx => { await tx.unsafe('DELETE FROM workspace_project_files WHERE project_id=$1', [item.id]); for (const source of collected) { const content = source.data.toString('utf8'); const lines = content.split(/\r?\n/); const inserted = await tx.unsafe(`INSERT INTO workspace_project_files(project_id,relative_path,language,size_bytes,line_count,content_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [item.id, source.path, source.language, source.data.length, lines.length, hash(source.data)]) as Array<{ id: number }>; for (const chunk of chunkLines(lines)) await tx.unsafe(`INSERT INTO workspace_project_chunks(project_id,file_id,start_line,end_line,content,content_hash) VALUES($1,$2,$3,$4,$5,$6)`, [item.id, inserted[0].id, chunk.start, chunk.end, chunk.content, hash(chunk.content)]) }; await tx.unsafe(`UPDATE workspace_project_profiles SET status='ready',files_seen=$3,files_indexed=$4,bytes_read=$5,truncated=$6,skipped_json=$7,scanned_at=now(),updated_at=now() WHERE workspace_id=$1 AND id=$2`, [workspaceId, item.id, seen, collected.length, bytes, truncated, JSON.stringify(skipped)]) })
}

cloudProjectsRouter.get('/projects', async (req, res) => { const workspaceId = requireWorkspaceId(req); const rows = await getPostgresSql().unsafe('SELECT * FROM workspace_project_profiles WHERE workspace_id=$1 ORDER BY updated_at DESC', [workspaceId]) as Project[]; res.json(rows.map(summary)) })
cloudProjectsRouter.post('/projects', upload.single('archive'), async (req, res, next) => { const workspaceId = requireWorkspaceId(req); if (!req.file) return res.status(422).json({ message: '请选择项目 ZIP 压缩包' }); const cleanup = () => { try { unlinkSync(req.file!.path) } catch {} }; try { const name = clean(req.body?.name, 200) || path.basename(req.file.originalname, '.zip'); const description = clean(req.body?.description, 8_000); const rows = await getPostgresSql().unsafe(`INSERT INTO workspace_project_profiles(workspace_id,name,description,archive_filename,archive_stored_name) VALUES($1,$2,$3,$4,$5) RETURNING *`, [workspaceId,name,description,req.file.originalname,req.file.filename]) as Project[]; res.status(201).json({ project: summary(rows[0]) }) } catch (error) { cleanup(); next(error) } })
cloudProjectsRouter.get('/projects/:id', async (req, res) => { const workspaceId = requireWorkspaceId(req); const item = await project(workspaceId, parsePositiveId(req.params.id, '项目编号') ?? -1); if (!item) return res.status(404).json({ message: '项目档案不存在' }); const sql = getPostgresSql(); const [files,facts] = await Promise.all([sql.unsafe('SELECT id,relative_path,language,size_bytes,line_count,indexed_at,false AS is_generated FROM workspace_project_files WHERE project_id=$1 ORDER BY relative_path LIMIT 300',[item.id]),sql.unsafe('SELECT * FROM workspace_project_facts WHERE project_id=$1 ORDER BY id DESC',[item.id])]); res.json({ project: summary(item), files, facts }) })
cloudProjectsRouter.post('/projects/:id/scan', async (req, res, next) => { const workspaceId = requireWorkspaceId(req); try { const item = await project(workspaceId, parsePositiveId(req.params.id, '项目编号') ?? -1); if (!item) return res.status(404).json({ message: '项目档案不存在' }); await scan(workspaceId,item); res.json({ ok:true }) } catch (error) { next(error) } })
cloudProjectsRouter.get('/projects/:id/search', async (req,res) => { const workspaceId=requireWorkspaceId(req); const item=await project(workspaceId,parsePositiveId(req.params.id,'项目编号')??-1); const q=clean(req.query.q,300); if(!item)return res.status(404).json({message:'项目档案不存在'}); if(!q)return res.status(422).json({message:'请输入检索词'}); const rows=await getPostgresSql().unsafe(`SELECT c.id,f.relative_path,c.start_line,c.end_line,c.content,NULL::text AS symbol_name,NULL::text AS symbol_kind FROM workspace_project_chunks c JOIN workspace_project_files f ON f.id=c.file_id WHERE c.project_id=$1 AND (c.content ILIKE $2 OR f.relative_path ILIKE $2) ORDER BY c.id DESC LIMIT 20`,[item.id,`%${q}%`]); res.json(rows) })
cloudProjectsRouter.post('/projects/:id/facts', async (req,res) => { const workspaceId=requireWorkspaceId(req); const projectId=parsePositiveId(req.params.id,'项目编号')??-1; if(!await project(workspaceId,projectId))return res.status(404).json({message:'项目档案不存在'}); const factType=clean(req.body?.fact_type,40),title=clean(req.body?.title,300),content=clean(req.body?.content,8000); if(!['architecture','responsibility','technology','decision','metric','risk'].includes(factType)||!title||!content)return res.status(422).json({message:'请填写有效的事实类型、标题和内容'}); const rows=await getPostgresSql().unsafe(`INSERT INTO workspace_project_facts(project_id,fact_type,title,content) VALUES($1,$2,$3,$4) RETURNING *`,[projectId,factType,title,content]); res.status(201).json(rows[0]) })
cloudProjectsRouter.delete('/projects/:id', async (req,res) => { const workspaceId=requireWorkspaceId(req); const id=parsePositiveId(req.params.id,'项目编号')??-1; const rows=await getPostgresSql().unsafe('DELETE FROM workspace_project_profiles WHERE workspace_id=$1 AND id=$2 RETURNING archive_stored_name',[workspaceId,id]) as Array<{archive_stored_name:string}>; if(!rows[0])return res.status(404).json({message:'项目档案不存在'}); try{unlinkSync(projectPath(workspaceId,rows[0].archive_stored_name))}catch{}; res.json({ok:true}) })
cloudProjectsRouter.use((error: Error,_req:Request,res:Response,next:NextFunction)=>{if(res.headersSent)return next(error);if(error instanceof multer.MulterError||error.message==='当前账号没有可用工作区'){res.status(422).json({message:error instanceof multer.MulterError&&error.code==='LIMIT_FILE_SIZE'?'项目压缩包不能超过 100 MB':'请上传 ZIP 格式的项目压缩包'});return}res.status(500).json({message:error.message||'项目档案处理失败'})})
