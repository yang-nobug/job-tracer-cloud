<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import type { Interview } from '../types'
import RichText from './RichText.vue'

const props = defineProps<{ interview: Interview }>()
const emit = defineEmits<(e: 'closed') => void>()

const content = ref('')
const editMode = ref(false)
const draft = ref('')
const loading = ref(true)
const saving = ref(false)

const title = computed(() => '📝 面试复盘')

onMounted(async () => {
  try {
    const r = await api.get<{ content: string }>(`/interviews/${props.interview.id}/review`)
    content.value = r.content
    draft.value = r.content
  } catch (err) {
    ElMessage.error((err as Error).message)
  } finally {
    loading.value = false
  }
})

function startEdit(): void {
  draft.value = content.value
  editMode.value = true
}

async function save(): Promise<void> {
  saving.value = true
  try {
    await api.put(`/interviews/${props.interview.id}/review`, { content: draft.value })
    content.value = draft.value
    editMode.value = false
    ElMessage.success('已保存')
  } catch (err) {
    ElMessage.error((err as Error).message)
  } finally {
    saving.value = false
  }
}

async function reloadFromCloud(): Promise<void> {
  try {
    const r = await api.get<{ content: string }>(`/interviews/${props.interview.id}/review`)
    content.value = r.content
    draft.value = r.content
    ElMessage.success('已从云端刷新')
  } catch (err) {
    ElMessage.error((err as Error).message)
  }
}

// AI 点评（火山方舟，需在 config.json 配置）
const adviceOpen = ref(false)
const advice = ref('')
const advising = ref(false)

async function askAdvice(): Promise<void> {
  advising.value = true
  advice.value = ''
  adviceOpen.value = true
  try {
    const r = await api.post<{ advice: string }>('/ai/review-advice', {
      interviewId: props.interview.id
    })
    advice.value = r.advice
  } catch (err) {
    ElMessage.error((err as Error).message)
    adviceOpen.value = false
  } finally {
    advising.value = false
  }
}

const visible = ref(true)
function onClose(): void {
  visible.value = false
  emit('closed')
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    :title="title"
    width="760px"
    top="6vh"
    class="review-editor-dialog"
    destroy-on-close
    @update:model-value="onClose"
  >
    <div v-loading="loading" class="review-editor">
      <template v-if="!editMode">
        <RichText class="preview" :content="content" />
      </template>
      <template v-else>
        <div class="edit-grid">
          <el-input v-model="draft" type="textarea" :rows="20" class="edit-area" />
          <RichText class="preview" :content="draft" />
        </div>
      </template>
    </div>
    <template #footer>
      <div class="footer-bar">
        <span class="hint">复盘内容保存在你的云端工作区中</span>
        <div>
          <el-button v-if="!editMode" size="small" type="warning" plain :loading="advising" @click="askAdvice">
            ✨ AI 点评
          </el-button>
          <el-button v-if="!editMode" size="small" @click="reloadFromCloud">↻ 从云端刷新</el-button>
          <el-button v-if="editMode" @click="editMode = false">取消编辑</el-button>
          <el-button v-if="!editMode" type="primary" @click="startEdit">编辑</el-button>
          <el-button v-else type="primary" :loading="saving" @click="save">保存</el-button>
        </div>
      </div>
    </template>

    <el-dialog v-model="adviceOpen" title="✨ AI 点评" width="680px" append-to-body top="6vh" class="review-advice-dialog">
      <RichText v-loading="advising" class="advice-body" :content="advising ? '' : advice" />
    </el-dialog>
  </el-dialog>
</template>

<style scoped>
.edit-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.edit-area :deep(textarea) { height: 100%; font-family: Consolas, monospace; }
.preview { max-height: 62vh; overflow: auto; border: 1px solid #ebeef5; border-radius: 6px; padding: 14px; }
.footer-bar { display: flex; justify-content: space-between; align-items: center; width: 100%; gap: 10px; }
.hint { font-size: 12px; color: #909399; }
.advice-body { min-height: 200px; max-height: 70vh; overflow: auto; }
@media (max-width: 820px) {
  :global(.review-editor-dialog), :global(.review-advice-dialog) { width: 100% !important; height: 100dvh; max-height: 100dvh; margin: 0 !important; border-radius: 0; }
  :global(.review-editor-dialog .el-dialog__header), :global(.review-advice-dialog .el-dialog__header) { margin-right: 0; padding: 17px 48px 14px 16px; border-bottom: 1px solid #ebeef5; }
  :global(.review-editor-dialog .el-dialog__body), :global(.review-advice-dialog .el-dialog__body) { max-height: calc(100dvh - 126px); padding: 14px 12px; overflow-y: auto; }
  :global(.review-editor-dialog .el-dialog__footer) { padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); border-top: 1px solid #ebeef5; }
  .edit-grid { grid-template-columns: 1fr; }.edit-area :deep(textarea) { min-height: 42dvh; }.preview { max-height: none; padding: 12px; }
  .footer-bar { align-items: stretch; flex-direction: column; }.hint { line-height: 1.45; }.footer-bar > div { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }.footer-bar :deep(.el-button) { min-height: 38px; margin-left: 0; }
  .advice-body { min-height: 0; max-height: none; }
}
</style>
