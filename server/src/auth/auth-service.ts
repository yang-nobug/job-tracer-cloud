import type { Sql } from 'postgres'
import { getPostgresSql } from '../database/client.js'
import { hashPassword, verifyPassword } from './passwords.js'
import { createSession, type AuthContext } from './session.js'

export class AuthServiceError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message)
    this.name = 'AuthServiceError'
  }
}

interface UserRow {
  id: string
  email: string
  display_name: string
  password_hash: string
  is_admin: boolean
  status: string
}

interface IdRow {
  id: string
}

interface RegistrationRequestRow {
  id: string
  email: string
  display_name: string
  password_hash: string | null
  status: string
}

export interface PublicUser {
  id: string
  email: string
  displayName: string
  isAdmin: boolean
  workspaceId: string
  workspaceRole: 'owner' | 'member'
}

export interface RegistrationRequestSummary {
  id: string
  email: string
  displayName: string
  status: 'pending' | 'approved' | 'rejected'
  reviewNote: string | null
  requestedAt: string
  reviewedAt: string | null
}

function normalizeEmail(input: unknown): { email: string; normalized: string } {
  if (typeof input !== 'string') throw new AuthServiceError('请输入邮箱地址', 400)
  const email = input.trim()
  const normalized = email.toLowerCase()
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AuthServiceError('邮箱地址格式不正确', 400)
  }
  return { email, normalized }
}

function normalizeDisplayName(input: unknown): string {
  if (typeof input !== 'string') throw new AuthServiceError('请输入昵称', 400)
  const name = input.trim().replace(/\s+/g, ' ')
  if (name.length < 1 || name.length > 80) throw new AuthServiceError('昵称长度应为 1 到 80 个字符', 400)
  return name
}

function optionalReviewNote(input: unknown): string | null {
  if (input === undefined || input === null || input === '') return null
  if (typeof input !== 'string') throw new AuthServiceError('审批备注格式不正确', 400)
  const note = input.trim()
  if (note.length > 500) throw new AuthServiceError('审批备注不能超过 500 个字符', 400)
  return note || null
}

type SqlExecutor = Pick<Sql, 'unsafe'>

async function createUserWorkspace(
  sql: SqlExecutor,
  input: { email: string; emailNormalized: string; displayName: string; passwordHash: string; isAdmin: boolean }
): Promise<PublicUser> {
  const users = await sql.unsafe(
    'INSERT INTO users (id, email, email_normalized, display_name, password_hash, is_admin) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5) RETURNING id, email, display_name, is_admin',
    [input.email, input.emailNormalized, input.displayName, input.passwordHash, input.isAdmin]
  ) as unknown as Array<Pick<UserRow, 'id' | 'email' | 'display_name' | 'is_admin'>>
  const user = users[0]
  if (!user) throw new AuthServiceError('创建账号失败', 500)

  const workspaces = await sql.unsafe(
    'INSERT INTO workspaces (id, name) VALUES (gen_random_uuid(), $1) RETURNING id',
    [input.displayName + ' 的求职工作区']
  ) as unknown as IdRow[]
  const workspace = workspaces[0]
  if (!workspace) throw new AuthServiceError('创建工作区失败', 500)

  await sql.unsafe(
    'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)',
    [workspace.id, user.id, 'owner']
  )
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    isAdmin: user.is_admin,
    workspaceId: workspace.id,
    workspaceRole: 'owner'
  }
}

export async function submitRegistrationRequest(input: unknown): Promise<void> {
  const body = input as Record<string, unknown>
  const { email, normalized } = normalizeEmail(body?.email)
  const displayName = normalizeDisplayName(body?.displayName)
  const passwordHash = await hashPassword(body?.password as string)
  const sql = getPostgresSql()

  const existing = await sql.unsafe(
    'SELECT status FROM registration_requests WHERE email_normalized = $1',
    [normalized]
  ) as unknown as Array<{ status: string }>
  const status = existing[0]?.status
  if (status === 'pending') throw new AuthServiceError('该邮箱的注册申请正在等待管理员审批', 409)
  if (status === 'approved') throw new AuthServiceError('该邮箱已获批准，请直接登录', 409)

  if (status === 'rejected') {
    await sql.unsafe(
      'UPDATE registration_requests SET email = $1, display_name = $2, password_hash = $3, status = $4, review_note = NULL, reviewed_by = NULL, reviewed_at = NULL, updated_at = now() WHERE email_normalized = $5',
      [email, displayName, passwordHash, 'pending', normalized]
    )
    return
  }

  try {
    await sql.unsafe(
      'INSERT INTO registration_requests (id, email, email_normalized, display_name, password_hash) VALUES (gen_random_uuid(), $1, $2, $3, $4)',
      [email, normalized, displayName, passwordHash]
    )
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new AuthServiceError('该邮箱的注册申请正在处理中', 409)
    }
    throw error
  }
}

export async function signIn(input: unknown): Promise<{ user: AuthContext; token: string; expiresAt: Date }> {
  const body = input as Record<string, unknown>
  const { normalized } = normalizeEmail(body?.email)
  if (typeof body?.password !== 'string') throw new AuthServiceError('请输入密码', 400)

  const sql = getPostgresSql()
  const users = await sql.unsafe(
    'SELECT id, email, display_name, password_hash, is_admin, status FROM users WHERE email_normalized = $1',
    [normalized]
  ) as unknown as UserRow[]
  const user = users[0]
  if (!user || user.status !== 'active' || !(await verifyPassword(body.password, user.password_hash))) {
    throw new AuthServiceError('邮箱或密码错误', 401)
  }

  const memberships = await sql.unsafe(
    "SELECT workspace_id, role FROM workspace_members WHERE user_id = $1 ORDER BY (role = 'owner') DESC, created_at ASC LIMIT 1",
    [user.id]
  ) as unknown as Array<{ workspace_id: string; role: 'owner' | 'member' }>
  const membership = memberships[0]
  if (!membership) throw new AuthServiceError('账号尚未分配工作区，请联系管理员', 403)

  const session = await createSession(user.id)
  return {
    token: session.token,
    expiresAt: session.expiresAt,
    user: {
      userId: user.id,
      email: user.email,
      displayName: user.display_name,
      isAdmin: user.is_admin,
      workspaceId: membership.workspace_id,
      workspaceRole: membership.role
    }
  }
}

export async function listRegistrationRequests(): Promise<RegistrationRequestSummary[]> {
  const rows = await getPostgresSql().unsafe(
    [
      'SELECT id, email, display_name, status, review_note,',
      'requested_at, reviewed_at',
      'FROM registration_requests',
      "ORDER BY (status = 'pending') DESC, requested_at DESC"
    ].join(' ')
  ) as unknown as Array<{
    id: string
    email: string
    display_name: string
    status: 'pending' | 'approved' | 'rejected'
    review_note: string | null
    requested_at: Date
    reviewed_at: Date | null
  }>
  return rows.map(row => ({
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    reviewNote: row.review_note,
    requestedAt: row.requested_at.toISOString(),
    reviewedAt: row.reviewed_at?.toISOString() ?? null
  }))
}

export async function approveRegistrationRequest(requestId: string, adminUserId: string, noteInput: unknown): Promise<PublicUser> {
  const note = optionalReviewNote(noteInput)
  const sql = getPostgresSql()
  return sql.begin(async transaction => {
    const requests = await transaction.unsafe(
      'SELECT id, email, email_normalized, display_name, password_hash, status FROM registration_requests WHERE id = $1 FOR UPDATE',
      [requestId]
    ) as unknown as Array<RegistrationRequestRow & { email_normalized: string }>
    const request = requests[0]
    if (!request) throw new AuthServiceError('注册申请不存在', 404)
    if (request.status !== 'pending' || !request.password_hash) {
      throw new AuthServiceError('该注册申请已处理，不能重复审批', 409)
    }

    const existing = await transaction.unsafe(
      'SELECT id FROM users WHERE email_normalized = $1',
      [request.email_normalized]
    ) as unknown as IdRow[]
    if (existing[0]) throw new AuthServiceError('该邮箱已有账号，无法批准此申请', 409)

    const user = await createUserWorkspace(transaction, {
      email: request.email,
      emailNormalized: request.email_normalized,
      displayName: request.display_name,
      passwordHash: request.password_hash,
      isAdmin: false
    })
    await transaction.unsafe(
      'UPDATE registration_requests SET status = $1, password_hash = NULL, review_note = $2, reviewed_by = $3, reviewed_at = now(), approved_user_id = $4, updated_at = now() WHERE id = $5',
      ['approved', note, adminUserId, user.id, requestId]
    )
    return user
  })
}

export async function rejectRegistrationRequest(requestId: string, adminUserId: string, noteInput: unknown): Promise<void> {
  const note = optionalReviewNote(noteInput)
  const rows = await getPostgresSql().unsafe(
    'UPDATE registration_requests SET status = $1, password_hash = NULL, review_note = $2, reviewed_by = $3, reviewed_at = now(), updated_at = now() WHERE id = $4 AND status = $5 RETURNING id',
    ['rejected', note, adminUserId, requestId, 'pending']
  ) as unknown as IdRow[]
  if (!rows[0]) throw new AuthServiceError('注册申请不存在，或已经处理', 409)
}

export async function bootstrapPlatformAdmin(input: {
  email: unknown
  displayName: unknown
  password: unknown
}): Promise<PublicUser> {
  const { email, normalized } = normalizeEmail(input.email)
  const displayName = normalizeDisplayName(input.displayName)
  const passwordHash = await hashPassword(input.password as string)
  const sql = getPostgresSql()

  return sql.begin(async transaction => {
    const users = await transaction.unsafe(
      'SELECT id, email, display_name, is_admin FROM users WHERE email_normalized = $1 FOR UPDATE',
      [normalized]
    ) as unknown as Array<Pick<UserRow, 'id' | 'email' | 'display_name' | 'is_admin'>>
    const existing = users[0]
    if (existing) {
      await transaction.unsafe(
        'UPDATE users SET password_hash = $1, display_name = $2, status = $3, is_admin = true, updated_at = now() WHERE id = $4',
        [passwordHash, displayName, 'active', existing.id]
      )
      const memberships = await transaction.unsafe(
        "SELECT workspace_id, role FROM workspace_members WHERE user_id = $1 ORDER BY (role = 'owner') DESC, created_at ASC LIMIT 1",
        [existing.id]
      ) as unknown as Array<{ workspace_id: string; role: 'owner' | 'member' }>
      const membership = memberships[0]
      if (!membership) throw new AuthServiceError('已有管理员账号缺少工作区', 500)
      return {
        id: existing.id,
        email: existing.email,
        displayName,
        isAdmin: true,
        workspaceId: membership.workspace_id,
        workspaceRole: membership.role
      }
    }
    return createUserWorkspace(transaction, {
      email,
      emailNormalized: normalized,
      displayName,
      passwordHash,
      isAdmin: true
    })
  })
}
