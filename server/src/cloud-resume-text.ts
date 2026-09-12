import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPostgresSql } from './database/client.js'
import { loadArkConfig, type ChatContent } from './ai.js'
import { loadPrompt } from './prompt-loader.js'
import { WORKSPACE_RESUMES_DIR } from './data-paths.js'

const MAX_TEXT = 24_000
const MAX_PROCESS_OUTPUT = 256 * 1024
const PROCESS_TIMEOUT = 60_000
const active = new Set<string>()
const __dirname = path.dirname(fileURLToPath(import.meta.url))

type ResumeRow = { id: number; workspace_id: string; filename: string; stored_name: string; size: number; note: string | null; uploaded_at: string }
type RenderedPage = { path: string; bytes: number }

function clean(value: unknown, max = MAX_TEXT): string {
  return typeof value === 'string' ? value.replace(/\u0000/g, '').replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : ''
}
function now(): string { return new Date().toISOString() }
function taskKey(workspaceId: string, resumeId: number): string { return `${workspaceId}:${resumeId}` }
function python(): string { return process.env.PREP_AGENT_PYTHON?.trim() || process.env.PYTHON?.trim() || (process.platform === 'win32' ? 'python' : 'python3.11') }
function script(name: string): string { return path.resolve(__dirname, '../../scripts', name) }
export function cloudResumePath(workspaceId: string, storedName: string): string { return path.join(WORKSPACE_RESUMES_DIR, workspaceId, storedName) }

async function getResume(workspaceId: string, resumeId: number): Promise<ResumeRow | null> {
  const rows = await getPostgresSql().unsafe(
    'SELECT id,workspace_id,filename,stored_name,size,note,uploaded_at FROM resumes WHERE workspace_id=$1 AND id=$2', [workspaceId, resumeId]
  ) as ResumeRow[]
  return rows[0] ?? null
}

function parseJson(value: string): { text?: unknown; pages?: unknown; error?: unknown } {
  try { return JSON.parse(value) as { text?: unknown; pages?: unknown; error?: unknown } } catch { return {} }
}

function runPythonJson(scriptName: string, args: string[]): Promise<{ text?: unknown; pages?: unknown; error?: unknown }> {
  return new Promise((resolve, reject) => {
    const child = spawn(python(), [script(scriptName), ...args], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''; let timedOut = false
    const append = (current: string, chunk: Buffer) => `${current}${chunk.toString('utf8')}`.slice(0, MAX_PROCESS_OUTPUT)
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })
    const timer = setTimeout(() => { timedOut = true; child.kill() }, PROCESS_TIMEOUT)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      const payload = parseJson(stdout || stderr)
      if (!timedOut && code === 0) return resolve(payload)
      reject(new Error(clean(payload.error, 1_000) || clean(stderr, 1_000) || (timedOut ? '简历处理超时，请使用更小的文件后重试' : '简历处理失败')))
    })
  })
}

function pages(value: unknown): RenderedPage[] {
  if (!Array.isArray(value) || !value.length) throw new Error('PDF 没有生成可供识别的页面图片')
  const output = value.map(item => item && typeof item === 'object' ? item as Record<string, unknown> : null).filter(Boolean).map(item => ({ path: clean(item!.path, 4_000), bytes: Number(item!.bytes) }))
  if (!output.length || output.some(item => !item.path || !Number.isFinite(item.bytes) || item.bytes <= 0 || !existsSync(item.path))) throw new Error('PDF 页面渲染结果无效')
  return output
}

async function callVisionModel(content: ChatContent): Promise<{ content: string; model: string }> {
  const config = loadArkConfig()
  if (!config) throw new Error('AI 未配置，暂时无法提取简历文字')
  const task = config.tasks.resumeExtract ?? {}
  if (task.enabled === false) throw new Error('简历文字提取已被管理员停用')
  const model = task.model ?? config.models.find(item => item.vision)?.id
  const modelInfo = config.models.find(item => item.id === model)
  if (!model || modelInfo?.vision !== true) throw new Error('请配置支持视觉的 resumeExtract 模型')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.min(task.timeoutMs ?? 120_000, 180_000))
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: loadPrompt('resume-vision-extract.system.md') },
          { role: 'user', content }
        ],
        temperature: task.temperature ?? 0,
        max_tokens: task.maxOutputTokens ?? 8192,
        stream: false
      })
    })
    const raw = await response.text()
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? '模型鉴权失败，请检查服务器 AI 配置' : `模型请求失败（${response.status}）`)
    const payload = JSON.parse(raw) as { choices?: Array<{ message?: { content?: unknown } }> }
    const result = payload.choices?.[0]?.message?.content
    const text = typeof result === 'string' ? result : ''
    if (!text.trim()) throw new Error('视觉模型没有返回可用文字')
    return { content: text, model }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('模型识别超时，请稍后重试')
    throw error
  } finally { clearTimeout(timeout) }
}

async function saveState(workspaceId: string, resumeId: number, input: {
  status: 'pending' | 'extracting' | 'completed' | 'failed' | 'unsupported'
  text?: string | null; error?: string | null; method?: string | null; model?: string | null
  pageCount?: number | null; pagesCompleted?: number; startedAt?: string | null; extractedAt?: string | null
}): Promise<void> {
  const text = input.text === undefined ? null : input.text
  const hash = text ? createHash('sha256').update(text).digest('hex') : null
  await getPostgresSql().unsafe(
    `INSERT INTO resume_texts (resume_id,workspace_id,status,text_content,content_hash,error_message,extraction_method,model,page_count,pages_completed,started_at,extracted_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
     ON CONFLICT (resume_id) DO UPDATE SET status=EXCLUDED.status,text_content=EXCLUDED.text_content,content_hash=EXCLUDED.content_hash,error_message=EXCLUDED.error_message,extraction_method=EXCLUDED.extraction_method,model=EXCLUDED.model,page_count=EXCLUDED.page_count,pages_completed=EXCLUDED.pages_completed,started_at=EXCLUDED.started_at,extracted_at=EXCLUDED.extracted_at,updated_at=now()
     WHERE resume_texts.workspace_id=$2`,
    [resumeId, workspaceId, input.status, text, hash, input.error ?? null, input.method ?? null, input.model ?? null, input.pageCount ?? null, input.pagesCompleted ?? 0, input.startedAt ?? null, input.extractedAt ?? null]
  )
}

export async function cloudResumeWithText(workspaceId: string, resumeId: number): Promise<Record<string, unknown> | null> {
  const rows = await getPostgresSql().unsafe(
    `SELECT r.id,r.filename,r.stored_name,r.size,r.note,r.uploaded_at,COALESCE(t.status,'pending') AS extraction_status,t.error_message AS extraction_error,t.extracted_at,t.extraction_method,t.model AS extraction_model,t.page_count,COALESCE(t.pages_completed,0)::integer AS pages_completed,t.started_at,CASE WHEN t.status='completed' AND length(COALESCE(t.text_content,''))>0 THEN 1 ELSE 0 END AS text_available
     FROM resumes r LEFT JOIN resume_texts t ON t.resume_id=r.id AND t.workspace_id=r.workspace_id WHERE r.workspace_id=$1 AND r.id=$2`, [workspaceId, resumeId]
  ) as Array<Record<string, unknown>>
  return rows[0] ?? null
}

export async function listCloudResumes(workspaceId: string): Promise<Record<string, unknown>[]> {
  return await getPostgresSql().unsafe(
    `SELECT r.id,r.filename,r.stored_name,r.size,r.note,r.uploaded_at,COALESCE(t.status,'pending') AS extraction_status,t.error_message AS extraction_error,t.extracted_at,t.extraction_method,t.model AS extraction_model,t.page_count,COALESCE(t.pages_completed,0)::integer AS pages_completed,t.started_at,CASE WHEN t.status='completed' AND length(COALESCE(t.text_content,''))>0 THEN 1 ELSE 0 END AS text_available
     FROM resumes r LEFT JOIN resume_texts t ON t.resume_id=r.id AND t.workspace_id=r.workspace_id WHERE r.workspace_id=$1 ORDER BY r.uploaded_at DESC`, [workspaceId]
  ) as Array<Record<string, unknown>>
}

async function extract(workspaceId: string, resumeId: number): Promise<void> {
  const key = taskKey(workspaceId, resumeId)
  if (active.has(key)) return
  active.add(key)
  try {
    const resume = await getResume(workspaceId, resumeId)
    if (!resume) return
    const file = cloudResumePath(workspaceId, resume.stored_name)
    if (!existsSync(file)) throw new Error('简历文件已丢失')
    const extension = path.extname(resume.stored_name).toLowerCase()
    if (extension === '.doc') return void await saveState(workspaceId, resumeId, { status: 'unsupported', error: '旧版 .doc 暂不支持自动提取，请另存为 .docx 或 PDF 后重新上传' })
    if (extension === '.docx') {
      await saveState(workspaceId, resumeId, { status: 'extracting', method: 'docx_xml', startedAt: now() })
      const parsed = await runPythonJson('extract-resume-docx.py', [file])
      const text = clean(parsed.text)
      if (!text) throw new Error(clean(parsed.error, 1_000) || '未能从 DOCX 简历提取文字')
      await saveState(workspaceId, resumeId, { status: 'completed', text, method: 'docx_xml', extractedAt: now() })
      return
    }
    if (extension !== '.pdf') throw new Error('不支持的简历格式')
    await saveState(workspaceId, resumeId, { status: 'extracting', method: 'vision_pdf', startedAt: now(), pagesCompleted: 0 })
    const dir = mkdtempSync(path.join(os.tmpdir(), 'job-tracer-resume-'))
    try {
      const rendered = await runPythonJson('render-resume-pdf.py', [file, dir])
      const renderedPages = pages(rendered.pages)
      const chunks: string[] = []; let model = ''
      await saveState(workspaceId, resumeId, { status: 'extracting', method: 'vision_pdf', pageCount: renderedPages.length, pagesCompleted: 0, startedAt: now() })
      for (let index = 0; index < renderedPages.length; index++) {
        const image = readFileSync(renderedPages[index].path)
        const output = await callVisionModel([
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image.toString('base64')}` } },
          { type: 'text', text: `这是简历第 ${index + 1}/${renderedPages.length} 页。请严格按要求提取这一页的文字内容。` }
        ])
        model = output.model
        const pageText = clean(output.content, 12_000)
        if (!pageText) throw new Error(`视觉模型未能识别第 ${index + 1} 页简历`)
        chunks.push(`## 第 ${index + 1} 页\n${pageText}`)
        await saveState(workspaceId, resumeId, { status: 'extracting', method: 'vision_pdf', model, pageCount: renderedPages.length, pagesCompleted: index + 1, startedAt: now() })
      }
      const text = clean(chunks.join('\n\n'))
      if (!text) throw new Error('视觉模型未能从 PDF 简历提取文字')
      await saveState(workspaceId, resumeId, { status: 'completed', text, method: 'vision_pdf', model, pageCount: renderedPages.length, pagesCompleted: renderedPages.length, extractedAt: now() })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  } catch (error) {
    await saveState(workspaceId, resumeId, { status: 'failed', error: ((error as Error).message || '简历文字提取失败').slice(0, 1_000) })
  } finally { active.delete(key) }
}

export async function requestCloudResumeExtraction(workspaceId: string, resumeId: number): Promise<Record<string, unknown>> {
  if (!await getResume(workspaceId, resumeId)) throw new Error('简历不存在')
  const key = taskKey(workspaceId, resumeId)
  if (!active.has(key)) {
    await saveState(workspaceId, resumeId, { status: 'pending', startedAt: now(), pagesCompleted: 0 })
    queueMicrotask(() => { void extract(workspaceId, resumeId) })
  }
  return (await cloudResumeWithText(workspaceId, resumeId))!
}

export async function recoverInterruptedCloudResumeExtractions(): Promise<number> {
  const rows = await getPostgresSql().unsafe(`UPDATE resume_texts SET status='failed',error_message='服务重启中断，可点击重新提取',updated_at=now() WHERE status IN ('pending','extracting') RETURNING resume_id`)
  return rows.length
}
