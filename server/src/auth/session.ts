import { createHash, randomBytes } from 'node:crypto'
import type { Request } from 'express'
import { getPostgresSql } from '../database/client.js'

export const SESSION_COOKIE_NAME = 'job_tracer_session'

export interface AuthContext {
  userId: string
  email: string
  displayName: string
  isAdmin: boolean
  workspaceId: string | null
  workspaceRole: string | null
}

interface SessionRow {
  user_id: string
  email: string
  display_name: string
  is_admin: boolean
  workspace_id: string | null
  workspace_role: string | null
}

function sessionDays(): number {
  const value = Number(process.env.SESSION_TTL_DAYS ?? '7')
  return Number.isInteger(value) && value >= 1 && value <= 30 ? value : 7
}

export function sessionCookieOptions(): {
  httpOnly: true
  sameSite: 'lax'
  secure: boolean
  path: '/'
  maxAge: number
} {
  const configured = process.env.SESSION_COOKIE_SECURE?.trim().toLowerCase()
  const secure = configured === 'true' || (configured !== 'false' && process.env.NODE_ENV === 'production')
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: sessionDays() * 24 * 60 * 60 * 1000
  }
}

/**
 * 只给迁移中的公网 IP 测试保留的显式开关。
 * 默认值为 false；正式公网服务必须继续使用 HTTPS 和 Secure Cookie。
 */
function allowsInsecureHttp(): boolean {
  return process.env.ALLOW_INSECURE_HTTP?.trim().toLowerCase() === 'true'
}

/** 公网生产服务不得在未显式确认的情况下降级为明文会话 Cookie。 */
export function assertSecureSessionConfiguration(): void {
  if (process.env.NODE_ENV === 'production' && !sessionCookieOptions().secure && !allowsInsecureHttp()) {
    throw new Error('生产环境必须设置 SESSION_COOKIE_SECURE=true，并通过 HTTPS 提供服务；仅临时公网 IP 测试可显式设置 ALLOW_INSECURE_HTTP=true')
  }
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function readCookie(req: Request, name: string): string | null {
  const source = req.headers.cookie
  if (!source) return null
  for (const pair of source.split(';')) {
    const separator = pair.indexOf('=')
    if (separator < 0) continue
    if (pair.slice(0, separator).trim() !== name) continue
    try {
      return decodeURIComponent(pair.slice(separator + 1).trim())
    } catch {
      return null
    }
  }
  return null
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + sessionDays() * 24 * 60 * 60 * 1000)
  const sql = getPostgresSql()
  await sql.unsafe(
    'INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (gen_random_uuid(), $1, $2, $3)',
    [userId, tokenHash(token), expiresAt]
  )
  return { token, expiresAt }
}

export async function deleteSession(req: Request): Promise<void> {
  const token = readCookie(req, SESSION_COOKIE_NAME)
  if (!token) return
  await getPostgresSql().unsafe('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(token)])
}

export async function getRequestAuth(req: Request): Promise<AuthContext | null> {
  const token = readCookie(req, SESSION_COOKIE_NAME)
  if (!token) return null

  const sql = getPostgresSql()
  const rows = await sql.unsafe(
    [
      'SELECT s.user_id, u.email, u.display_name, u.is_admin,',
      'wm.workspace_id, wm.role AS workspace_role',
      'FROM sessions s JOIN users u ON u.id = s.user_id',
      'LEFT JOIN LATERAL (',
      'SELECT workspace_id, role FROM workspace_members',
      "WHERE user_id = s.user_id ORDER BY (role = 'owner') DESC, created_at ASC LIMIT 1",
      ') wm ON true',
      "WHERE s.token_hash = $1 AND s.expires_at > now() AND u.status = 'active'"
    ].join(' '),
    [tokenHash(token)]
  ) as unknown as SessionRow[]

  const row = rows[0]
  if (!row) return null
  return {
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    isAdmin: row.is_admin,
    workspaceId: row.workspace_id,
    workspaceRole: row.workspace_role
  }
}
