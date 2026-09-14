import { Router } from 'express'
import type { NextFunction, Request, Response } from 'express'
import multer from 'multer'
import { existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { completeStructured, isAiTaskEnabled, resolveAiTask } from '../ai.js'
import { getPostgresSql } from '../database/client.js'
import { parsePositiveId, requireWorkspaceId } from '../auth/workspace.js'
import { WORKSPACE_RECORDINGS_DIR } from '../data-paths.js'
import { loadPrompt, renderTemplate } from '../prompt-loader.js'
import { RECORDING_ANALYSIS_SCHEMA, RECORDING_CHUNK_SCHEMA, validateRecordingAnalysis, validateRecordingChunk, type RecordingAnalysisResult, type RecordingChunkResult } from '../ai-contracts.js'
import { RECORDING_CHUNK_THRESHOLD, splitRecordingTranscript, type TranscriptChunk } from '../recording-analysis.js'
import { loadOssConfig, ossDelete, ossPut, ossSignedUrl } from '../oss.js'
import { loadAsrConfig, transcribe, type AsrFormat } from '../asr.js'

export const cloudRecordingsRouter = Router()
const DIRECT_FORMATS: Record<string, AsrFormat> = { '.mp3': 'mp3', '.wav': 'wav', '.ogg': 'ogg' }
const TRANSCODE_EXTENSIONS = ['.m4a', '.aac', '.webm', '.amr', '.mp4']
const active = new Set<number>()
mkdirSync(WORKSPACE_RECORDINGS_DIR, { recursive: true })

type Recording = { id: number; workspace_id: string; interview_id: number; filename: string; stored_name: string; size: number; status: string; transcript: string | null; knowledge_source_id: number | null; analysis_json: string | null; analysis_stage: string; attempts: number; error: string | null; created_at: string; updated_at: string }
type Chunk = { recording_id: number; chunk_index: number; start_offset: number; end_offset: number; status: 'pending' | 'analyzing' | 'done' | 'failed'; result_json: string | null; error: string | null; attempts: number }
type InterviewInfo = { interview_id: number; application_id: number; round: string; scheduled_at: string; company: string; position: string | null }
const clip = (value: unknown, maximum: number) => typeof value === 'string' ? value.trim().slice(0, maximum) : ''
const recordingPath = (workspaceId: string, storedName: string) => path.join(WORKSPACE_RECORDINGS_DIR, workspaceId, path.basename(storedName))
const audioExtension = (name: string) => path.extname(name).toLowerCase()

function filename(value: string): string {
  const bytes = Buffer.from(value, 'latin1'); const decoded = bytes.toString('utf8')
  return decoded !== value && Buffer.from(decoded, 'utf8').equals(bytes) ? decoded : value
}
function contentType(extension: string): string { return ({ '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg' } as Record<string, string>)[extension] ?? 'application/octet-stream' }
function parse<T>(value: string | null, fallback: T): T { try { return value ? JSON.parse(value) as T : fallback } catch { return fallback } }
function nowDate(): string { return new Date().toISOString().slice(0, 10) }

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, callback) => { const workspaceId = req.auth?.workspaceId; if (!workspaceId) return callback(new Error('当前账号没有可用工作区'), ''); const directory = path.join(WORKSPACE_RECORDINGS_DIR, workspaceId); mkdirSync(directory, { recursive: true }); callback(null, directory) },
    filename: (_req, file, callback) => callback(null, `${randomUUID()}${audioExtension(file.originalname)}`)
  }),
  limits: { fileSize: 300 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => callback(null, Boolean(DIRECT_FORMATS[audioExtension(file.originalname)] || TRANSCODE_EXTENSIONS.includes(audioExtension(file.originalname))))
})

/** multer 默认会把大小或格式问题交给全局 500；上传接口应给出用户可处理的 422。 */
function uploadErrorMessage(error: Error): string {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return '录音文件不能超过 300 MB'
  if (error instanceof multer.MulterError) return '录音上传失败，请重新选择一个支持的音频文件'
  if (error.message === '当前账号没有可用工作区') return error.message
  return error.message || '录音上传失败，请上传 mp3、wav、ogg、m4a、aac、webm、amr 或 mp4 文件'
}

async function recording(workspaceId: string, id: number): Promise<Recording | null> { const rows = await getPostgresSql().unsafe('SELECT * FROM workspace_recordings WHERE workspace_id=$1 AND id=$2', [workspaceId, id]) as Recording[]; return rows[0] ?? null }
async function interview(workspaceId: string, id: number): Promise<InterviewInfo | null> { const rows = await getPostgresSql().unsafe(`SELECT i.id AS interview_id,i.application_id,i.round,i.scheduled_at,a.company,a.position FROM interviews i JOIN applications a ON a.workspace_id=i.workspace_id AND a.id=i.application_id WHERE i.workspace_id=$1 AND i.id=$2`, [workspaceId, id]) as InterviewInfo[]; return rows[0] ?? null }
async function update(workspaceId: string, id: number, fields: Record<string, unknown>): Promise<void> { const allowed = new Set(['stored_name', 'size', 'status', 'transcript', 'knowledge_source_id', 'analysis_json', 'analysis_stage', 'attempts', 'error']); const entries = Object.entries(fields).filter(([key]) => allowed.has(key)); if (!entries.length) return; const values = entries.map(([, value]) => value); await getPostgresSql().unsafe(`UPDATE workspace_recordings SET ${entries.map(([key], index) => `${key}=$${index + 1}`).join(',')},updated_at=now() WHERE workspace_id=$${values.length + 1} AND id=$${values.length + 2}`, [...values, workspaceId, id] as never[]) }

/**
 * ffmpeg 必须异步运行。录音可能很长，spawnSync 会把整个 Node 事件循环卡住，
 * 进而令上传、登录和所有其他 API 在转码期间无响应。
 */
function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    let timedOut = false
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stderr.on('data', (chunk: Buffer) => {
      // 失败提示足够定位问题即可；不要在内存中累积大段 ffmpeg 输出。
      if (stderr.length < 4_096) stderr += chunk.toString().slice(0, 4_096 - stderr.length)
    })
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', code => {
      clearTimeout(timer)
      if (timedOut) return reject(new Error('ffmpeg 转码超时（超过 10 分钟）'))
      if (code === 0) return resolve()
      reject(new Error(`ffmpeg 转码失败：${stderr.trim().slice(-300) || '未知错误'}`))
    })
  })
}

let ffmpegCheck: Promise<boolean> | null = null
function hasFfmpeg(): Promise<boolean> {
  ffmpegCheck ??= runFfmpeg(['-version'], 10_000).then(() => true).catch(() => false)
  return ffmpegCheck
}

async function transcode(workspaceId: string, storedName: string): Promise<string> {
  const source = recordingPath(workspaceId, storedName)
  const converted = `${storedName}.mp3`
  const target = recordingPath(workspaceId, converted)
  try {
    await runFfmpeg(['-y', '-i', source, '-ac', '1', '-ar', '16000', '-b:a', '64k', target], 10 * 60 * 1000)
    if (!existsSync(target)) throw new Error('ffmpeg 未生成目标音频')
  } catch (error) {
    // 转码失败时避免留下半成品；原始录音保留，用户可以修复环境后重试。
    try { if (existsSync(target)) unlinkSync(target) } catch { /* no-op */ }
    throw error
  }
  unlinkSync(source)
  return converted
}

async function chunks(recordingId: number, transcript: string): Promise<Chunk[]> {
  const desired = splitRecordingTranscript(transcript); const sql = getPostgresSql(); let rows = await sql.unsafe('SELECT * FROM workspace_recording_analysis_chunks WHERE recording_id=$1 ORDER BY chunk_index', [recordingId]) as Chunk[]
  if (rows.length !== desired.length || rows.some((row, index) => row.chunk_index !== index || row.start_offset !== desired[index].start || row.end_offset !== desired[index].end)) {
    await sql.begin(async transaction => { await transaction.unsafe('DELETE FROM workspace_recording_analysis_chunks WHERE recording_id=$1', [recordingId]); for (const chunk of desired) await transaction.unsafe('INSERT INTO workspace_recording_analysis_chunks (recording_id,chunk_index,start_offset,end_offset) VALUES ($1,$2,$3,$4)', [recordingId, chunk.index, chunk.start, chunk.end]) })
    rows = await sql.unsafe('SELECT * FROM workspace_recording_analysis_chunks WHERE recording_id=$1 ORDER BY chunk_index', [recordingId]) as Chunk[]
  }
  return rows
}

async function analyzeLong(rec: Recording, info: InterviewInfo, transcript: string): Promise<RecordingAnalysisResult> {
  const pieces = splitRecordingTranscript(transcript); const persisted = await chunks(rec.id, transcript); const results: RecordingChunkResult[] = []
  for (const piece of pieces) {
    const saved = persisted[piece.index]
    if (saved.status === 'done' && saved.result_json) { try { results.push(validateRecordingChunk(JSON.parse(saved.result_json))); continue } catch { /* 重新生成损坏结果 */ } }
    await update(rec.workspace_id, rec.id, { analysis_stage: `chunk:${piece.index + 1}/${pieces.length}` })
    await getPostgresSql().unsafe("UPDATE workspace_recording_analysis_chunks SET status='analyzing',error=NULL,attempts=attempts+1,updated_at=now() WHERE recording_id=$1 AND chunk_index=$2", [rec.id, piece.index])
    try { const { value } = await completeStructured([{ role: 'system', content: `${loadPrompt('recording-chunk.system.md')}\n\nJSON Schema:\n${JSON.stringify(RECORDING_CHUNK_SCHEMA)}` }, { role: 'user', content: `<untrusted_recording_chunk index="${piece.index + 1}" total="${pieces.length}">\n${piece.text}\n</untrusted_recording_chunk>` }], { task: 'recordingReview', schemaName: 'recording_chunk', schema: RECORDING_CHUNK_SCHEMA, validate: validateRecordingChunk, skipAudit: true, workspaceId: rec.workspace_id }); await getPostgresSql().unsafe("UPDATE workspace_recording_analysis_chunks SET status='done',result_json=$3,error=NULL,updated_at=now() WHERE recording_id=$1 AND chunk_index=$2", [rec.id, piece.index, JSON.stringify(value)]); results.push(value) }
    catch (error) { await getPostgresSql().unsafe("UPDATE workspace_recording_analysis_chunks SET status='failed',error=$3,updated_at=now() WHERE recording_id=$1 AND chunk_index=$2", [rec.id, piece.index, clip((error as Error).message, 1000)]); throw error }
  }
  await update(rec.workspace_id, rec.id, { analysis_stage: 'merging' }); let remaining = 100; let trimmed = false
  const compact = results.map((result, index) => { const questions = result.questions.slice(0, remaining); remaining -= questions.length; if (questions.length < result.questions.length || result.summary.length > 700) trimmed = true; return { index: index + 1, summary: result.summary.slice(0, 700), questions: questions.map(question => ({ question: question.question.slice(0, 500), answer: question.answer.slice(0, 800), category: question.category })) } })
  const merge = { company: info.company, position: info.position || '未知', round: info.round, scheduled_at: info.scheduled_at, input_trimmed_to_context_budget: trimmed, chunks: compact }
  const { value } = await completeStructured([{ role: 'system', content: `${renderTemplate(loadPrompt('recording-merge.system.md'), { 公司: info.company, 轮次: info.round })}\n\nJSON Schema:\n${JSON.stringify(RECORDING_ANALYSIS_SCHEMA)}` }, { role: 'user', content: `<untrusted_chunk_results>\n${JSON.stringify(merge)}\n</untrusted_chunk_results>` }], { task: 'recordingReview', schemaName: 'recording_analysis', schema: RECORDING_ANALYSIS_SCHEMA, validate: validateRecordingAnalysis, skipAudit: true, workspaceId: rec.workspace_id })
  return value
}

async function analyze(rec: Recording, info: InterviewInfo, transcript: string): Promise<RecordingAnalysisResult> {
  if (transcript.length > RECORDING_CHUNK_THRESHOLD) return analyzeLong(rec, info, transcript)
  await update(rec.workspace_id, rec.id, { analysis_stage: 'single_pass' })
  const content = [`公司：${info.company}`, `岗位：${info.position || '未知'}`, `轮次：${info.round}`, `面试时间：${info.scheduled_at}`, '', '转写文本：', transcript].join('\n')
  const { value } = await completeStructured([{ role: 'system', content: `${renderTemplate(loadPrompt('recording-analysis.system.md'), { 公司: info.company, 轮次: info.round })}\n\nJSON Schema:\n${JSON.stringify(RECORDING_ANALYSIS_SCHEMA)}` }, { role: 'user', content: `<untrusted_recording_transcript>\n${content}\n</untrusted_recording_transcript>` }], { task: 'recordingReview', schemaName: 'recording_analysis', schema: RECORDING_ANALYSIS_SCHEMA, validate: validateRecordingAnalysis, skipAudit: true, workspaceId: rec.workspace_id })
  return value
}

async function finalize(rec: Recording, info: InterviewInfo, analysis: RecordingAnalysisResult): Promise<void> {
  await getPostgresSql().begin(async transaction => {
    const current = await transaction.unsafe('SELECT status FROM workspace_recordings WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [rec.workspace_id, rec.id]) as Array<{ status: string }>; if (!current[0] || current[0].status === 'done') return
    const sources = await transaction.unsafe(`INSERT INTO knowledge_sources (workspace_id,owner,company,position,round,source_type,note,application_id) VALUES ($1,'mine',$2,$3,$4,'audio',$5,$6) RETURNING id`, [rec.workspace_id, info.company, info.position, info.round, `来自 ${info.scheduled_at.slice(0, 10)} 录音复盘`, info.application_id]) as Array<{ id: number }>
    for (const question of analysis.questions) await transaction.unsafe(`INSERT INTO knowledge_items (workspace_id,source_id,question,answer,category,mastery) VALUES ($1,$2,$3,$4,$5,0)`, [rec.workspace_id, sources[0].id, question.question, question.answer || null, question.category])
    await transaction.unsafe(`INSERT INTO workspace_interview_reviews (workspace_id,interview_id,content,source) VALUES ($1,$2,$3,'recording') ON CONFLICT(interview_id) DO UPDATE SET content=EXCLUDED.content,source='recording',updated_at=now()`, [rec.workspace_id, info.interview_id, analysis.review])
    await transaction.unsafe(`INSERT INTO application_events (workspace_id,application_id,type,event_date,content) VALUES ($1,$2,'other',$3,$4)`, [rec.workspace_id, info.application_id, nowDate(), `录音复盘完成：${info.round} 转写入库 ${analysis.questions.length} 题`])
    await transaction.unsafe("UPDATE workspace_recordings SET status='done',error=NULL,knowledge_source_id=$3,analysis_stage='done',updated_at=now() WHERE workspace_id=$1 AND id=$2", [rec.workspace_id, rec.id, sources[0].id])
  })
}

async function pipeline(workspaceId: string, id: number): Promise<void> {
  if (active.has(id)) return; active.add(id)
  try {
    let rec = await recording(workspaceId, id); if (!rec) return; const info = await interview(workspaceId, rec.interview_id); if (!info) throw new Error('关联的面试记录不存在')
    if (!isAiTaskEnabled('recordingReview') || !resolveAiTask('recordingReview')) throw new Error('请先配置并开启录音复盘模型')
    await update(workspaceId, id, { attempts: rec.attempts + 1, error: null }); let transcript = rec.transcript
    if (!transcript) { const oss = loadOssConfig(); const asr = loadAsrConfig(); if (!oss) throw new Error('OSS 未配置，无法将录音临时交给语音识别服务'); if (!asr) throw new Error('ASR 未配置，无法转写录音')
      await update(workspaceId, id, { status: 'uploading', analysis_stage: 'uploading' }); let storedName = rec.stored_name; let extension = audioExtension(storedName)
      if (!DIRECT_FORMATS[extension]) { if (!await hasFfmpeg()) throw new Error('该格式需要 ffmpeg 转码；请安装 ffmpeg 或上传 mp3、wav、ogg'); storedName = await transcode(workspaceId, storedName); extension = '.mp3'; await update(workspaceId, id, { stored_name: storedName, size: statSync(recordingPath(workspaceId, storedName)).size }) }
      await update(workspaceId, id, { status: 'transcribing', analysis_stage: 'transcribing' }); const objectKey = `job-tracer/${workspaceId}/${id}-${storedName}`; await ossPut(oss, objectKey, recordingPath(workspaceId, storedName), contentType(extension)); try { transcript = await transcribe(asr, ossSignedUrl(oss, objectKey), DIRECT_FORMATS[extension]) } finally { await ossDelete(oss, objectKey).catch(() => undefined) }; await update(workspaceId, id, { transcript, analysis_stage: 'analysis_pending' }); rec = (await recording(workspaceId, id))!
    }
    await update(workspaceId, id, { status: 'analyzing', analysis_stage: 'analysis_pending' }); const persisted = rec.analysis_json ? parse<RecordingAnalysisResult | null>(rec.analysis_json, null) : null; const analysis = persisted ?? await analyze(rec, info, transcript); if (!persisted) await update(workspaceId, id, { analysis_json: JSON.stringify(analysis), analysis_stage: 'finalizing' }); await finalize(rec, info, analysis)
  } catch (error) { await update(workspaceId, id, { status: 'failed', error: clip((error as Error).message, 1000) || '录音处理失败' }) } finally { active.delete(id) }
}

function publicRows(workspaceId: string, where = '', values: unknown[] = []) { return getPostgresSql().unsafe(`SELECT r.id,r.interview_id,r.filename,r.size,r.status,r.error,r.knowledge_source_id,r.analysis_stage,r.attempts,r.created_at,r.updated_at,i.round,i.scheduled_at,a.company,a.position,(r.transcript IS NOT NULL AND r.transcript <> '') AS has_transcript,(SELECT COUNT(*)::integer FROM workspace_recording_analysis_chunks c WHERE c.recording_id=r.id) AS chunk_total,(SELECT COUNT(*)::integer FROM workspace_recording_analysis_chunks c WHERE c.recording_id=r.id AND c.status='done') AS chunk_done FROM workspace_recordings r JOIN interviews i ON i.id=r.interview_id AND i.workspace_id=r.workspace_id JOIN applications a ON a.id=i.application_id AND a.workspace_id=i.workspace_id WHERE r.workspace_id=$1 ${where} ORDER BY r.created_at DESC`, [workspaceId, ...values] as never[]) }

export async function recoverInterruptedCloudRecordings(): Promise<number> { const sql = getPostgresSql(); await sql.unsafe("UPDATE workspace_recording_analysis_chunks SET status='pending',error=NULL,updated_at=now() WHERE status='analyzing'"); const rows = await sql.unsafe("UPDATE workspace_recordings SET status='failed',error='服务重启中断，可点击重试；已有转写和分段结果会继续复用',updated_at=now() WHERE status IN ('uploading','transcribing','analyzing') RETURNING id"); return rows.length }

cloudRecordingsRouter.post('/recordings', upload.single('audio'), async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req); const interviewId = Number(req.body?.interview_id)
  const cleanup = () => { if (req.file?.path && existsSync(req.file.path)) try { unlinkSync(req.file.path) } catch { /* no-op */ } }
  if (!req.file) return res.status(422).json({ message: '请选择 mp3、wav、ogg、m4a、aac、webm 或 amr 录音文件' })
  if (!Number.isSafeInteger(interviewId) || !await interview(workspaceId, interviewId)) { cleanup(); return res.status(422).json({ message: '面试记录不存在，请先在投递详情里添加面试日程' }) }
  if (!isAiTaskEnabled('recordingReview') || !resolveAiTask('recordingReview')) { cleanup(); return res.status(422).json({ message: '请先配置并开启录音复盘模型' }) }
  try { const rows = await getPostgresSql().unsafe(`INSERT INTO workspace_recordings (workspace_id,interview_id,filename,stored_name,size,status) VALUES ($1,$2,$3,$4,$5,'uploading') RETURNING id`, [workspaceId, interviewId, filename(req.file.originalname), req.file.filename, req.file.size]) as Array<{ id: number }>; void pipeline(workspaceId, rows[0].id); res.status(201).json((await publicRows(workspaceId, 'AND r.id=$2', [rows[0].id]))[0]) }
  catch (error) { cleanup(); throw error }
})
cloudRecordingsRouter.get('/recordings', async (req: Request, res: Response) => { res.json(await publicRows(requireWorkspaceId(req))) })
cloudRecordingsRouter.get('/recordings/:id', async (req: Request, res: Response) => { const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '录音编号'); if (!id) return res.status(404).json({ message: '录音不存在' }); const rows = await getPostgresSql().unsafe(`SELECT r.*,i.round,i.scheduled_at,a.company,a.position,(SELECT COUNT(*)::integer FROM workspace_recording_analysis_chunks c WHERE c.recording_id=r.id) AS chunk_total,(SELECT COUNT(*)::integer FROM workspace_recording_analysis_chunks c WHERE c.recording_id=r.id AND c.status='done') AS chunk_done FROM workspace_recordings r JOIN interviews i ON i.id=r.interview_id AND i.workspace_id=r.workspace_id JOIN applications a ON a.id=i.application_id AND a.workspace_id=i.workspace_id WHERE r.workspace_id=$1 AND r.id=$2`, [workspaceId, id]); if (!rows.length) return res.status(404).json({ message: '录音不存在' }); res.json(rows[0]) })
cloudRecordingsRouter.post('/recordings/:id/retry', async (req: Request, res: Response) => { const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '录音编号'); const rec = id ? await recording(workspaceId, id) : null; if (!rec) return res.status(404).json({ message: '录音不存在' }); if (rec.status !== 'failed') return res.status(422).json({ message: '只有失败的录音才能重试' }); if (active.has(id)) return res.status(409).json({ message: '录音仍在处理中，请稍后重试' }); await update(workspaceId, id, { status: rec.transcript ? 'analyzing' : 'uploading', analysis_stage: rec.transcript ? 'analysis_pending' : 'uploading', error: null }); void pipeline(workspaceId, id); res.json((await publicRows(workspaceId, 'AND r.id=$2', [id]))[0]) })
cloudRecordingsRouter.delete('/recordings/:id', async (req: Request, res: Response) => { const workspaceId = requireWorkspaceId(req); const id = parsePositiveId(req.params.id, '录音编号'); const rec = id ? await recording(workspaceId, id) : null; if (!rec) return res.status(404).json({ message: '录音不存在' }); if (active.has(id)) return res.status(409).json({ message: '录音正在处理中，请等待完成或失败后再删除' }); await getPostgresSql().unsafe('DELETE FROM workspace_recordings WHERE workspace_id=$1 AND id=$2', [workspaceId, id]); try { unlinkSync(recordingPath(workspaceId, rec.stored_name)) } catch { /* 文件已丢失不影响记录删除 */ }; res.json({ ok: true }) })

cloudRecordingsRouter.use((error: Error, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(error)
  if (error instanceof multer.MulterError || error.message === '当前账号没有可用工作区') {
    res.status(422).json({ message: uploadErrorMessage(error) })
    return
  }
  next(error)
})
