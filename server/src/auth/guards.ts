import type { NextFunction, Request, Response } from 'express'
import { getRequestAuth, type AuthContext } from './session.js'

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext | null
    }
  }
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status = 401
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    req.auth = await getRequestAuth(req)
    if (!req.auth) throw new AuthError('请先登录', 401)
    next()
  } catch (error) {
    next(error)
  }
}

export async function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    req.auth = await getRequestAuth(req)
    if (!req.auth) throw new AuthError('请先登录', 401)
    if (!req.auth.isAdmin) throw new AuthError('仅管理员可执行此操作', 403)
    next()
  } catch (error) {
    next(error)
  }
}

/**
 * 既有业务仍使用单份 SQLite 数据，尚未具备 workspace 隔离能力。
 * 在迁移完成前只允许平台管理员访问，避免批准的新用户看到共享旧数据。
 */
export async function requireLegacyDataAccess(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    req.auth = await getRequestAuth(req)
    if (!req.auth) throw new AuthError('请先登录', 401)
    if (!req.auth.isAdmin) throw new AuthError('你的账号已获批准，业务数据正在迁移至个人工作区，请稍后再试', 403)
    next()
  } catch (error) {
    next(error)
  }
}

/** Cookie 身份认证下，浏览器跨站请求不能修改数据。命令行客户端可不带 Origin。 */
export function requireSameOrigin(req: Request, _res: Response, next: NextFunction): void {
  const origin = req.get('origin')
  if (!origin) {
    next()
    return
  }
  try {
    const originUrl = new URL(origin)
    if (originUrl.host !== req.get('host')) throw new Error('mismatch')
    next()
  } catch {
    next(new AuthError('跨站请求已被拒绝', 403))
  }
}
