<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { authState, logout } from '../auth'
import { api } from '../api'

interface RegistrationRequest {
  id: string
  email: string
  displayName: string
  status: 'pending' | 'approved' | 'rejected'
  reviewNote: string | null
  requestedAt: string
  reviewedAt: string | null
}

const open = defineModel<boolean>({ default: false })
const requests = ref<RegistrationRequest[]>([])
const loading = ref(false)
const handlingId = ref<string | null>(null)

function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
}

async function loadRequests(): Promise<void> {
  if (!authState.user?.isAdmin) return
  loading.value = true
  try {
    requests.value = await api.get<RegistrationRequest[]>('/admin/registration-requests')
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    loading.value = false
  }
}

async function approve(item: RegistrationRequest): Promise<void> {
  try {
    await ElMessageBox.confirm('批准后会自动创建该用户的个人工作区，对方可直接使用原密码登录。', '批准注册申请', {
      type: 'success',
      confirmButtonText: '批准',
      cancelButtonText: '取消'
    })
    handlingId.value = item.id
    await api.post('/admin/registration-requests/' + item.id + '/approve')
    ElMessage.success('已批准，账号和个人工作区已创建')
    await loadRequests()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error((error as Error).message)
  } finally {
    handlingId.value = null
  }
}

async function reject(item: RegistrationRequest): Promise<void> {
  try {
    const result = await ElMessageBox.prompt('可填写拒绝原因，对方修改后可以再次申请。', '拒绝注册申请', {
      inputPlaceholder: '可选',
      confirmButtonText: '拒绝',
      cancelButtonText: '取消'
    })
    handlingId.value = item.id
    await api.post('/admin/registration-requests/' + item.id + '/reject', { note: result.value })
    ElMessage.success('已拒绝该申请')
    await loadRequests()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error((error as Error).message)
  } finally {
    handlingId.value = null
  }
}

async function signOut(): Promise<void> {
  try {
    await logout()
    open.value = false
    ElMessage.success('已退出登录')
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

watch(open, value => {
  if (value) void loadRequests()
})
</script>

<template>
  <el-dialog v-model="open" title="账号与访问管理" width="min(760px, calc(100vw - 28px))" destroy-on-close>
    <template v-if="authState.user">
      <section class="account-summary">
        <span class="account-avatar">{{ authState.user.displayName.slice(0, 1) }}</span>
        <div><b>{{ authState.user.displayName }}</b><small>{{ authState.user.email }}</small></div>
        <el-tag v-if="authState.user.isAdmin" type="danger" effect="plain">管理员</el-tag>
        <el-tag v-else type="success" effect="plain">已批准用户</el-tag>
      </section>

      <section v-if="authState.user.isAdmin" class="approval-section">
        <div class="section-heading"><div><h3>注册申请</h3><p>批准后才会创建账号和个人工作区。</p></div><el-button text type="primary" :loading="loading" @click="loadRequests">刷新</el-button></div>
        <el-empty v-if="!loading && requests.length === 0" description="暂无注册申请" :image-size="70" />
        <el-table v-else v-loading="loading" :data="requests" size="small" max-height="360">
          <el-table-column label="申请人" min-width="155">
            <template #default="{ row }"><b>{{ row.displayName }}</b><small class="request-email">{{ row.email }}</small></template>
          </el-table-column>
          <el-table-column label="状态" width="92"><template #default="{ row }"><el-tag :type="row.status === 'pending' ? 'warning' : row.status === 'approved' ? 'success' : 'info'" effect="plain">{{ row.status === 'pending' ? '待审批' : row.status === 'approved' ? '已批准' : '已拒绝' }}</el-tag></template></el-table-column>
          <el-table-column label="申请时间" width="165"><template #default="{ row }">{{ formatTime(row.requestedAt) }}</template></el-table-column>
          <el-table-column label="操作" width="142" fixed="right">
            <template #default="{ row }"><template v-if="row.status === 'pending'"><el-button text type="primary" :loading="handlingId === row.id" @click="approve(row)">批准</el-button><el-button text type="danger" :disabled="handlingId === row.id" @click="reject(row)">拒绝</el-button></template><span v-else class="muted">{{ row.reviewNote || '已处理' }}</span></template>
          </el-table-column>
        </el-table>
      </section>
    </template>
    <template #footer><el-button @click="signOut">退出登录</el-button><el-button type="primary" @click="open = false">完成</el-button></template>
  </el-dialog>
</template>

<style scoped>
.account-summary { display: flex; align-items: center; gap: 11px; padding: 15px; border: 1px solid #e5eaf1; border-radius: 12px; background: #f8faff; }
.account-avatar { display: grid; width: 34px; height: 34px; place-items: center; border-radius: 50%; background: #2f6fed; color: #fff; font-weight: 700; }
.account-summary div { display: grid; gap: 3px; }.account-summary small, .request-email { color: #7e8999; font-size: 12px; }.account-summary .el-tag { margin-left: auto; }
.approval-section { margin-top: 22px; }.section-heading { display: flex; align-items: center; justify-content: space-between; }.section-heading h3 { margin: 0; font-size: 15px; }.section-heading p { margin: 5px 0 13px; color: #7a8798; font-size: 12px; }.request-email { display: block; margin-top: 3px; }.muted { color: #8994a4; font-size: 12px; }
</style>
