<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api, ApiError } from '../api'

type Period = 'week' | 'month' | 'all'

interface LeaderboardEntry {
  userId: string
  displayName: string
  count: number
  rank: number
}

interface LeaderboardResponse {
  period: Period
  periodLabel: string
  startsAt: string | null
  totalParticipants: number
  totalApplications: number
  entries: LeaderboardEntry[]
  currentUser: LeaderboardEntry | null
}

const router = useRouter()
const period = ref<Period>('week')
const consented = ref<boolean | null>(null)
const consentSaving = ref(false)
const loading = ref(false)
const board = ref<LeaderboardResponse | null>(null)

const periodOptions: Array<{ value: Period; label: string }> = [
  { value: 'week', label: '本周' }, { value: 'month', label: '本月' }, { value: 'all', label: '全部' }
]
const currentInTopList = computed(() => {
  const current = board.value?.currentUser
  return current ? (board.value?.entries ?? []).some(item => item.userId === current.userId) : false
})

function avatarText(name: string): string { return name.trim().slice(0, 1).toUpperCase() || '?' }
function avatarStyle(name: string): { background: string } {
  const colors = ['#2f6fed', '#7c5ce3', '#0f9f86', '#d77a1e', '#c44f75', '#3176a8']
  const seed = [...name].reduce((value, char) => value + char.codePointAt(0)!, 0)
  return { background: colors[seed % colors.length] }
}
function rankClass(rank: number): string { return rank <= 3 ? `rank-${rank}` : '' }
function rankMark(rank: number): string { return rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : String(rank) }
function leave(): void { void router.push('/track/kanban') }

async function loadConsent(): Promise<void> {
  const status = await api.get<{ consented: boolean }>('/shared-jobs/status')
  consented.value = status.consented
}

async function load(): Promise<void> {
  if (!consented.value) return
  loading.value = true
  try {
    board.value = await api.get<LeaderboardResponse>(`/leaderboard?period=${period.value}`)
  } catch (error) {
    if (error instanceof ApiError && error.body.code === 'shared_jobs_consent_required') consented.value = false
    else ElMessage.error((error as Error).message || '加载排行榜失败')
  } finally { loading.value = false }
}

async function acceptConsent(): Promise<void> {
  consentSaving.value = true
  try {
    await api.put('/shared-jobs/consent', { consented: true })
    consented.value = true
    ElMessage.success('已开启共享岗位，并加入投递排行榜')
    await load()
  } catch (error) { ElMessage.error((error as Error).message || '保存失败')
  } finally { consentSaving.value = false }
}

function onConsentRevoked(): void {
  consented.value = false
  board.value = null
}

watch(period, () => { void load() })
onMounted(async () => {
  window.addEventListener('job-tracer:shared-jobs-revoked', onConsentRevoked)
  try { await loadConsent(); await load() } catch (error) { ElMessage.error((error as Error).message || '无法读取共享权限') }
})
onUnmounted(() => window.removeEventListener('job-tracer:shared-jobs-revoked', onConsentRevoked))
</script>

<template>
  <section class="leaderboard-page" v-loading="loading">
    <header class="leaderboard-hero">
      <div>
        <p class="page-kicker">APPLICATION LEADERBOARD</p>
        <h1>投递排行榜</h1>
        <p>只展示已同意共享岗位用户的昵称和有效投递数量，不展示任何公司、岗位或投递进度。</p>
      </div>
      <el-radio-group v-if="consented" v-model="period" class="period-tabs">
        <el-radio-button v-for="option in periodOptions" :key="option.value" :value="option.value">{{ option.label }}</el-radio-button>
      </el-radio-group>
    </header>

    <template v-if="consented && board">
      <section class="summary-grid">
        <article><span>{{ board.periodLabel }}有效投递</span><b>{{ board.totalApplications }}</b><small>状态不是“未投递”的记录</small></article>
        <article><span>参与人数</span><b>{{ board.totalParticipants }}</b><small>已同意共享岗位的用户</small></article>
        <article v-if="board.currentUser"><span>我的名次</span><b>#{{ board.currentUser.rank }}</b><small>{{ board.currentUser.count }} 次有效投递</small></article>
      </section>

      <section class="rank-list">
        <div class="list-heading"><h2>完整排名</h2><span>相同投递数并列同一名次</span></div>
        <el-empty v-if="!board.entries.length" description="暂时还没有可统计的有效投递" :image-size="76" />
        <article v-for="entry in board.entries" :key="entry.userId" class="rank-row" :class="[rankClass(entry.rank), { mine: entry.userId === board.currentUser?.userId }]">
          <b class="rank-number">{{ rankMark(entry.rank) }}</b>
          <span class="avatar small" :style="avatarStyle(entry.displayName)">{{ avatarText(entry.displayName) }}</span>
          <span class="name">{{ entry.displayName }}</span>
          <strong>{{ entry.count }}</strong><small>次</small>
        </article>
      </section>

      <section v-if="board.currentUser && !currentInTopList" class="my-rank">
        <span>我的排名</span><b>#{{ board.currentUser.rank }}</b><span>{{ board.currentUser.displayName }}</span><strong>{{ board.currentUser.count }} 次有效投递</strong>
      </section>
    </template>

    <el-dialog :model-value="consented === false" title="加入共享区后查看排行榜" width="min(520px, calc(100vw - 28px))" :close-on-click-modal="false" :show-close="false" :close-on-press-escape="false">
      <p class="consent-lead">投递排行榜与共享岗位使用同一份互惠授权。已同意共享岗位的用户可以查看榜单，也会以昵称和有效投递数量参与排名。</p>
      <div class="consent-box"><b>会展示</b><p>昵称、头像样式和有效投递数量。</p><b>不会展示</b><p>公司、岗位、JD、投递链接、投递进度、日程、面经、简历、联系人或联系方式。</p></div>
      <template #footer><el-button @click="leave">暂不同意</el-button><el-button type="primary" :loading="consentSaving" @click="acceptConsent">同意共享并查看排行榜</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.leaderboard-page { min-height: 500px; }
.leaderboard-hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 18px; margin: 2px 0 20px; }
.page-kicker { margin: 0 0 4px; color: var(--jt-primary); font-size: 11px; font-weight: 800; letter-spacing: 1.1px; }
.leaderboard-hero h1 { margin: 0; font-size: 25px; letter-spacing: -.5px; }
.leaderboard-hero p:not(.page-kicker) { max-width: 680px; margin: 8px 0 0; color: var(--jt-text-muted); font-size: 13px; line-height: 1.65; }
.period-tabs { flex: none; }
.summary-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.summary-grid article { display: grid; padding: 15px 17px; border: 1px solid var(--jt-line); border-radius: 12px; background: var(--jt-surface); }
.summary-grid span, .summary-grid small { color: var(--jt-text-muted); font-size: 12px; }
.summary-grid b { margin: 6px 0 3px; color: var(--jt-primary); font-size: 26px; line-height: 1; }
.avatar { display: grid; place-items: center; border-radius: 50%; color: #fff; font-weight: 800; }
.avatar.small { width: 34px; height: 34px; font-size: 13px; }
.rank-list { margin-top: 18px; padding: 2px 17px; border: 1px solid var(--jt-line); border-radius: 12px; background: var(--jt-surface); }
.list-heading { display: flex; align-items: center; justify-content: space-between; padding: 14px 0; border-bottom: 1px solid var(--jt-line); }
.list-heading h2 { margin: 0; font-size: 15px; }
.list-heading span { color: var(--jt-text-muted); font-size: 12px; }
.rank-row { display: grid; grid-template-columns: 42px 34px minmax(0, 1fr) auto auto; gap: 11px; align-items: center; min-height: 64px; border-bottom: 1px solid var(--jt-line); }
.rank-row:last-child { border-bottom: 0; }
.rank-row.rank-1 { margin: 0 -9px; padding: 0 9px; background: linear-gradient(90deg, #fffaf0, #fff); }
.rank-row.rank-2 { margin: 0 -9px; padding: 0 9px; background: #fbfcff; }
.rank-row.rank-3 { margin: 0 -9px; padding: 0 9px; background: #fffaf7; }
.rank-row.mine { box-shadow: inset 3px 0 0 var(--jt-primary); }
.rank-number { color: #7e8999; text-align: center; font-size: 14px; }
.rank-1 .rank-number, .rank-2 .rank-number, .rank-3 .rank-number { font-size: 21px; }
.rank-row .name { overflow: hidden; font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.rank-row strong { color: var(--jt-primary); font-size: 16px; }
.rank-row small { color: var(--jt-text-muted); font-size: 12px; }
.my-rank { display: flex; align-items: center; gap: 11px; margin-top: 14px; padding: 14px 16px; border: 1px solid #bfd4f9; border-radius: 11px; background: #f4f8ff; }
.my-rank span { color: var(--jt-text-muted); font-size: 13px; }
.my-rank b, .my-rank strong { color: var(--jt-primary); }
.my-rank strong { margin-left: auto; font-size: 13px; }
.consent-lead { margin: 0; color: #45546a; line-height: 1.7; }
.consent-box { margin-top: 15px; padding: 14px; border: 1px solid #dce7fa; border-radius: 10px; background: #f7faff; }
.consent-box b { font-size: 13px; }
.consent-box p { margin: 4px 0 12px; color: #66758a; font-size: 12px; line-height: 1.6; }
.consent-box p:last-child { margin-bottom: 0; }
@media (max-width: 680px) {
  .leaderboard-hero { align-items: stretch; flex-direction: column; }
  .period-tabs { align-self: flex-start; }
  .summary-grid { grid-template-columns: 1fr; }
  .rank-list { padding: 2px 12px; }
  .list-heading span { display: none; }
  .rank-row { grid-template-columns: 34px 34px minmax(0, 1fr) auto auto; gap: 7px; min-height: 60px; }
  .rank-row.rank-1, .rank-row.rank-2, .rank-row.rank-3 { margin: 0 -5px; padding: 0 5px; }
  .my-rank { flex-wrap: wrap; }
  .my-rank strong { width: 100%; margin-left: 0; }
}
</style>
