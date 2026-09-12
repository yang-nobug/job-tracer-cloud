import { reactive } from 'vue'
import { api } from './api'

export interface AuthUser {
  userId: string
  email: string
  displayName: string
  isAdmin: boolean
  workspaceId: string | null
  workspaceRole: string | null
}

interface SessionResponse {
  user: AuthUser | null
}

interface LoginResponse {
  user: AuthUser
  expiresAt: string
}

export const authState = reactive({
  loading: true,
  user: null as AuthUser | null
})

export async function refreshAuth(): Promise<AuthUser | null> {
  const response = await api.get<SessionResponse>('/auth/session')
  authState.user = response.user
  return response.user
}

export async function initializeAuth(): Promise<void> {
  try {
    await refreshAuth()
  } finally {
    authState.loading = false
  }
}

export async function login(input: { email: string; password: string }): Promise<void> {
  const response = await api.post<LoginResponse>('/auth/login', input)
  authState.user = response.user
}

export async function submitRegistration(input: { email: string; displayName: string; password: string }): Promise<string> {
  const response = await api.post<{ message: string }>('/auth/register', input)
  return response.message
}

export async function logout(): Promise<void> {
  await api.post<void>('/auth/logout')
  authState.user = null
}
