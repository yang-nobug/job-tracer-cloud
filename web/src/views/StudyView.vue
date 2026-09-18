<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { authState } from '../auth'
import { STUDY_DIRECTORY, type StudyBook, type StudyDirectoryKey, type StudyVisibility } from '../types'

const route = useRoute()
const router = useRouter()
const loading = ref(false)
const books = ref<StudyBook[]>([])
/** 必须在一个知识目录内浏览与新建，避免“全部八股册”成为无意义的重复入口。 */
const directory = ref<StudyDirectoryKey>('computer-basics')
const scope = ref<'all' | 'public' | 'mine'>('all')
const createOpen = ref(false)
const saving = ref(false)
const importOpen = ref(false)
const importText = ref('')
const importPlanning = ref(false)
const importApplying = ref(false)
const importPlan = ref<{ job: { id: number }; items: Array<{ id: number; directory_key: string; book_title: string; path_json: string; document_title: string; action: string; reason: string }> } | null>(null)
const form = reactive<{ title: string; directory_key: StudyDirectoryKey; description: string; visibility: StudyVisibility }>({
  title: '', directory_key: 'computer-basics', description: '', visibility: 'private'
})

const directoryCards = computed(() => STUDY_DIRECTORY.map(item => {
  const matched = books.value.filter(book => book.directory_key === item.key)
  return { ...item, bookCount: matched.length, contentCount: matched.reduce((sum, book) => sum + book.card_count + book.document_count, 0) }
}))
const shownBooks = computed(() => books.value.filter(book => book.directory_key === directory.value))
const selectedDirectory = computed(() => STUDY_DIRECTORY.find(item => item.key === directory.value)!)

async function load(): Promise<void> {
  loading.value = true
  try {
    const params = new URLSearchParams()
    params.set('scope', scope.value)
    books.value = await api.get<StudyBook[]>(`/study/books?${params.toString()}`)
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    loading.value = false
  }
}
function selectDirectory(key: StudyDirectoryKey): void { directory.value = key }
function openCreate(): void {
  form.title = ''; form.directory_key = directory.value; form.description = ''; form.visibility = 'private'
  createOpen.value = true
}
async function createBook(): Promise<void> {
  if (!form.title.trim()) return ElMessage.warning('先给这套八股册起个名称')
  saving.value = true
  try {
    const book = await api.post<StudyBook>('/study/books', form)
    createOpen.value = false
    await router.push(`/learn/study/${book.id}`)
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    saving.value = false
  }
}
async function planImport(): Promise<void> {
  if (!importText.value.trim()) return ElMessage.warning('请先粘贴需要整理的资料')
  importPlanning.value = true
  try { importPlan.value = await api.post('/study/imports/plan', { text: importText.value, visibility: authState.user?.isAdmin ? 'public' : 'private' }) } catch (error) { ElMessage.error((error as Error).message) } finally { importPlanning.value = false }
}
async function applyImport(): Promise<void> {
  if (!importPlan.value) return
  importApplying.value = true
  try { const result = await api.post<{ created: number; needs_review_item_ids: number[] }>(`/study/imports/${importPlan.value.job.id}/apply`, {}); ElMessage.success(`已导入 ${result.created} 篇文章${result.needs_review_item_ids.length ? `，${result.needs_review_item_ids.length} 项待确认` : ''}`); importOpen.value = false; importPlan.value = null; importText.value = ''; await load() } catch (error) { ElMessage.error((error as Error).message) } finally { importApplying.value = false }
}

watch(scope, load)
watch(() => route.query.create, value => {
  if (value !== '1') return
  openCreate()
  void router.replace({ query: {} })
}, { immediate: true })
onMounted(load)
</script>

<template>
  <section v-loading="loading" class="study-library">
    <header class="study-topbar">
      <div><h1>八股文</h1><p>选择一套资料，直接开始阅读或背诵。</p></div>
      <div class="study-actions"><el-button plain @click="importOpen = true">智能录入</el-button><el-button type="primary" @click="openCreate">＋ 新建八股册</el-button></div>
    </header>

    <div class="study-shell">
      <aside class="study-directory" aria-label="八股目录">
        <p>知识目录</p>
        <button v-for="item in directoryCards" :key="item.key" type="button" :class="{ active: directory === item.key }" @click="selectDirectory(item.key)"><span>{{ item.icon }}</span><b>{{ item.title }}</b><small>{{ item.bookCount }} 册 · {{ item.contentCount }} 内容</small></button>
      </aside>

      <section class="books-section">
        <div class="books-heading">
          <div><h2>{{ selectedDirectory.title }}</h2><p>{{ selectedDirectory.description }}</p></div>
          <el-radio-group v-model="scope" size="small"><el-radio-button value="all">全部</el-radio-button><el-radio-button value="public">公共</el-radio-button><el-radio-button value="mine">我的</el-radio-button></el-radio-group>
        </div>

        <el-empty v-if="!shownBooks.length && !loading" description="这里还没有八股册，先新建一本开始整理" :image-size="76"><el-button type="primary" @click="openCreate">新建八股册</el-button></el-empty>
        <div v-else class="book-list">
          <article v-for="book in shownBooks" :key="book.id" class="book-row" role="button" tabindex="0" @click="router.push(`/learn/study/${book.id}`)" @keydown.enter.prevent="router.push(`/learn/study/${book.id}`)">
            <span class="book-directory">{{ STUDY_DIRECTORY.find(item => item.key === book.directory_key)?.icon }}</span>
            <span class="book-copy"><span><h3>{{ book.title }}</h3><el-tag :type="book.visibility === 'public' ? 'primary' : 'info'" effect="plain" size="small">{{ book.visibility === 'public' ? '公共' : '我的' }}</el-tag></span><p>{{ book.description || '暂未填写简介' }}</p></span>
            <span class="book-meta">{{ book.chapter_count }} 目录<br>{{ book.document_count }} 文章 · {{ book.card_count }} 题</span><span class="book-arrow">›</span>
          </article>
        </div>
      </section>
    </div>
  </section>

  <el-dialog v-model="createOpen" title="新建八股册" width="520px" class="study-create-dialog" append-to-body>
    <el-form label-position="top">
      <el-form-item label="名称" required><el-input v-model="form.title" maxlength="160" placeholder="例如：MySQL 与数据库" /></el-form-item>
      <el-form-item label="归属目录" required><el-select v-model="form.directory_key" style="width: 100%"><el-option v-for="item in STUDY_DIRECTORY" :key="item.key" :label="item.title" :value="item.key" /></el-select></el-form-item>
      <el-form-item label="简介"><el-input v-model="form.description" type="textarea" :rows="3" maxlength="2000" placeholder="这套资料适合什么方向、包含哪些主题？" /></el-form-item>
      <el-form-item v-if="authState.user?.isAdmin" label="可见范围"><el-radio-group v-model="form.visibility"><el-radio-button value="private">我的私有资料</el-radio-button><el-radio-button value="public">发布为公共资料</el-radio-button></el-radio-group></el-form-item>
      <p class="create-tip">公共资料由管理员维护；私有资料只属于你的工作区。熟悉度和笔记始终只属于你自己。</p>
    </el-form>
    <template #footer><el-button @click="createOpen = false">取消</el-button><el-button type="primary" :loading="saving" @click="createBook">创建并进入</el-button></template>
  </el-dialog>
  <el-dialog v-model="importOpen" title="智能录入八股资料" width="780px" class="study-create-dialog" append-to-body>
    <template v-if="!importPlan"><p class="create-tip">粘贴混合资料后，AI 会拆分为多个知识单元，分别识别大目录、八股册、目录路径和文章。可能覆盖已有文章的内容不会自动写入。</p><el-input v-model="importText" type="textarea" :rows="15" maxlength="20000" show-word-limit placeholder="粘贴文章、笔记或多门技术资料" /></template>
    <template v-else><p class="create-tip">以下是 AI 的导入计划。标为“待确认”的项目不会自动改动已有文章。</p><div class="import-plan"><article v-for="item in importPlan.items" :key="item.id"><b>{{ item.document_title }}</b><p>{{ STUDY_DIRECTORY.find(x => x.key === item.directory_key)?.title }} ＞ {{ item.book_title }} ＞ {{ JSON.parse(item.path_json).join(' ＞ ') || '根目录' }}</p><small :class="item.action">{{ item.action === 'create_document' ? '将新建文章' : '待确认合并' }}：{{ item.reason }}</small></article></div></template>
    <template #footer><el-button @click="importOpen=false">取消</el-button><el-button v-if="!importPlan" type="primary" :loading="importPlanning" @click="planImport">AI 拆分并生成计划</el-button><el-button v-else type="primary" :loading="importApplying" @click="applyImport">确认导入可新建内容</el-button></template>
  </el-dialog>
</template>

<style scoped>
.study-library { max-width:1120px; }.study-topbar { display:flex; align-items:center; justify-content:space-between; gap:16px; padding-bottom:16px; border-bottom:1px solid var(--jt-line); }.study-topbar h1 { margin:0; font-size:25px; }.study-topbar p { margin:5px 0 0; color:#7d8999; font-size:13px; }.study-shell { display:grid; grid-template-columns:200px minmax(0,1fr); gap:22px; margin-top:18px; }.study-directory { position:sticky; top:92px; padding:8px; border:1px solid var(--jt-line); border-radius:13px; background:#fff; }.study-directory p { margin:13px 7px 5px; color:#9aa4b2; font-size:11px; font-weight:700; }.study-directory button { display:grid; grid-template-columns:22px minmax(0,1fr) auto; width:100%; align-items:center; gap:6px; min-height:34px; padding:6px 7px; border:0; border-radius:7px; background:transparent; color:#687689; text-align:left; cursor:pointer; }.study-directory button:hover,.study-directory button.active { background:var(--jt-primary-soft); color:var(--jt-primary); }.study-directory button span { color:inherit; font-size:14px; }.study-directory button b { overflow:hidden; font-size:12px; text-overflow:ellipsis; white-space:nowrap; }.study-directory button small { color:#9ca7b6; font-size:11px; }.study-directory .directory-all { color:#53657d; font-weight:700; }.books-heading { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:13px; }.books-heading h2 { margin:0; font-size:18px; }.books-heading p { margin:5px 0 0; color:#8994a4; font-size:12px; }.book-list { display:flex; flex-direction:column; gap:8px; }.book-row { display:grid; grid-template-columns:38px minmax(0,1fr) 65px 16px; align-items:center; gap:12px; min-height:86px; padding:13px 14px; border:1px solid var(--jt-line); border-radius:12px; background:#fff; cursor:pointer; transition:.16s ease; }.book-row:hover { border-color:#b7cffd; box-shadow:0 5px 16px rgba(25,54,96,.07); }.book-directory { display:grid; width:34px; height:34px; place-items:center; border-radius:10px; background:var(--jt-primary-soft); color:var(--jt-primary); font-size:18px; }.book-copy { min-width:0; }.book-copy > span { display:flex; align-items:center; gap:7px; }.book-copy h3 { overflow:hidden; margin:0; color:#2c394c; font-size:15px; text-overflow:ellipsis; white-space:nowrap; }.book-copy p { overflow:hidden; margin:5px 0 0; color:#8590a0; font-size:12px; text-overflow:ellipsis; white-space:nowrap; }.book-meta { color:#8490a1; font-size:11px; line-height:1.55; text-align:right; }.book-arrow { color:#a7b0bc; font-size:25px; }
.create-tip { margin:0; color:#8b95a5; font-size:12px; line-height:1.55; }
.study-actions{display:flex;gap:8px}.import-plan{display:flex;max-height:52vh;flex-direction:column;gap:8px;overflow:auto}.import-plan article{padding:10px 12px;border:1px solid var(--jt-line);border-radius:9px}.import-plan p{margin:5px 0;color:#718096;font-size:12px}.import-plan small{color:#40865a}.import-plan small.needs_review{color:#b7791f}
@media (max-width:820px) { .study-topbar { align-items:stretch; flex-direction:column; padding-bottom:13px; }.study-topbar h1 { font-size:22px; }.study-topbar :deep(.el-button) { width:100%; min-height:40px; }.study-shell { display:block; margin-top:13px; }.study-directory { position:static; display:flex; gap:6px; margin:0 -12px 13px; padding:0 12px 7px; overflow-x:auto; border:0; border-radius:0; background:transparent; scrollbar-width:none; }.study-directory::-webkit-scrollbar { display:none; }.study-directory p { display:none; }.study-directory button,.study-directory .directory-all { display:flex; flex:0 0 auto; align-items:center; gap:5px; min-height:33px; padding:0 10px; border:1px solid #e2e7ee; border-radius:17px; background:#fff; }.study-directory button span { font-size:13px; }.study-directory button b { font-size:12px; }.study-directory button small { display:none; }.books-heading { align-items:flex-start; flex-direction:column; gap:10px; }.book-row { grid-template-columns:34px minmax(0,1fr) 48px 12px; gap:9px; min-height:76px; padding:11px; }.book-row:active { transform:scale(.993); }.book-directory { width:31px; height:31px; font-size:16px; }.book-copy > span { gap:5px; }.book-copy h3 { font-size:14px; }.book-copy p { font-size:11px; }.book-meta { font-size:10px; }.study-create-dialog :deep(.el-dialog__body) { max-height:calc(100dvh - 126px); overflow:auto; }.study-create-dialog :deep(.el-dialog__footer) { padding-bottom:calc(12px + env(safe-area-inset-bottom)); } }
@media (max-width:820px) { :global(.study-create-dialog) { width:100% !important; height:100dvh; max-height:100dvh; margin:0 !important; border-radius:0; } }
</style>
