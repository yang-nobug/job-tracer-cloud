import { Router } from 'express'
import type { Request, Response } from 'express'
import { AiError, completeStructured } from '../ai.js'
import { JD_PARSE_SCHEMA, validateJdParse } from '../ai-contracts.js'
import { loadPrompt } from '../prompt-loader.js'
import { requireWorkspaceId } from '../auth/workspace.js'

/** 已迁移模块的轻量 AI 接口；调用不写入旧的共享 SQLite 审计表。 */
export const cloudAiRouter = Router()

cloudAiRouter.post('/ai/jd-parse', async (req: Request, res: Response) => {
  const workspaceId = requireWorkspaceId(req)
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
  if (!text) return res.status(422).json({ message: 'text 不能为空' })
  try {
    const { value } = await completeStructured([
      { role: 'system', content: `${loadPrompt('jd-parse.system.md')}\n\nJSON Schema:\n${JSON.stringify(JD_PARSE_SCHEMA)}` },
      { role: 'user', content: `<untrusted_jd>\n${text.slice(0, 8_000)}\n</untrusted_jd>` }
    ], { task: 'jdParse', schemaName: 'jd_parse', schema: JD_PARSE_SCHEMA, validate: validateJdParse, skipAudit: true, workspaceId })
    res.json({ company: value.company || undefined, position: value.position || undefined, location: value.location || undefined, jd_link: value.jd_link || undefined, summary: value.summary || undefined, jd: value.jd || undefined })
  } catch (error) {
    const err = error as Error
    res.status(err instanceof AiError ? err.statusCode : 502).json({ message: err.message || 'JD 解析失败' })
  }
})
