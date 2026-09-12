import { Router } from 'express'
import {
  approveRegistrationRequest,
  listRegistrationRequests,
  rejectRegistrationRequest
} from '../auth/auth-service.js'
import { requirePlatformAdmin, requireSameOrigin } from '../auth/guards.js'

export const adminRouter = Router()

adminRouter.use(requirePlatformAdmin)

adminRouter.get('/registration-requests', async (_req, res, next) => {
  try {
    res.json(await listRegistrationRequests())
  } catch (error) {
    next(error)
  }
})

adminRouter.post('/registration-requests/:id/approve', requireSameOrigin, async (req, res, next) => {
  try {
    const requestId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
    const user = await approveRegistrationRequest(requestId, req.auth!.userId, req.body?.note)
    res.json({ user, message: '已批准注册申请，用户现在可以登录' })
  } catch (error) {
    next(error)
  }
})

adminRouter.post('/registration-requests/:id/reject', requireSameOrigin, async (req, res, next) => {
  try {
    const requestId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
    await rejectRegistrationRequest(requestId, req.auth!.userId, req.body?.note)
    res.json({ message: '已拒绝注册申请；该邮箱可以修改信息后重新申请' })
  } catch (error) {
    next(error)
  }
})
