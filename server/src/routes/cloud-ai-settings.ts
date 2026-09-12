import { Router } from 'express'
import type { Request, Response } from 'express'
import { AI_TASKS, isAiTaskEnabled, loadArkConfig, resolveAiTask, setAiTaskEnabled, setTutorModel, tutorModel, type AiTask } from '../ai.js'
import { loadAsrConfig } from '../asr.js'
import { loadOssConfig } from '../oss.js'

export const cloudAiSettingsRouter = Router()

const AI_TASK_INFO: Record<AiTask, { label: string; data: string; visible: boolean }> = {
  applicationImport: { label: '招聘材料识别', data: '输入文字和压缩后的图片副本', visible: true },
  jdParse: { label: 'JD 解析', data: '岗位描述文字', visible: true },
  knowledgeExtract: { label: '知识提取', data: '知识来源文字和压缩后的图片副本', visible: true },
  answerGenerate: { label: '答案生成', data: '题目、岗位信息和关联知识', visible: true },
  tutor: { label: 'AI 助教', data: '当前问题、必要的对话历史和检索到的知识', visible: true },
  recordingReview: { label: '录音复盘', data: '语音转写文本或分段提取结果', visible: true },
  reviewAdvice: { label: '复盘建议', data: '复盘内容、岗位信息和 JD 摘要', visible: true },
  interviewPrepAgent: { label: '面试准备 Agent', data: '岗位信息、面试信息、必要的历史复盘和检索知识', visible: true },
  codeReading: { label: '代码理解 Agent', data: '用户问题与按需读取的受限代码片段', visible: true },
  resumeExtract: { label: '简历视觉提取', data: 'PDF 简历逐页渲染得到的临时图片；原 PDF 仅保存于工作区私有目录', visible: true },
  mailRecruitmentExtract: { label: '招聘邮件识别', data: '候选邮件的主题、发件人、发送时间、正文文字和正文链接（不含附件）', visible: true },
  mailScheduleReview: { label: '招聘日程合理性复核', data: '邮件标题、发件人、发送时间、正文和待复核的结构化事件（不含附件）', visible: true }
}

function requireAdmin(req: Request, res: Response): string | null {
  if (!req.auth?.isAdmin) {
    res.status(403).json({ message: '仅平台管理员可修改 AI 全局配置' })
    return null
  }
  return req.auth.userId
}

cloudAiSettingsRouter.get('/ai/settings', (_req: Request, res: Response) => {
  res.json({
    provider: '火山方舟',
    tasks: AI_TASKS.map(task => ({ task, ...AI_TASK_INFO[task], enabled: isAiTaskEnabled(task), configured: resolveAiTask(task) !== null })),
    recording: { ossConfigured: loadOssConfig() !== null, asrConfigured: loadAsrConfig() !== null }
  })
})

cloudAiSettingsRouter.put('/ai/settings/:task', async (req: Request, res: Response) => {
  const userId = requireAdmin(req, res)
  if (!userId) return
  const task = req.params.task as AiTask
  if (!AI_TASKS.includes(task)) return void res.status(404).json({ message: '未知 AI 任务' })
  if (typeof req.body?.enabled !== 'boolean') return void res.status(422).json({ message: 'enabled 必须是布尔值' })
  await setAiTaskEnabled(task, req.body.enabled, userId)
  res.json({ task, enabled: isAiTaskEnabled(task) })
})

// 助教模型是平台统一默认值；任何用户可读取，只有管理员可以切换。
cloudAiSettingsRouter.get('/tutor/model', (_req: Request, res: Response) => {
  const config = loadArkConfig()
  if (!config) return void res.status(422).json({ message: 'AI 未配置：请在服务器 config.json 填入 ark 段' })
  res.json({ models: config.models, active: tutorModel(), canManage: Boolean(_req.auth?.isAdmin) })
})

cloudAiSettingsRouter.put('/tutor/model', async (req: Request, res: Response) => {
  const userId = requireAdmin(req, res)
  if (!userId) return
  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : ''
  if (!model) return void res.status(422).json({ message: 'model 不能为空' })
  if (!await setTutorModel(model, userId)) return void res.status(422).json({ message: '该模型不在服务器 config.json 的模型列表里' })
  res.json({ active: model })
})
