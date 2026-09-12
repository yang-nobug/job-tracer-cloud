import { Router } from 'express'
import { AuthServiceError, signIn, submitRegistrationRequest } from '../auth/auth-service.js'
import { allowAttempt } from '../auth/rate-limit.js'
import { requireSameOrigin } from '../auth/guards.js'
import { deleteSession, getRequestAuth, SESSION_COOKIE_NAME, sessionCookieOptions } from '../auth/session.js'

export const authRouter = Router()

function rateLimit(key: string, limit: number, windowMs: number): void {
  if (!allowAttempt(key, limit, windowMs)) {
    throw new AuthServiceError('操作过于频繁，请稍后再试', 429)
  }
}

authRouter.get('/session', async (req, res, next) => {
  try {
    res.json({ user: await getRequestAuth(req) })
  } catch (error) {
    next(error)
  }
})

authRouter.post('/register', requireSameOrigin, async (req, res, next) => {
  try {
    rateLimit('registration:' + req.ip, 5, 60 * 60 * 1000)
    await submitRegistrationRequest(req.body)
    res.status(202).json({ message: '注册申请已提交，等待管理员审批后即可登录' })
  } catch (error) {
    next(error)
  }
})

authRouter.post('/login', requireSameOrigin, async (req, res, next) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
    rateLimit('login:' + req.ip + ':' + email, 10, 15 * 60 * 1000)
    const result = await signIn(req.body)
    res.cookie(SESSION_COOKIE_NAME, result.token, sessionCookieOptions())
    res.json({ user: result.user, expiresAt: result.expiresAt.toISOString() })
  } catch (error) {
    next(error)
  }
})

authRouter.post('/logout', requireSameOrigin, async (req, res, next) => {
  try {
    await deleteSession(req)
    res.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions())
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})
