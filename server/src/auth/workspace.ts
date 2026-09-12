import type { Request } from 'express'
import { AuthError } from './guards.js'

/** 所有云端业务查询都从已认证请求取得工作区，禁止从客户端传 workspaceId。 */
export function requireWorkspaceId(req: Request): string {
  const workspaceId = req.auth?.workspaceId
  if (!workspaceId) throw new AuthError('当前账号没有可用工作区', 403)
  return workspaceId
}

export function parsePositiveId(value: unknown, _label: string): number | null {
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export function localDate(): string {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
