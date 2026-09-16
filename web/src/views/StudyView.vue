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
const directory = ref<StudyDirectoryKey | ''>('')
const scope = ref<'all' | 'public' | 'mine'>('all')
const createOpen = ref(false)
const saving = ref(false)
const form = reactive<{ title: string; directory_key: StudyDirectoryKey; description: string; visibility: StudyVisibility }>({
  title: '', directory_key: 'computer-basics', description: '', visibility: 'private'
})

const directoryCards = computed(() => STUDY_DIRECTORY.map(item => {
  const matched = books.value.filter(book => book.directory_key === item.key)
  return { ...item, bookCount: matched.length, cardCount: matched.reduce((sum, book) => sum + book.card_count, 0) }
}))
const shownBooks = computed(() => directory.value ? books.value.filter(book => book.directory_key === directory.value) : books.value)
const selectedDirectory = computed(() => STUDY_DIRECTORY.find(item => item.key === directory.value) ?? null)

async function load(): Promise<void> {
  loading.value = true
  try {
    const params = new URLSearchParams()
    if (directory.value) params.set('directory', directory.value)
    params.set('scope', scope.value)
    books.value = await api.get<StudyBook[]>(`/study/books?${params.toString()}`)
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    loading.value = false
  }
}
function selectDirectory(key: StudyDirectoryKey): void {
  directory.value = directory.value === key ? '' : key
}
function openCreate(): void {
  form.title = ''; form.directory_key = directory.value || 'computer-basics'; form.description = ''; form.visibility = 'private'
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

watch([directory, scope], load)
watch(() => route.query.create, value => {
  if (value !== '1') return
  openCreate()
  void router.replace({ query: {} })
}, { immediate: true })
onMounted(load)
</script>

<template>
  <section v-loading="loading" class="study-library">
    <header class="study-hero">
      <div>
        <p class="page-kicker">INTERVIEW KNOWLEDGE MAP</p>
        <h1>八股文</h1>
        <p>按知识体系整理资料，随时阅读、背诵和记录自己的理解。</p>
      </div>
      <el-button type="primary" @click="openCreate">＋ 新建八股册</el-button>
    </header>

    <section class="directory-grid" aria-label="八股目录">
      <button
        v-for="item in directoryCards"
        :key="item.key"
        class="directory-card"
        :class="{ active: directory === item.key }"
        type="button"
        @click="selectDirectory(item.key)"
      >
        <span class="directory-icon">{{ item.icon }}</span>
        <span class="directory-copy"><b>{{ item.shortTitle }}</b><small>{{ item.description }}</small></span>
        <span class="directory-count">{{ item.cardCount }} 题</span>
      </button>
    </section>

    <section class="books-section">
      <div class="books-heading">
        <div><h2>{{ selectedDirectory ? selectedDirectory.title : '全部八股册' }}</h2><p>{{ selectedDirectory ? selectedDirectory.description : '公共资料与我的私有资料会一起显示' }}</p></div>
        <el-radio-group v-model="scope" size="small">
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button value="public">公共</el-radio-button>
          <el-radio-button value="mine">我的</el-radio-button>
        </el-radio-group>
      </div>

      <el-empty v-if="!shownBooks.length && !loading" description="这里还没有八股册，先新建一本开始整理" :image-size="92">
        <el-button type="primary" @click="openCreate">新建八股册</el-button>
      </el-empty>
      <div v-else class="book-grid">
        <article v-for="book in shownBooks" :key="book.id" class="book-card" role="button" tabindex="0" @click="router.push(`/learn/study/${book.id}`)" @keydown.enter.prevent="router.push(`/learn/study/${book.id}`)">
          <div class="book-card-head"><span class="book-directory">{{ STUDY_DIRECTORY.find(item => item.key === book.directory_key)?.icon }}</span><el-tag :type="book.visibility === 'public' ? 'primary' : 'info'" effect="plain" size="small">{{ book.visibility === 'public' ? '公共' : '我的' }}</el-tag></div>
          <h3>{{ book.title }}</h3>
          <p>{{ book.description || '暂未填写简介' }}</p>
          <footer><span>{{ book.chapter_count }} 章 · {{ book.card_count }} 题</span><span>进入阅读 ›</span></footer>
        </article>
      </div>
    </section>
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
</template>

<style scoped>
.study-library { max-width: 1120px; }
.study-hero { display:flex; align-items:flex-end; justify-content:space-between; gap:20px; margin-bottom:22px; }.study-hero h1 { margin:5px 0 8px; font-size:28px; }.study-hero p:not(.page-kicker) { margin:0; color:var(--jt-text-muted); font-size:14px; }
.directory-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; }.directory-card { min-width:0; padding:14px; border:1px solid var(--jt-line); border-radius:13px; background:#fff; color:var(--jt-text); text-align:left; cursor:pointer; transition:.18s ease; }.directory-card:hover,.directory-card.active { border-color:#a9c6ff; background:#f6f9ff; box-shadow:0 4px 14px rgba(47,111,237,.08); }.directory-icon { display:grid; width:30px; height:30px; place-items:center; border-radius:9px; background:var(--jt-primary-soft); color:var(--jt-primary); font-size:17px; }.directory-copy { display:grid; gap:4px; margin-top:12px; }.directory-copy b { font-size:14px; }.directory-copy small { min-height:30px; color:#8590a0; font-size:11px; line-height:1.4; }.directory-count { display:block; margin-top:10px; color:#5c6f8e; font-size:12px; }
.books-section { margin-top:28px; }.books-heading { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:13px; }.books-heading h2 { margin:0; font-size:18px; }.books-heading p { margin:5px 0 0; color:#8994a4; font-size:12px; }.book-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }.book-card { display:flex; flex-direction:column; min-height:184px; padding:16px; border:1px solid var(--jt-line); border-radius:14px; background:#fff; cursor:pointer; transition:.18s ease; }.book-card:hover { transform:translateY(-2px); border-color:#b7cffd; box-shadow:0 8px 20px rgba(25,54,96,.08); }.book-card-head { display:flex; align-items:center; justify-content:space-between; }.book-directory { color:var(--jt-primary); font-size:20px; }.book-card h3 { margin:18px 0 7px; font-size:16px; }.book-card p { display:-webkit-box; overflow:hidden; margin:0; color:#778396; font-size:12px; line-height:1.55; -webkit-box-orient:vertical; -webkit-line-clamp:2; }.book-card footer { display:flex; justify-content:space-between; gap:8px; margin-top:auto; padding-top:14px; color:#8a95a5; font-size:11px; }.book-card footer span:last-child { color:var(--jt-primary); }
.create-tip { margin:0; color:#8b95a5; font-size:12px; line-height:1.55; }
@media (max-width:820px) { .study-hero { align-items:stretch; flex-direction:column; gap:12px; margin-bottom:16px; }.study-hero h1 { font-size:24px; }.study-hero :deep(.el-button) { width:100%; min-height:40px; }.directory-grid { grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }.directory-card { padding:12px; }.directory-copy { margin-top:9px; }.directory-copy small { min-height:45px; }.books-section { margin-top:22px; }.books-heading { align-items:flex-start; flex-direction:column; gap:10px; }.book-grid { grid-template-columns:1fr; gap:9px; }.book-card { min-height:148px; padding:14px; }.book-card:active { transform:scale(.993); }.book-card h3 { margin-top:12px; }.study-create-dialog :deep(.el-dialog__body) { max-height:calc(100dvh - 126px); overflow:auto; }.study-create-dialog :deep(.el-dialog__footer) { padding-bottom:calc(12px + env(safe-area-inset-bottom)); } }
@media (max-width:820px) { :global(.study-create-dialog) { width:100% !important; height:100dvh; max-height:100dvh; margin:0 !important; border-radius:0; } }
</style>
