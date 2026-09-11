<script setup lang="ts">
import { computed } from 'vue'
import type { Application } from '../types'
import { STATUS_LABELS } from '../types'

const props = defineProps<{ app: Application }>()

const isRejected = computed(() => !!props.app.rejected_at)

const tagType = computed(() => {
  if (isRejected.value) return 'info'
  const map: Record<string, string> = {
    unsent: 'info',
    applied: '',
    assessment: 'info',
    testing: 'primary',
    ai: 'primary',
    round1: 'warning',
    round2: 'warning',
    round3: 'warning',
    hr: 'warning',
    interviewing: 'warning',
    offer: 'success'
  }
  return map[props.app.status] ?? ''
})

const label = computed(() => {
  if (!isRejected.value) return STATUS_LABELS[props.app.status]
  return props.app.reject_type === 'me' ? '已挂（我拒）' : '已挂'
})
</script>

<template>
  <el-tag :type="tagType" size="small" disable-transitions>{{ label }}</el-tag>
</template>
