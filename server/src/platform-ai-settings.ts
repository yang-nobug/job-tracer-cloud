import { getPostgresSql } from './database/client.js'
import type { AiTask } from './ai.js'

const TASK_PREFIX = 'task_enabled:'
const TUTOR_MODEL_KEY = 'tutor_model'
const taskOverrides = new Map<AiTask, boolean>()
let selectedTutorModel: string | undefined

function taskKey(task: AiTask): string {
  return `${TASK_PREFIX}${task}`
}

/**
 * 平台级 AI 偏好只保存开关和已选模型 ID；模型清单、接口地址和 API Key 仍只在
 * 服务器 config.json 中维护。启动时载入缓存，运行中的每次 AI 调用不会额外查库。
 */
export async function refreshPlatformAiSettings(): Promise<void> {
  const rows = await getPostgresSql().unsafe(
    "SELECT key,value FROM platform_ai_settings WHERE key = 'tutor_model' OR key LIKE 'task_enabled:%'"
  ) as Array<{ key: string; value: string }>
  taskOverrides.clear()
  selectedTutorModel = undefined
  for (const row of rows) {
    if (row.key === TUTOR_MODEL_KEY) {
      selectedTutorModel = row.value || undefined
      continue
    }
    if (!row.key.startsWith(TASK_PREFIX)) continue
    const task = row.key.slice(TASK_PREFIX.length) as AiTask
    if (row.value === '0') taskOverrides.set(task, false)
    if (row.value === '1') taskOverrides.set(task, true)
  }
}

export function platformAiTaskEnabled(task: AiTask): boolean | undefined {
  return taskOverrides.get(task)
}

export function platformTutorModel(): string | undefined {
  return selectedTutorModel
}

async function save(key: string, value: string, userId: string): Promise<void> {
  await getPostgresSql().unsafe(`INSERT INTO platform_ai_settings(key,value,updated_by_user_id,updated_at)
    VALUES($1,$2,$3,now())
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by_user_id=excluded.updated_by_user_id,updated_at=now()`, [key, value, userId])
}

export async function savePlatformAiTaskEnabled(task: AiTask, enabled: boolean, userId: string): Promise<void> {
  await save(taskKey(task), enabled ? '1' : '0', userId)
  taskOverrides.set(task, enabled)
}

export async function savePlatformTutorModel(modelId: string, userId: string): Promise<void> {
  await save(TUTOR_MODEL_KEY, modelId, userId)
  selectedTutorModel = modelId
}
