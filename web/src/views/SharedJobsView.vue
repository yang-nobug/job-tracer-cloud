<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api, ApiError } from '../api'
import { openDetail, bumpData } from '../store'
import { STATUS_LABELS, type Status } from '../types'

interface Duplicate {
  applicationId: number
  kind: 'jd_link' | 'company_position'
  status: Status
  statusLabel: string
  rejectedAt: string | null
  rejectType: 'company' | 'me' | null
}
interface SharedJob {
  id: number
  company: string
  position: string
  location: string | null
  channel: string | null
  jdLink: string | null
  applicationLink: string | null
  jdText: string | null
  createdAt: string
  updatedAt: string
  duplicate: Duplicate | null
}

const router = useRouter()
const jobs = ref<SharedJob[]>([])
const selected = ref<SharedJob | null>(null)
const keyword = ref('')
const location = ref('')
const loading = ref(false)
const consented = ref<boolean | null>(null)
const consentSaving = ref(false)
const addingId = ref<number | null>(null)

const locations = computed(() => [...new Set(jobs.value.map(item => item.location).filter((item): item is string => Boolean(item)))])

function duplicateText(duplicate: Duplicate): string {
  if (duplicate.rejectedAt) return `曾投递 · ${duplicate.rejectType === 'me' ? '已放弃' : '已挂'}`
  if (duplicate.status === 'unsent') return '已加入待投递'
  return `已投递 · ${STATUS_LABELS[duplicate.status]}`
}

function duplicateType(duplicate: Duplicate): 'info' | 'warning' | 'success' {
  if (duplicate.rejectedAt) return 'info'
  if (duplicate.status === 'unsent') return 'warning'
  return 'success'
}

function date(value: string): string {
  return new Date(value).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })
}

function jdSummary(value: string | null): string {
  const text = value?.replace(/\s+/g, ' ').trim() ?? ''
  return text ? text.slice(0, 150) + (text.length > 150 ? '…' : '') : '暂未录入 JD 正文，可通过链接查看岗位详情。'
}

function openExternal(value: string | null): void {
  if (!value) { ElMessage.warning('该岗位暂未提供链接'); return }
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol')
    window.open(url.toString(), '_blank', 'noopener,noreferrer')
  } catch {
    ElMessage.error('链接格式无效，无法打开')
  }
}

async function loadConsent(): Promise<void> {
  const status = await api.get<{ consented: boolean }>('/shared-jobs/status')
  consented.value = status.consented
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const params = new URLSearchParams()
    if (keyword.value.trim()) params.set('keyword', keyword.value.trim())
    if (location.value) params.set('location', location.value)
    jobs.value = await api.get<SharedJob[]>(`/shared-jobs${params.size ? `?${params.toString()}` : ''}`)
  } catch (error) {
    if (error instanceof ApiError && error.body.code === 'shared_jobs_consent_required') consented.value = false
    else ElMessage.error((error as Error).message || '加载共享岗位失败')
  } finally { loading.value = false }
}

async function acceptConsent(): Promise<void> {
  consentSaving.value = true
  try {
    await api.put('/shared-jobs/consent', { consented: true })
    consented.value = true
    ElMessage.success('已开启共享岗位，你的岗位公开字段将参与共享')
    await load()
  } catch (error) { ElMessage.error((error as Error).message || '保存失败')
  } finally { consentSaving.value = false }
}

function leaveSharedJobs(): void { void router.push('/track/kanban') }

async function addToMine(job: SharedJob): Promise<void> {
  addingId.value = job.id
  try {
    const application = await api.post<{ id: number }>('/shared-jobs/' + job.id + '/add')
    bumpData()
    ElMessage.success('已加入你的待投递列表')
    job.duplicate = {
      applicationId: application.id,
      kind: 'jd_link', status: 'unsent', statusLabel: STATUS_LABELS.unsent,
      rejectedAt: null, rejectType: null
    }
    selected.value = job
  } catch (error) {
    const apiError = error as ApiError
    const duplicate = apiError.body?.duplicate as Duplicate | undefined
    if (apiError.status === 409 && duplicate) {
      job.duplicate = duplicate
      ElMessage.warning('该岗位已在你的投递列表中')
    } else ElMessage.error((error as Error).message || '加入投递失败')
  } finally { addingId.value = null }
}

function viewMine(duplicate: Duplicate): void {
  openDetail(duplicate.applicationId)
  void router.push('/track/kanban')
}

onMounted(async () => {
  try {
    await loadConsent()
    if (consented.value) await load()
  } catch (error) { ElMessage.error((error as Error).message || '无法读取共享权限') }
})
</script>

<template>
  <section class="shared-page" v-loading="loading">
    <header class="page-intro">
      <div>
        <p class="page-kicker">SHARED JOBS</p>
        <h1>共享岗位</h1>
        <p>同意共享的用户可以互相查看岗位 JD 与投递链接；个人进度、面试、简历和联系方式始终保持私有。</p>
      </div>
      <div class="intro-count"><b>{{ jobs.length }}</b><span>个可参考岗位</span></div>
    </header>

    <section v-if="consented" class="filter-bar">
      <el-input v-model="keyword" clearable placeholder="搜索公司、岗位或 JD 关键词" @keyup.enter="load" @clear="load">
        <template #append><el-button @click="load">搜索</el-button></template>
      </el-input>
      <el-select v-model="location" clearable placeholder="全部地点" @change="load">
        <el-option v-for="item in locations" :key="item" :label="item" :value="item" />
      </el-select>
    </section>

    <div v-if="consented" class="job-grid">
      <article v-for="job in jobs" :key="job.id" class="job-card" @click="selected = job">
        <div class="card-head">
          <div class="company-mark">{{ job.company.slice(0, 1) }}</div>
          <div class="job-title"><b>{{ job.company }}</b><h2>{{ job.position }}</h2></div>
          <el-tag v-if="job.duplicate" :type="duplicateType(job.duplicate)" effect="plain" size="small">{{ duplicateText(job.duplicate) }}</el-tag>
        </div>
        <div class="job-meta"><span v-if="job.location">{{ job.location }}</span><span v-if="job.channel">{{ job.channel }}</span><span>{{ date(job.updatedAt) }}</span></div>
        <p class="job-summary">{{ jdSummary(job.jdText) }}</p>
        <footer class="card-actions" @click.stop>
          <el-button text type="primary" @click="selected = job">查看详情</el-button>
          <template v-if="job.duplicate">
            <el-button text type="primary" @click="viewMine(job.duplicate)">查看我的投递</el-button>
            <el-button v-if="job.duplicate.status === 'unsent' && !job.duplicate.rejectedAt" text type="primary" @click="openExternal(job.applicationLink)">去投递</el-button>
          </template>
          <template v-else>
            <el-button v-if="job.applicationLink" text type="primary" @click="openExternal(job.applicationLink)">去投递</el-button>
            <el-button type="primary" size="small" :loading="addingId === job.id" @click="addToMine(job)">加入我的投递</el-button>
          </template>
        </footer>
      </article>
    </div>
    <el-empty v-else-if="consented" description="暂时还没有共享岗位" :image-size="100" />

    <el-dialog :model-value="Boolean(selected)" class="shared-detail" width="min(760px, calc(100vw - 28px))" destroy-on-close @update:model-value="value => { if (!value) selected = null }">
      <template #header><div v-if="selected"><p class="page-kicker">SHARED JOB</p><h2>{{ selected.company }} · {{ selected.position }}</h2></div></template>
      <template v-if="selected">
        <div class="detail-meta"><el-tag v-if="selected.location" effect="plain">{{ selected.location }}</el-tag><el-tag v-if="selected.channel" effect="plain">{{ selected.channel }}</el-tag><el-tag v-if="selected.duplicate" :type="duplicateType(selected.duplicate)" effect="plain">{{ duplicateText(selected.duplicate) }}</el-tag></div>
        <section class="detail-section"><h3>岗位说明</h3><p class="jd-content">{{ selected.jdText || '暂未录入 JD 正文。' }}</p></section>
        <div class="link-actions"><el-button v-if="selected.jdLink" @click="openExternal(selected.jdLink)">查看 JD 链接</el-button><el-button v-if="selected.applicationLink && (!selected.duplicate || selected.duplicate.status === 'unsent')" @click="openExternal(selected.applicationLink)">去投递</el-button><el-button v-if="selected.duplicate" type="primary" @click="viewMine(selected.duplicate)">查看我的投递</el-button><el-button v-else type="primary" :loading="addingId === selected.id" @click="addToMine(selected)">加入我的投递</el-button></div>
      </template>
    </el-dialog>

    <el-dialog :model-value="consented === false" title="加入共享岗位" width="min(520px, calc(100vw - 28px))" :close-on-click-modal="false" :show-close="false" :close-on-press-escape="false">
      <p class="consent-lead">共享岗位是互惠功能：同意共享后，才能查看其他用户汇总的岗位信息。</p>
      <div class="consent-box"><b>会共享</b><p>公司、岗位、地点、岗位类型、JD 正文、JD 链接和投递链接。</p><b>不会共享</b><p>投递进度、日程、面经、简历、联系人、联系方式、附件和 AI 记录。</p></div>
      <template #footer><el-button @click="leaveSharedJobs">暂不同意</el-button><el-button type="primary" :loading="consentSaving" @click="acceptConsent">同意共享并进入</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.shared-page { min-height: 500px; }.page-intro { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin: 2px 0 20px; }.page-kicker { margin: 0 0 4px; color: var(--jt-primary); font-size: 11px; font-weight: 800; letter-spacing: 1.1px; }.page-intro h1 { margin: 0; font-size: 25px; letter-spacing: -.5px; }.page-intro p:not(.page-kicker) { max-width: 660px; margin: 8px 0 0; color: var(--jt-text-muted); font-size: 13px; line-height: 1.65; }.intro-count { display: grid; min-width: 106px; padding: 10px 14px; text-align: right; border: 1px solid var(--jt-line); border-radius: 10px; background: var(--jt-surface); }.intro-count b { color: var(--jt-primary); font-size: 21px; }.intro-count span { color: var(--jt-text-muted); font-size: 11px; }.filter-bar { display: flex; gap: 10px; margin-bottom: 16px; }.filter-bar .el-input { max-width: 480px; }.filter-bar .el-select { width: 150px; }.job-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); gap: 13px; }.job-card { display: flex; min-height: 225px; flex-direction: column; padding: 16px; border: 1px solid var(--jt-line); border-radius: var(--jt-radius); background: var(--jt-surface); cursor: pointer; transition: border-color .18s, box-shadow .18s, transform .18s; }.job-card:hover { border-color: #b9cff7; box-shadow: var(--jt-shadow); transform: translateY(-1px); }.card-head { display: flex; align-items: flex-start; gap: 10px; }.company-mark { display: grid; width: 34px; height: 34px; flex: none; place-items: center; border-radius: 9px; background: #edf3ff; color: var(--jt-primary); font-weight: 800; }.job-title { min-width: 0; flex: 1; }.job-title b { display: block; overflow: hidden; color: var(--jt-text); font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }.job-title h2 { overflow: hidden; margin: 3px 0 0; font-size: 16px; text-overflow: ellipsis; white-space: nowrap; }.card-head .el-tag { max-width: 130px; overflow: hidden; flex: none; text-overflow: ellipsis; white-space: nowrap; }.job-meta { display: flex; gap: 7px; margin: 12px 0; color: var(--jt-text-muted); font-size: 12px; }.job-meta span + span::before { margin-right: 7px; color: #c4ccd7; content: '·'; }.job-summary { display: -webkit-box; overflow: hidden; margin: 0; color: #667386; font-size: 12px; line-height: 1.65; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }.card-actions { display: flex; align-items: center; gap: 2px; margin-top: auto; padding-top: 12px; }.card-actions .el-button:last-child { margin-left: auto; }.shared-detail :deep(.el-dialog__header) { margin-right: 0; padding-bottom: 8px; border-bottom: 1px solid var(--jt-line); }.shared-detail h2 { margin: 0; font-size: 19px; }.detail-meta { display: flex; flex-wrap: wrap; gap: 7px; }.detail-section { margin-top: 18px; }.detail-section h3 { margin: 0 0 8px; font-size: 14px; }.jd-content { max-height: 400px; overflow: auto; margin: 0; padding: 13px; border-radius: 8px; background: #f7f9fc; color: #445268; font-size: 13px; line-height: 1.75; white-space: pre-wrap; }.link-actions { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 18px; }.consent-lead { margin: 0; color: #45546a; line-height: 1.7; }.consent-box { margin-top: 15px; padding: 14px; border: 1px solid #dce7fa; border-radius: 10px; background: #f7faff; }.consent-box b { font-size: 13px; }.consent-box p { margin: 4px 0 12px; color: #66758a; font-size: 12px; line-height: 1.6; }.consent-box p:last-child { margin-bottom: 0; }
@media (max-width: 620px) { .page-intro { flex-direction: column; }.intro-count { text-align: left; }.filter-bar { align-items: stretch; flex-direction: column; }.filter-bar .el-input,.filter-bar .el-select { width: 100%; max-width: none; }.job-grid { grid-template-columns: 1fr; } }
</style>
