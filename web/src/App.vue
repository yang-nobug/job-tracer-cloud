<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useRoute, useRouter } from 'vue-router'
import { api } from './api'
import { store, openCreateForm, openKnowledgeIngest, toggleTutor } from './store'
import type { UpcomingItem } from './types'
import CountdownBar from './components/CountdownBar.vue'
import AppFormDrawer from './components/AppFormDrawer.vue'
import DetailDrawer from './components/DetailDrawer.vue'
import SourceIngestDialog from './components/SourceIngestDialog.vue'
import TutorPanel from './components/TutorPanel.vue'
import AiPrivacyDialog from './components/AiPrivacyDialog.vue'
import MailSettingsDialog from './components/MailSettingsDialog.vue'
import ObservabilityDialog from './components/ObservabilityDialog.vue'
import ProjectArchiveDialog from './components/ProjectArchiveDialog.vue'
import ResumeLibraryDialog from './components/ResumeLibraryDialog.vue'
import AuthGate from './components/AuthGate.vue'
import AccountDialog from './components/AccountDialog.vue'
import { authState, initializeAuth, logout } from './auth'

const route = useRoute()
const router = useRouter()
const upcoming = ref<UpcomingItem[]>([])
const privacyOpen = ref(false)
const mailSettingsOpen = ref(false)
const observabilityOpen = ref(false)
const projectArchiveOpen = ref(false)
const accountOpen = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

// 双工作区（需求 3.10）：投递跟踪 / 学习成长
const workspace = computed<'track' | 'learn'>(() => (route.path.startsWith('/learn') ? 'learn' : 'track'))

function onWorkspaceChange(ws: string | number | boolean): void {
  const target = ws === 'learn' ? 'learn' : 'track'
  localStorage.setItem('workspace', target)
  router.push(target === 'learn' ? '/learn/reviews' : '/track/kanban')
}

function onMoreCommand(command: string | number | object): void {
  if (command === 'project') projectArchiveOpen.value = true
  else if (command === 'observability') observabilityOpen.value = true
  else if (command === 'privacy') privacyOpen.value = true
}

function onAccountCommand(command: string | number | object): void {
  if (command === 'account') accountOpen.value = true
  else if (command === 'logout') void signOut()
}

async function signOut(): Promise<void> {
  try {
    await logout()
    router.replace('/')
    ElMessage.success('已退出登录')
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

function openUpcoming(item: UpcomingItem): void {
  if (!item.application_id) {
    // 没有关联投递的独立邮件日程无法跳到公司详情，改为打开日程管理页。
    mailSettingsOpen.value = true
    return
  }
  store.detailId = item.application_id
  if (!route.path.startsWith('/track')) void router.push('/track/kanban')
}

async function loadUpcoming(): Promise<void> {
  try {
    upcoming.value = await api.get<UpcomingItem[]>('/upcoming')
  } catch {
    /* 静默失败，倒计时条非关键路径 */
  }
}

onMounted(() => {
  void initializeAuth().catch(error => ElMessage.error((error as Error).message))
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
watch(() => store.dataVersion, () => { void loadUpcoming() })
// 登录恢复存在两个独立状态更新：先写入 user，再结束 loading。只监听 user
// 在页面恢复会话时可能错过触发，从而顶部日程从未请求。等待两个状态都稳定后再启动。
watch(
  () => [authState.loading, authState.user?.userId] as const,
  ([loading, userId]) => {
  if (loading) return
  if (!userId) {
    upcoming.value = []
    if (timer) clearInterval(timer)
    timer = null
    return
  }
  void loadUpcoming()
  if (!timer) timer = setInterval(loadUpcoming, 60_000)
  },
  { immediate: true }
)
</script>

<template>
  <div v-if="authState.loading" class="auth-loading">正在检查登录状态…</div>
  <AuthGate v-else-if="!authState.user" />
  <div v-else class="app-shell" :class="{ 'learn-shell': workspace === 'learn' }">
    <header class="header">
      <div class="header-inner">
        <button class="brand" type="button" aria-label="返回求职看板" @click="router.push('/track/kanban')">
          <span class="brand-mark" aria-hidden="true">JT</span>
          <span class="brand-copy"><b>job tracer</b><small>求职工作台</small></span>
        </button>
        <div class="workspace-switch" role="tablist" aria-label="工作区">
          <button
            class="ws-pill"
            :class="{ active: workspace === 'track' }"
            role="tab"
            :aria-selected="workspace === 'track'"
            @click="onWorkspaceChange('track')"
          >
            投递
          </button>
          <button
            class="ws-pill"
            :class="{ active: workspace === 'learn' }"
            role="tab"
            :aria-selected="workspace === 'learn'"
            @click="onWorkspaceChange('learn')"
          >
            学习
          </button>
        </div>
        <nav class="nav-main">
          <template v-if="workspace === 'track'">
            <router-link to="/track/kanban" class="nav-link" :class="{ active: route.path === '/track/kanban' }">看板</router-link>
            <router-link to="/track/list" class="nav-link" :class="{ active: route.path === '/track/list' }">列表</router-link>
            <router-link to="/track/stats" class="nav-link" :class="{ active: route.path === '/track/stats' }">统计</router-link>
            <router-link to="/track/shared-jobs" class="nav-link" :class="{ active: route.path === '/track/shared-jobs' }">共享岗位</router-link>
          </template>
          <template v-else>
            <router-link to="/learn/reviews" class="nav-link" :class="{ active: route.path === '/learn/reviews' }">复盘</router-link>
            <router-link to="/learn/knowledge" class="nav-link" :class="{ active: route.path.startsWith('/learn/knowledge') }">学习</router-link>
          </template>
        </nav>
        <div class="header-actions">
          <el-dropdown trigger="click" @command="onAccountCommand">
            <el-button class="utility-button account-button" text>{{ authState.user.displayName }} <span class="more-caret">⌄</span></el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="account">账号与访问管理</el-dropdown-item>
                <el-dropdown-item divided command="logout">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-button class="utility-button" text @click="store.resumeLibraryOpen = true">简历</el-button>
          <el-button class="utility-button" text @click="mailSettingsOpen = true">日程</el-button>
          <el-dropdown trigger="click" @command="onMoreCommand">
            <el-button class="utility-button" text>更多 <span class="more-caret">⌄</span></el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="project">项目档案</el-dropdown-item>
                <el-dropdown-item v-if="authState.user.isAdmin" command="observability">运行与日志</el-dropdown-item>
                <el-dropdown-item v-if="authState.user.isAdmin" command="privacy">AI 数据说明</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-button v-if="workspace === 'track'" class="primary-action" type="primary" @click="openCreateForm()">新增投递</el-button>
          <el-button v-else class="primary-action" type="primary" @click="openKnowledgeIngest">录入面经</el-button>
        </div>
      </div>
      <CountdownBar v-if="workspace === 'track'" :items="upcoming" @select="openUpcoming" />
    </header>

    <main class="main" :class="{ 'main-learn': workspace === 'learn' }">
      <div class="main-content">
        <router-view v-if="workspace === 'track' || route.path.startsWith('/learn/knowledge') || route.path.startsWith('/learn/reviews') || authState.user.isAdmin" />
        <section v-else class="module-migration-note">
          <p class="page-kicker">WORKSPACE MIGRATION</p>
          <h2>学习与 AI 工具正在迁移</h2>
          <p>投递看板、面试安排和准备清单已进入你的私人工作区；简历、邮件、知识库与 AI 工具将在后续迁移完成后开放。</p>
          <el-button type="primary" @click="router.push('/track/kanban')">返回投递看板</el-button>
        </section>
      </div>
      <!-- 学习区右侧常驻 AI 助教栏：随路由切换不销毁，切到投递区隐藏但保留对话 -->
      <TutorPanel v-show="workspace === 'learn'" />
    </main>

    <!-- 手机端只服务学习主流程：复盘、题库和 AI 助教。投递管理仍沿用桌面页面。 -->
    <nav v-if="workspace === 'learn'" class="mobile-learn-nav" aria-label="学习区导航">
      <button type="button" :class="{ active: route.path === '/learn/reviews' }" @click="router.push('/learn/reviews')"><span>◷</span>复盘</button>
      <button type="button" :class="{ active: route.path.startsWith('/learn/knowledge') }" @click="router.push('/learn/knowledge')"><span>▤</span>题库</button>
      <button type="button" :class="{ active: store.tutorOpen }" @click="toggleTutor(true)"><span>✦</span>助教</button>
    </nav>

    <AppFormDrawer v-model="store.formDrawerOpen" :editing="store.editingApp" />
    <DetailDrawer :app-id="store.detailId" @close="store.detailId = null" />
    <SourceIngestDialog />
    <AiPrivacyDialog v-model="privacyOpen" />
    <MailSettingsDialog v-model="mailSettingsOpen" />
    <ObservabilityDialog v-model="observabilityOpen" />
    <ProjectArchiveDialog v-model="projectArchiveOpen" />
    <ResumeLibraryDialog v-model="store.resumeLibraryOpen" />
    <AccountDialog v-model="accountOpen" />
  </div>
</template>

<style>
:root {
  --jt-bg: #f5f7fb;
  --jt-surface: #ffffff;
  --jt-surface-muted: #f8fafc;
  --jt-text: #182230;
  --jt-text-muted: #6c7788;
  --jt-line: #e5eaf1;
  --jt-primary: #2f6fed;
  --jt-primary-soft: #edf3ff;
  --jt-shadow: 0 10px 30px rgba(21, 42, 76, 0.07);
  --jt-radius: 12px;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
  background: var(--jt-bg);
  color: var(--jt-text);
  -webkit-font-smoothing: antialiased;
}
.app-shell { min-height: 100vh; }
.mobile-learn-nav { display: none; }
.auth-loading { min-height: 100vh; display: grid; place-items: center; color: #728095; background: var(--jt-bg); font-size: 14px; }

.header {
  position: sticky; top: 0; z-index: 100;
  padding: 12px 20px 0;
  background: linear-gradient(to bottom, rgba(245, 247, 251, .98), rgba(245, 247, 251, .82));
  backdrop-filter: blur(12px);
}
.header-inner {
  max-width: 1440px; min-height: 64px; margin: 0 auto; padding: 8px 10px 8px 14px;
  display: flex; align-items: center; gap: 16px;
  border: 1px solid rgba(225, 231, 240, .9); border-radius: 15px;
  background: rgba(255, 255, 255, .94); box-shadow: var(--jt-shadow);
}
.brand {
  display: inline-flex; align-items: center; gap: 9px; flex-shrink: 0;
  padding: 0; border: 0; background: transparent; color: var(--jt-text); cursor: pointer;
}
.brand-mark {
  display: grid; width: 32px; height: 32px; place-items: center; border-radius: 9px;
  background: linear-gradient(135deg, #2f6fed, #5b8df5); color: #fff;
  font-size: 11px; font-weight: 800; letter-spacing: -.4px;
}
.brand-copy { display: grid; text-align: left; line-height: 1.15; }
.brand-copy b { font-size: 16px; letter-spacing: -.25px; }
.brand-copy small { margin-top: 3px; color: #8a94a6; font-size: 11px; font-weight: 500; }
.workspace-switch {
  display: flex; gap: 2px; padding: 3px; flex-shrink: 0;
  border: 1px solid var(--jt-line); background: var(--jt-surface-muted); border-radius: 9px;
}
.ws-pill {
  padding: 6px 15px; border: 0; border-radius: 6px;
  background: transparent; color: #8490a1; font: inherit; font-size: 13px; font-weight: 650;
  cursor: pointer; user-select: none; white-space: nowrap;
  transition: color 0.2s, background 0.2s, box-shadow 0.2s;
}
.ws-pill:hover { color: var(--jt-text); }
.ws-pill.active {
  background: #fff; color: var(--jt-primary); box-shadow: 0 1px 3px rgba(21, 42, 76, .10);
}
.nav-main { display: flex; gap: 2px; flex: 1; }
.nav-link {
  text-decoration: none; color: var(--jt-text-muted); padding: 7px 11px; border-radius: 7px; font-size: 13px; font-weight: 550;
}
.nav-link:hover { color: var(--jt-text); background: var(--jt-surface-muted); }
.nav-link.active { color: var(--jt-primary); background: var(--jt-primary-soft); font-weight: 700; }
.header-actions { margin-left: auto; display: flex; align-items: center; gap: 2px; }
.header-actions .el-button + .el-button { margin-left: 0; }
.utility-button { color: var(--jt-text-muted); font-weight: 550; }
.utility-button:hover { color: var(--jt-primary); background: var(--jt-primary-soft); }
.account-button { max-width: 130px; overflow: hidden; text-overflow: ellipsis; }
.more-caret { margin-left: 2px; font-size: 14px; }
.primary-action { min-width: 96px; margin-left: 6px; border-radius: 8px; font-weight: 650; box-shadow: 0 5px 12px rgba(47, 111, 237, .18); }

.main { max-width: 1440px; margin: 0 auto; padding: 22px 20px 30px; }
/* 学习区：内容 + 右侧助教栏分栏 */
.main-learn { display: flex; gap: 20px; align-items: flex-start; }
.main-content { flex: 1; min-width: 0; }
.module-migration-note { max-width: 620px; margin: 60px auto; padding: 38px; text-align: center; border: 1px solid var(--jt-line); border-radius: 16px; background: var(--jt-surface); box-shadow: var(--jt-shadow); }
.module-migration-note h2 { margin: 8px 0 12px; font-size: 22px; }
.module-migration-note p:not(.page-kicker) { margin: 0 0 22px; color: var(--jt-text-muted); line-height: 1.75; }

/* Element Plus 基础表面统一，具体业务组件可保留自己的局部布局。 */
.el-card { border-color: var(--jt-line); border-radius: var(--jt-radius); box-shadow: none; }
.el-button--primary { --el-button-bg-color: var(--jt-primary); --el-button-border-color: var(--jt-primary); --el-button-hover-bg-color: #4d82ee; --el-button-hover-border-color: #4d82ee; }
.el-dialog { border-radius: 16px; overflow: hidden; }

@media (max-width: 1100px) {
  .header-inner { gap: 10px; }
  .brand-copy small { display: none; }
  .nav-link { padding-inline: 8px; }
  .utility-button { padding-inline: 7px; }
}
@media (max-width: 820px) {
  .header { padding: 8px 10px 0; }
  .header-inner { flex-wrap: wrap; padding: 8px 9px; border-radius: 12px; }
  .nav-main { order: 3; width: 100%; overflow-x: auto; padding-top: 2px; }
  .header-actions { margin-left: auto; }
  .utility-button { font-size: 12px; }
  .primary-action { min-width: auto; margin-left: 2px; }
  .main { padding: 16px 12px 24px; }
  .main-learn { display: block; }
  .learn-shell { padding-bottom: calc(70px + env(safe-area-inset-bottom)); }
  .learn-shell .header-actions .utility-button,
  .learn-shell .account-button { display: none; }
  .learn-shell .primary-action { min-width: 42px; padding-inline: 10px; font-size: 0; }
  .learn-shell .primary-action::before { content: '＋'; font-size: 22px; line-height: 1; }
  .mobile-learn-nav {
    position: fixed; z-index: 120; right: 0; bottom: 0; left: 0;
    display: grid; grid-template-columns: repeat(3, 1fr); min-height: 64px;
    padding: 5px max(12px, env(safe-area-inset-right)) calc(5px + env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left));
    border-top: 1px solid var(--jt-line); background: rgba(255, 255, 255, .97);
    box-shadow: 0 -6px 20px rgba(21, 42, 76, .07); backdrop-filter: blur(14px);
  }
  .mobile-learn-nav button { display: grid; min-height: 52px; place-content: center; gap: 2px; border: 0; background: transparent; color: #7d899a; font: inherit; font-size: 11px; }
  .mobile-learn-nav button span { height: 20px; color: inherit; font-size: 18px; font-weight: 700; line-height: 18px; }
  .mobile-learn-nav button.active { color: var(--jt-primary); font-weight: 750; }
}
@media (max-width: 560px) {
  .brand-copy { display: none; }
  .header-actions .utility-button:first-child { display: none; }
  .workspace-switch { margin-right: auto; }
  .ws-pill { padding-inline: 11px; }
  .primary-action { padding-inline: 11px; }
}


</style>
