<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { bumpData, store } from '../store'

type EventType = 'assessment' | 'written_test' | 'interview' | 'ai_interview' | 'offer' | 'other'
type TimeMode = 'fixed' | 'window' | 'deadline' | 'duration_after_open' | 'flexible' | 'unknown'
type ScheduleStatus = 'active' | 'completed' | 'cancelled'

interface ScheduleItem {
  id: number
  applicationId: number | null
  sourceCandidateId: number | null
  source: 'mail' | 'manual'
  interviewId: number | null
  eventType: EventType
  round: string
  title: string
  company: string
  position: string
  timeMode: TimeMode
  scheduledAt: string | null
  windowStartAt: string | null
  windowEndAt: string | null
  deadlineAt: string | null
  durationMinutes: number | null
  location: string
  meetingLink: string
  actionLink: string
  contact: string
  instructions: string[]
  status: ScheduleStatus
}

const props = defineProps<{ appId: number }>()
const items = ref<ScheduleItem[]>([])
const loading = ref(false)
const saving = ref(false)
const updatingId = ref<number | null>(null)
const showEditor = ref(false)
const editing = ref<ScheduleItem | null>(null)
const focusId = computed(() => store.scheduleFocusId)

const eventLabels: Record<EventType, string> = {
  assessment: '在线测评', written_test: '笔试', interview: '面试', ai_interview: 'AI 面试', offer: 'Offer / 录用', other: '其他事项'
}
const timeModeLabels: Record<TimeMode, string> = {
  fixed: '固定开始时间', window: '可完成时间窗口', deadline: '仅截止时间', duration_after_open: '开始后计时', flexible: '时间灵活', unknown: '时间待定'
}
const statusLabels: Record<ScheduleStatus, string> = { active: '进行中', completed: '已完成', cancelled: '已取消' }
const eventOptions = Object.entries(eventLabels).map(([value, label]) => ({ value: value as EventType, label }))
const timeModeOptions = Object.entries(timeModeLabels).map(([value, label]) => ({ value: value as TimeMode, label }))

const form = reactive({
  eventType: 'interview' as EventType, round: '一面', title: '', company: '', position: '', timeMode: 'fixed' as TimeMode,
  scheduledAt: '' as string | null, windowStartAt: '' as string | null, windowEndAt: '' as string | null, deadlineAt: '' as string | null,
  durationMinutes: null as number | null, location: '', meetingLink: '', actionLink: '', contact: '', instructionsText: '', createInterview: true
})

function resetForm(item?: ScheduleItem): void {
  const value = item
  form.eventType = value?.eventType ?? 'interview'
  form.round = value?.round ?? '一面'
  form.title = value?.title ?? ''
  form.company = value?.company ?? ''
  form.position = value?.position ?? ''
  form.timeMode = value?.timeMode ?? 'fixed'
  form.scheduledAt = value?.scheduledAt ?? ''
  form.windowStartAt = value?.windowStartAt ?? ''
  form.windowEndAt = value?.windowEndAt ?? ''
  form.deadlineAt = value?.deadlineAt ?? ''
  form.durationMinutes = value?.durationMinutes ?? null
  form.location = value?.location ?? ''
  form.meetingLink = value?.meetingLink ?? ''
  form.actionLink = value?.actionLink ?? ''
  form.contact = value?.contact ?? ''
  form.instructionsText = value?.instructions.join('\n') ?? ''
  form.createInterview = value ? Boolean(value.interviewId) : true
}

function payload() {
  return {
    eventType: form.eventType, round: form.round, title: form.title, company: form.company, position: form.position, timeMode: form.timeMode,
    scheduledAt: form.scheduledAt || null, windowStartAt: form.windowStartAt || null, windowEndAt: form.windowEndAt || null,
    deadlineAt: form.deadlineAt || null, durationMinutes: form.durationMinutes, location: form.location, meetingLink: form.meetingLink,
    actionLink: form.actionLink, contact: form.contact, instructions: form.instructionsText.split(/\r?\n/).map(item => item.trim()).filter(Boolean), createInterview: form.createInterview && Boolean(form.scheduledAt)
  }
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const all = await api.get<ScheduleItem[]>('/schedule?status=all&limit=500')
    items.value = all.filter(item => item.applicationId === props.appId)
    await nextTick()
    if (focusId.value) document.getElementById(`schedule-${focusId.value}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  } catch (error) { ElMessage.error((error as Error).message) } finally { loading.value = false }
}

function openCreate(): void { editing.value = null; resetForm(); showEditor.value = true }
function openEdit(item: ScheduleItem): void { editing.value = item; resetForm(item); showEditor.value = true }

async function save(): Promise<void> {
  saving.value = true
  try {
    const saved = editing.value
      ? await api.patch<ScheduleItem>(`/schedules/${editing.value.id}`, payload())
      : await api.post<ScheduleItem>(`/applications/${props.appId}/schedules`, payload())
    const index = items.value.findIndex(item => item.id === saved.id)
    if (index >= 0) items.value.splice(index, 1, saved)
    else items.value.push(saved)
    items.value.sort((left, right) => primaryTime(left).localeCompare(primaryTime(right)))
    showEditor.value = false
    ElMessage.success(editing.value ? '招聘日程已更新' : '招聘日程已创建')
    bumpData()
  } catch (error) { ElMessage.error((error as Error).message) } finally { saving.value = false }
}

async function updateStatus(item: ScheduleItem, status: ScheduleStatus): Promise<void> {
  updatingId.value = item.id
  try {
    const saved = await api.patch<ScheduleItem>(`/schedule/${item.id}/status`, { status })
    const index = items.value.findIndex(value => value.id === saved.id)
    if (index >= 0) items.value.splice(index, 1, saved)
    ElMessage.success(status === 'completed' ? '日程已标记完成' : status === 'cancelled' ? '日程已取消' : '日程已恢复')
    bumpData()
  } catch (error) { ElMessage.error((error as Error).message) } finally { updatingId.value = null }
}

async function createInterview(item: ScheduleItem): Promise<void> {
  updatingId.value = item.id
  try {
    const result = await api.post<{ schedule: ScheduleItem }>(`/schedules/${item.id}/interview`)
    const index = items.value.findIndex(value => value.id === item.id)
    if (index >= 0) items.value.splice(index, 1, result.schedule)
    ElMessage.success('已建立面试准备，可在下方添加清单、录音和复盘')
    bumpData()
  } catch (error) { ElMessage.error((error as Error).message) } finally { updatingId.value = null }
}

async function remove(item: ScheduleItem): Promise<void> {
  try {
    const detail = item.interviewId ? '关联的准备清单、录音和复盘也会删除。' : ''
    await ElMessageBox.confirm(`删除「${item.title}」？${detail}`, '删除招聘日程', { type: 'warning' })
    await api.delete(`/schedules/${item.id}`)
    items.value = items.value.filter(value => value.id !== item.id)
    ElMessage.success('招聘日程已删除')
    bumpData()
  } catch (error) { if (!(error as Error).message?.includes('cancel')) ElMessage.error((error as Error).message) }
}

function primaryTime(item: ScheduleItem): string { return item.scheduledAt || item.windowStartAt || item.windowEndAt || item.deadlineAt || '9999-12-31 23:59' }
function timeLines(item: ScheduleItem): string[] {
  const lines: string[] = []
  if (item.scheduledAt) lines.push(`开始 ${item.scheduledAt}`)
  if (item.windowStartAt) lines.push(`开放 ${item.windowStartAt}`)
  if (item.windowEndAt) lines.push(`关闭 ${item.windowEndAt}`)
  if (item.deadlineAt) lines.push(`截止 ${item.deadlineAt}`)
  if (item.durationMinutes) lines.push(`开始后限时 ${item.durationMinutes} 分钟`)
  return lines.length ? lines : [item.timeMode === 'flexible' ? '时间灵活安排' : '时间待确认']
}

watch(() => [props.appId, store.dataVersion] as const, () => { void load() }, { immediate: true })
</script>

<template>
  <section class="schedule-panel" v-loading="loading">
    <div class="schedule-head">
      <div><p>RECRUITMENT TIMELINE</p><h3>招聘日程</h3><small>邮箱通知和手动添加的事项会集中在这里。</small></div>
      <el-button size="small" type="primary" plain @click="openCreate">+ 新增日程</el-button>
    </div>

    <el-empty v-if="!items.length && !loading" description="暂无招聘日程" :image-size="46" />
    <article v-for="item in items" :id="`schedule-${item.id}`" :key="item.id" class="schedule-card" :class="{ focused: focusId === item.id, inactive: item.status !== 'active' }">
      <div class="schedule-card-main">
        <div class="schedule-card-title">
          <b>{{ item.title }}</b>
          <el-tag size="small" effect="plain">{{ eventLabels[item.eventType] }}</el-tag>
          <el-tag v-if="item.status !== 'active'" size="small" :type="item.status === 'completed' ? 'success' : 'info'">{{ statusLabels[item.status] }}</el-tag>
          <el-tag size="small" type="info" effect="plain">{{ item.source === 'mail' ? '邮件识别' : '手动添加' }}</el-tag>
        </div>
        <p v-if="item.round || item.location">{{ [item.round, item.location].filter(Boolean).join(' · ') }}</p>
        <div class="schedule-times"><span v-for="line in timeLines(item)" :key="line">{{ line }}</span></div>
        <div v-if="item.instructions.length" class="schedule-instructions">{{ item.instructions.join('；') }}</div>
      </div>
      <div class="schedule-actions">
        <el-button v-if="item.status === 'active' && !item.interviewId && item.scheduledAt" link type="primary" :loading="updatingId === item.id" @click="createInterview(item)">开始准备</el-button>
        <el-button v-if="item.status === 'active'" link type="success" :loading="updatingId === item.id" @click="updateStatus(item, 'completed')">完成</el-button>
        <el-button v-if="item.status === 'active'" link type="warning" :loading="updatingId === item.id" @click="updateStatus(item, 'cancelled')">取消</el-button>
        <el-button v-else link type="primary" :loading="updatingId === item.id" @click="updateStatus(item, 'active')">恢复</el-button>
        <el-button link @click="openEdit(item)">编辑</el-button>
        <el-button link type="danger" @click="remove(item)">删除</el-button>
      </div>
    </article>

    <el-dialog v-model="showEditor" :title="editing ? '编辑招聘日程' : '新增招聘日程'" width="min(680px, calc(100vw - 24px))" append-to-body destroy-on-close>
      <el-form label-position="top" class="schedule-form">
        <div class="form-grid">
          <el-form-item label="事件类型"><el-select v-model="form.eventType"><el-option v-for="option in eventOptions" :key="option.value" :value="option.value" :label="option.label" /></el-select></el-form-item>
          <el-form-item label="面试轮次（可选）"><el-input v-model="form.round" maxlength="40" placeholder="例如：一面、HR 面" /></el-form-item>
          <el-form-item label="标题（可选）" class="wide"><el-input v-model="form.title" maxlength="300" placeholder="留空时系统按公司、岗位和事件生成" /></el-form-item>
          <el-form-item label="公司"><el-input v-model="form.company" maxlength="200" /></el-form-item>
          <el-form-item label="岗位"><el-input v-model="form.position" maxlength="200" /></el-form-item>
          <el-form-item label="时间规则"><el-select v-model="form.timeMode"><el-option v-for="option in timeModeOptions" :key="option.value" :value="option.value" :label="option.label" /></el-select></el-form-item>
          <el-form-item v-if="form.timeMode === 'fixed'" label="固定开始时间"><el-date-picker v-model="form.scheduledAt" type="datetime" value-format="YYYY-MM-DD HH:mm" format="YYYY-MM-DD HH:mm" /></el-form-item>
          <template v-if="form.timeMode === 'window'"><el-form-item label="开放时间"><el-date-picker v-model="form.windowStartAt" type="datetime" value-format="YYYY-MM-DD HH:mm" format="YYYY-MM-DD HH:mm" /></el-form-item><el-form-item label="关闭时间"><el-date-picker v-model="form.windowEndAt" type="datetime" value-format="YYYY-MM-DD HH:mm" format="YYYY-MM-DD HH:mm" /></el-form-item></template>
          <el-form-item v-if="['fixed', 'window', 'deadline', 'duration_after_open'].includes(form.timeMode)" :label="form.timeMode === 'deadline' ? '截止时间' : '截止时间（可选）'"><el-date-picker v-model="form.deadlineAt" type="datetime" value-format="YYYY-MM-DD HH:mm" format="YYYY-MM-DD HH:mm" /></el-form-item>
          <el-form-item v-if="['window', 'duration_after_open'].includes(form.timeMode)" label="开始后限时（分钟）"><el-input-number v-model="form.durationMinutes" :min="1" :max="10080" /></el-form-item>
          <el-form-item label="地点 / 方式"><el-input v-model="form.location" maxlength="500" /></el-form-item>
          <el-form-item label="联系人"><el-input v-model="form.contact" maxlength="500" /></el-form-item>
          <el-form-item label="会议链接" class="wide"><el-input v-model="form.meetingLink" maxlength="2048" /></el-form-item>
          <el-form-item label="测评 / 操作链接" class="wide"><el-input v-model="form.actionLink" maxlength="2048" /></el-form-item>
          <el-form-item label="执行要求（每行一项）" class="wide"><el-input v-model="form.instructionsText" type="textarea" :rows="3" maxlength="4000" /></el-form-item>
        </div>
        <el-checkbox v-if="form.scheduledAt" v-model="form.createInterview">同时创建面试准备（清单、录音、复盘）</el-checkbox>
      </el-form>
      <template #footer><el-button @click="showEditor = false">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.schedule-panel { margin-top: 20px; padding: 16px; border: 1px solid var(--jt-line, #e7e9ee); border-radius: 12px; background: #fff; }
.schedule-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; margin-bottom: 10px; }
.schedule-head p { margin: 0 0 3px; color: var(--jt-primary, #2563eb); font-size: 10px; font-weight: 800; letter-spacing: .1em; }
.schedule-head h3 { margin: 0; font-size: 16px; }.schedule-head small { color: var(--jt-muted, #6b7280); }
.schedule-card { display: flex; gap: 14px; justify-content: space-between; padding: 12px 0; border-top: 1px solid var(--jt-line, #e7e9ee); }.schedule-card.focused { margin: 0 -8px; padding: 12px 8px; border-radius: 8px; background: #edf4ff; }.schedule-card.inactive { opacity: .68; }
.schedule-card-main { min-width: 0; }.schedule-card-title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }.schedule-card-title b { overflow-wrap: anywhere; }.schedule-card-main p { margin: 5px 0; color: var(--jt-muted, #6b7280); font-size: 13px; }.schedule-times { display: flex; gap: 6px 12px; flex-wrap: wrap; color: var(--jt-primary, #2563eb); font-size: 12px; }.schedule-instructions { margin-top: 6px; color: #6b7280; font-size: 12px; line-height: 1.55; }.schedule-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; align-content: flex-start; flex: 0 0 auto; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 14px; }.form-grid .wide { grid-column: 1 / -1; }.schedule-form :deep(.el-select), .schedule-form :deep(.el-date-editor) { width: 100%; }
@media (max-width: 640px) { .schedule-head, .schedule-card { flex-direction: column; }.schedule-actions { justify-content: flex-start; }.form-grid { grid-template-columns: 1fr; }.form-grid .wide { grid-column: auto; } }
</style>
