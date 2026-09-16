<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { MASTERY_LABELS, STUDY_DIRECTORY, type Mastery, type StudyBookDetail, type StudyCard, type StudyChapter, type StudyDifficulty } from '../types'
import RichText from '../components/RichText.vue'

const route = useRoute(); const router = useRouter()
const detail = ref<StudyBookDetail | null>(null); const loading = ref(true); const selectedChapterId = ref<number | null>(null)
const reciting = ref(false); const reciteIndex = ref(0); const revealed = ref(false); const chapterOpen = ref(false)
const chapterDialog = ref(false); const cardDialog = ref(false); const saving = ref(false); const editingCardId = ref<number | null>(null)
const chapterTitle = ref('')
const cardForm = reactive<{ chapter_id: number | null; question: string; summary: string; answer: string; followups: string; tags: string; difficulty: StudyDifficulty }>({ chapter_id: null, question: '', summary: '', answer: '', followups: '', tags: '', difficulty: '基础' })

const selectedChapter = computed(() => detail.value?.chapters.find(chapter => chapter.id === selectedChapterId.value) ?? detail.value?.chapters[0] ?? null)
const allCards = computed(() => detail.value?.chapters.flatMap(chapter => chapter.cards) ?? [])
const reciteCard = computed(() => allCards.value[reciteIndex.value] ?? null)
const familiarityLabels: Array<{ value: Mastery; label: string }> = [{ value: 0, label: '不熟' }, { value: 1, label: '一般' }, { value: 2, label: '熟悉' }]
const directoryItem = computed(() => detail.value ? STUDY_DIRECTORY.find(item => item.key === detail.value!.book.directory_key) : null)

async function load(): Promise<void> {
  loading.value = true
  try {
    const next = await api.get<StudyBookDetail>(`/study/books/${route.params.id}`)
    detail.value = next
    if (!selectedChapterId.value || !next.chapters.some(chapter => chapter.id === selectedChapterId.value)) selectedChapterId.value = next.chapters[0]?.id ?? null
    if (reciteIndex.value >= next.chapters.flatMap(chapter => chapter.cards).length) reciteIndex.value = 0
  } catch (error) {
    ElMessage.error((error as Error).message)
    void router.replace('/learn/study')
  } finally { loading.value = false }
}
function beginRecite(): void { if (!allCards.value.length) return ElMessage.warning('先添加题目，才能开始背诵'); reciteIndex.value = 0; revealed.value = false; reciting.value = true }
function nextRecite(step: number): void { if (!allCards.value.length) return; reciteIndex.value = (reciteIndex.value + step + allCards.value.length) % allCards.value.length; revealed.value = false }
async function saveProgress(card: StudyCard, familiarity = card.familiarity, keepNote = true): Promise<void> {
  try {
    const result = await api.put<{ familiarity: Mastery; note: string }>(`/study/cards/${card.id}/progress`, { familiarity, ...(keepNote ? { note: card.note } : {}) })
    card.familiarity = result.familiarity; card.note = result.note
  } catch (error) { ElMessage.error((error as Error).message) }
}
function openChapterDialog(): void { chapterTitle.value = ''; chapterDialog.value = true }
async function createChapter(): Promise<void> {
  if (!chapterTitle.value.trim() || !detail.value) return ElMessage.warning('请填写章节名称')
  saving.value = true
  try { const chapter = await api.post<StudyChapter>(`/study/books/${detail.value.book.id}/chapters`, { title: chapterTitle.value }); detail.value.chapters.push({ ...chapter, cards: [] }); selectedChapterId.value = chapter.id; chapterDialog.value = false } catch (error) { ElMessage.error((error as Error).message) } finally { saving.value = false }
}
function openCardDialog(card?: StudyCard): void {
  if (!detail.value?.chapters.length) return ElMessage.warning('请先新增一个章节')
  editingCardId.value = card?.id ?? null
  cardForm.chapter_id = card?.chapter_id ?? selectedChapterId.value ?? detail.value.chapters[0].id
  cardForm.question = card?.question ?? ''; cardForm.summary = card?.summary ?? ''; cardForm.answer = card?.answer ?? ''
  cardForm.followups = card?.followups.join('\n') ?? ''; cardForm.tags = card?.tags.join(', ') ?? ''; cardForm.difficulty = card?.difficulty ?? '基础'; cardDialog.value = true
}
function payload(): Record<string, unknown> { return { chapter_id: cardForm.chapter_id, question: cardForm.question, summary: cardForm.summary, answer: cardForm.answer, followups: cardForm.followups, tags: cardForm.tags, difficulty: cardForm.difficulty } }
async function saveCard(): Promise<void> {
  if (!cardForm.question.trim() || !cardForm.chapter_id || !detail.value) return ElMessage.warning('请填写题目')
  saving.value = true
  try {
    if (editingCardId.value) {
      const updated = await api.put<StudyCard>(`/study/cards/${editingCardId.value}`, payload())
      let previousCard: StudyCard | null = null
      for (const chapter of detail.value.chapters) { const index = chapter.cards.findIndex(card => card.id === updated.id); if (index >= 0) previousCard = chapter.cards.splice(index, 1)[0] }
      detail.value.chapters.find(chapter => chapter.id === updated.chapter_id)?.cards.push({ ...(previousCard ?? {}), ...updated } as StudyCard)
    } else {
      const card = await api.post<StudyCard>(`/study/chapters/${cardForm.chapter_id}/cards`, payload())
      detail.value.chapters.find(chapter => chapter.id === cardForm.chapter_id)?.cards.push(card)
    }
    cardDialog.value = false
  } catch (error) { ElMessage.error((error as Error).message) } finally { saving.value = false }
}
async function removeCard(card: StudyCard): Promise<void> {
  try { await ElMessageBox.confirm(`删除「${card.question}」？`, '删除题目', { type: 'warning' }); await api.delete(`/study/cards/${card.id}`); const chapter = detail.value?.chapters.find(item => item.id === card.chapter_id); if (chapter) chapter.cards = chapter.cards.filter(item => item.id !== card.id); ElMessage.success('已删除') } catch { /* 取消 */ }
}
watch(() => route.params.id, load)
onMounted(load)
</script>

<template>
  <section v-loading="loading" class="study-reader">
    <template v-if="detail">
      <header class="reader-hero">
        <div><el-button text class="back-button" @click="router.push('/learn/study')">‹ 八股文</el-button><p class="page-kicker">{{ directoryItem?.title }}</p><h1>{{ detail.book.title }}</h1><p>{{ detail.book.description || '按章节阅读、背诵和整理自己的理解。' }}</p></div>
        <div class="reader-actions"><el-tag :type="detail.book.visibility === 'public' ? 'primary' : 'info'" effect="plain">{{ detail.book.visibility === 'public' ? '公共八股册' : '我的八股册' }}</el-tag><el-button type="primary" :disabled="!allCards.length" @click="beginRecite">背诵模式</el-button></div>
      </header>

      <div class="reader-mobile-chapter"><el-select v-model="selectedChapterId" placeholder="选择章节" style="width:100%"><el-option v-for="chapter in detail.chapters" :key="chapter.id" :value="chapter.id" :label="`${chapter.title} · ${chapter.cards.length} 题`" /></el-select></div>
      <div class="reader-layout">
        <aside class="reader-directory">
          <div class="directory-title"><b>目录</b><el-button v-if="detail.book.can_edit" link type="primary" @click="openChapterDialog">＋ 章节</el-button></div>
          <button v-for="(chapter,index) in detail.chapters" :key="chapter.id" type="button" :class="{ active: selectedChapterId === chapter.id }" @click="selectedChapterId = chapter.id"><span>{{ String(index + 1).padStart(2, '0') }}</span><b>{{ chapter.title }}</b><small>{{ chapter.cards.length }}</small></button>
          <el-empty v-if="!detail.chapters.length" description="还没有章节" :image-size="56" />
        </aside>

        <main class="reader-content">
          <template v-if="selectedChapter">
            <div class="chapter-heading"><div><p class="page-kicker">CHAPTER {{ String(detail.chapters.indexOf(selectedChapter) + 1).padStart(2, '0') }}</p><h2>{{ selectedChapter.title }}</h2><span>{{ selectedChapter.cards.length }} 道题目</span></div><el-button v-if="detail.book.can_edit" plain @click="openCardDialog()">＋ 添加题目</el-button></div>
            <el-empty v-if="!selectedChapter.cards.length" description="这一章还没有题目" :image-size="78"><el-button v-if="detail.book.can_edit" type="primary" @click="openCardDialog()">添加第一道题</el-button></el-empty>
            <article v-for="(card,index) in selectedChapter.cards" :key="card.id" class="study-card">
              <div class="card-top"><span>问题 {{ index + 1 }}</span><div><el-tag size="small" effect="plain">{{ card.difficulty }}</el-tag><el-tag v-for="tag in card.tags" :key="tag" size="small" effect="plain" class="card-tag">{{ tag }}</el-tag></div></div>
              <h3>{{ card.question }}</h3><p v-if="card.summary" class="card-summary">{{ card.summary }}</p>
              <div class="card-answer"><RichText v-if="card.answer" :content="card.answer" /><span v-else>暂未填写详细答案</span></div>
              <div v-if="card.followups.length" class="followups"><b>常见追问</b><ul><li v-for="followup in card.followups" :key="followup">{{ followup }}</li></ul></div>
              <div class="card-bottom"><div class="familiarity"><span>掌握情况</span><button v-for="option in familiarityLabels" :key="option.value" type="button" :class="['familiarity-'+option.value,{ active: card.familiarity === option.value }]" @click="saveProgress(card, option.value)">{{ option.label }}</button></div><div v-if="detail.book.can_edit" class="edit-actions"><el-button link size="small" @click="openCardDialog(card)">编辑</el-button><el-button link type="danger" size="small" @click="removeCard(card)">删除</el-button></div></div>
              <el-input v-model="card.note" type="textarea" :rows="2" maxlength="10000" resize="none" class="note-input" placeholder="我的笔记：记录自己的理解、易错点或表达方式" @blur="saveProgress(card)" />
            </article>
          </template>
          <el-empty v-else description="从左侧目录选择章节，或先创建一个章节" :image-size="96"><el-button v-if="detail.book.can_edit" type="primary" @click="openChapterDialog">创建章节</el-button></el-empty>
        </main>
      </div>
    </template>
  </section>

  <el-dialog v-model="chapterDialog" title="新增章节" width="460px" class="study-editor-dialog" append-to-body><el-input v-model="chapterTitle" maxlength="160" placeholder="例如：索引与 SQL 优化" @keyup.enter="createChapter" /><template #footer><el-button @click="chapterDialog = false">取消</el-button><el-button type="primary" :loading="saving" @click="createChapter">创建章节</el-button></template></el-dialog>
  <el-dialog v-model="cardDialog" :title="editingCardId ? '编辑题目' : '添加题目'" width="760px" class="study-editor-dialog" append-to-body>
    <el-form label-position="top"><el-form-item label="章节" required><el-select v-model="cardForm.chapter_id" style="width:100%"><el-option v-for="chapter in detail?.chapters" :key="chapter.id" :value="chapter.id" :label="chapter.title" /></el-select></el-form-item><el-form-item label="问题" required><el-input v-model="cardForm.question" type="textarea" :rows="2" maxlength="2000" placeholder="例如：MySQL 为什么使用 B+ 树索引？" /></el-form-item><el-form-item label="一句话答案"><el-input v-model="cardForm.summary" type="textarea" :rows="2" maxlength="4000" placeholder="用于快速回忆的核心结论" /></el-form-item><el-form-item label="详细答案（支持 Markdown）"><el-input v-model="cardForm.answer" type="textarea" :rows="9" maxlength="20000" placeholder="写入原理、关键点、示例与边界条件" /></el-form-item><div class="card-form-grid"><el-form-item label="常见追问（一行一个）"><el-input v-model="cardForm.followups" type="textarea" :rows="3" /></el-form-item><el-form-item label="标签（逗号或换行分隔）"><el-input v-model="cardForm.tags" type="textarea" :rows="3" /></el-form-item></div><el-form-item label="难度"><el-radio-group v-model="cardForm.difficulty"><el-radio-button value="基础">基础</el-radio-button><el-radio-button value="进阶">进阶</el-radio-button><el-radio-button value="深入">深入</el-radio-button></el-radio-group></el-form-item></el-form>
    <template #footer><el-button @click="cardDialog = false">取消</el-button><el-button type="primary" :loading="saving" @click="saveCard">保存题目</el-button></template>
  </el-dialog>

  <el-dialog v-model="reciting" width="680px" class="study-recite-dialog" append-to-body>
    <template #header><div class="recite-header"><span>背诵模式</span><small>{{ reciteIndex + 1 }} / {{ allCards.length }}</small></div></template>
    <template v-if="reciteCard"><p class="recite-chapter">{{ detail?.chapters.find(chapter => chapter.id === reciteCard.chapter_id)?.title }}</p><h2>{{ reciteCard.question }}</h2><p v-if="reciteCard.summary" class="recite-hint">提示：{{ reciteCard.summary }}</p><el-button v-if="!revealed" type="primary" plain class="reveal-button" @click="revealed = true">我想好了，显示答案</el-button><div v-else class="recite-answer"><RichText :content="reciteCard.answer || '暂未填写详细答案'" /></div><div v-if="revealed" class="recite-score"><span>这题掌握得怎么样？</span><el-button v-for="option in familiarityLabels" :key="option.value" :type="option.value === 2 ? 'success' : option.value === 1 ? 'warning' : 'danger'" plain @click="saveProgress(reciteCard, option.value)">{{ option.label }}</el-button></div><footer class="recite-footer"><el-button @click="nextRecite(-1)">‹ 上一题</el-button><el-button type="primary" @click="nextRecite(1)">下一题 ›</el-button></footer></template>
  </el-dialog>
</template>

<style scoped>
.study-reader { max-width:1200px; }.reader-hero { display:flex; align-items:flex-end; justify-content:space-between; gap:20px; margin-bottom:20px; }.back-button { padding-left:0; color:#718097; }.reader-hero h1 { margin:5px 0 7px; font-size:28px; }.reader-hero p:not(.page-kicker) { margin:0; color:#788497; font-size:14px; }.reader-actions { display:flex; align-items:center; gap:9px; }.reader-layout { display:grid; grid-template-columns:230px minmax(0,1fr); gap:18px; align-items:start; }.reader-directory { position:sticky; top:92px; padding:10px; border:1px solid var(--jt-line); border-radius:13px; background:#fff; }.directory-title { display:flex; align-items:center; justify-content:space-between; padding:4px 5px 10px; color:#526074; font-size:13px; }.reader-directory button { display:grid; grid-template-columns:24px 1fr auto; width:100%; align-items:center; gap:6px; padding:9px 6px; border:0; border-radius:8px; background:transparent; color:#6b7788; text-align:left; cursor:pointer; }.reader-directory button span { color:#a2acba; font-size:10px; }.reader-directory button b { overflow:hidden; font-size:13px; text-overflow:ellipsis; white-space:nowrap; }.reader-directory button small { color:#9aa4b2; font-size:11px; }.reader-directory button.active { background:var(--jt-primary-soft); color:var(--jt-primary); }.reader-content { min-width:0; }.chapter-heading { display:flex; align-items:flex-end; justify-content:space-between; gap:12px; padding:4px 2px 15px; }.chapter-heading h2 { margin:4px 0; font-size:22px; }.chapter-heading span { color:#8b96a6; font-size:12px; }.study-card { margin-bottom:12px; padding:17px; border:1px solid var(--jt-line); border-radius:14px; background:#fff; }.card-top { display:flex; justify-content:space-between; gap:10px; color:#8b97a7; font-size:11px; }.card-top > div { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:4px; }.card-tag { margin-left:0; }.study-card h3 { margin:11px 0 7px; color:#253247; font-size:17px; line-height:1.55; }.card-summary { margin:0; padding:9px 11px; border-left:3px solid #93b8ff; border-radius:0 8px 8px 0; background:#f6f9ff; color:#4d668b; font-size:13px; line-height:1.6; }.card-answer { margin-top:12px; padding-top:12px; border-top:1px dashed #e4eaf2; color:#7e899a; font-size:13px; }.followups { margin-top:13px; padding:10px 12px; border-radius:9px; background:#fafbfc; color:#5d6c80; font-size:13px; }.followups b { font-size:12px; }.followups ul { margin:7px 0 0; padding-left:18px; line-height:1.7; }.card-bottom { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:14px; }.familiarity { display:flex; align-items:center; gap:6px; }.familiarity > span { color:#8893a2; font-size:12px; }.familiarity button { min-height:27px; padding:0 8px; border:1px solid #e0e6ee; border-radius:14px; background:#fff; color:#8390a1; font:inherit; font-size:11px; cursor:pointer; }.familiarity-0.active { border-color:#f2baba !important; background:#fff2f2 !important; color:#d65e5e !important; }.familiarity-1.active { border-color:#f1d5a5 !important; background:#fff8e9 !important; color:#bf7a16 !important; }.familiarity-2.active { border-color:#b9dfc6 !important; background:#f0faf2 !important; color:#3a9255 !important; }.edit-actions :deep(.el-button) { padding:3px 5px; }.note-input { margin-top:13px; }.note-input :deep(textarea) { background:#fbfcfe; font-size:12px; line-height:1.55; }.reader-mobile-chapter { display:none; }.card-form-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }.recite-header { display:flex; justify-content:space-between; align-items:center; }.recite-header small { color:#8c97a6; }.recite-chapter { color:var(--jt-primary); font-size:12px; }.study-recite-dialog h2 { margin:12px 0 14px; color:#253247; font-size:21px; line-height:1.6; }.recite-hint { margin:0; color:#788699; line-height:1.6; }.reveal-button { width:100%; min-height:46px; margin-top:24px; }.recite-answer { max-height:48vh; margin-top:18px; padding:14px; overflow:auto; border:1px solid #e7ebf0; border-radius:10px; background:#fbfcfe; }.recite-score { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-top:16px; }.recite-score span { margin-right:auto; color:#7c899b; font-size:13px; }.recite-footer { display:flex; justify-content:space-between; margin-top:20px; }.study-editor-dialog :deep(.el-form-item) { margin-bottom:14px; }
@media (max-width:820px) { .reader-hero { align-items:stretch; flex-direction:column; gap:11px; margin-bottom:13px; }.reader-hero h1 { font-size:23px; }.reader-actions { justify-content:space-between; }.reader-actions :deep(.el-button) { min-height:38px; }.reader-mobile-chapter { display:block; margin-bottom:10px; }.reader-layout { display:block; }.reader-directory { display:none; }.chapter-heading { align-items:flex-start; padding-bottom:11px; }.chapter-heading h2 { font-size:19px; }.chapter-heading :deep(.el-button) { min-height:36px; }.study-card { padding:13px; border-radius:12px; }.study-card h3 { margin-top:10px; font-size:16px; }.card-top { align-items:flex-start; }.card-top > div { max-width:55%; }.card-bottom { align-items:flex-start; flex-direction:column; }.familiarity { flex-wrap:wrap; }.edit-actions { align-self:flex-end; }.note-input { margin-top:10px; }.card-form-grid { grid-template-columns:1fr; gap:0; }.study-editor-dialog :deep(.el-dialog__body), .study-recite-dialog :deep(.el-dialog__body) { max-height:calc(100dvh - 126px); overflow:auto; }.study-editor-dialog :deep(.el-dialog__footer) { padding-bottom:calc(12px + env(safe-area-inset-bottom)); }.study-recite-dialog h2 { font-size:20px; }.recite-answer { max-height:none; }.recite-score { align-items:stretch; flex-direction:column; }.recite-score span { margin-right:0; }.recite-score :deep(.el-button) { min-height:38px; margin-left:0; }.recite-footer { position:sticky; bottom:-16px; margin:18px -12px 0; padding:10px 12px calc(10px + env(safe-area-inset-bottom)); background:#fff; border-top:1px solid #e7ebf0; }.recite-footer :deep(.el-button) { min-height:40px; } }
@media (max-width:820px) { :global(.study-editor-dialog), :global(.study-recite-dialog) { width:100% !important; height:100dvh; max-height:100dvh; margin:0 !important; border-radius:0; } }
</style>
