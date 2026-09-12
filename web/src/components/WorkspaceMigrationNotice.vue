<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { logout } from '../auth'

async function signOut(): Promise<void> {
  try {
    await logout()
    ElMessage.success('已退出登录')
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}
</script>

<template>
  <main class="notice-page">
    <section class="notice-card">
      <span class="notice-icon">✓</span>
      <h1>账号已获批准</h1>
      <p>你的个人工作区已创建。投递、日程和知识库正在从旧数据结构迁移到独立工作区，完成前暂不能进入业务页面。</p>
      <p class="notice-muted">这样可以确保不会看到其他人的历史求职资料。</p>
      <el-button @click="signOut">退出登录</el-button>
    </section>
  </main>
</template>

<style scoped>
.notice-page { min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #f5f7fb; }.notice-card { width: min(100%, 470px); padding: 42px; text-align: center; border: 1px solid #e3e9f2; border-radius: 18px; background: #fff; box-shadow: 0 16px 42px rgba(26,54,97,.08); }.notice-icon { display: grid; width: 42px; height: 42px; margin: 0 auto 18px; place-items: center; border-radius: 50%; background: #eaf8ef; color: #26a269; font-size: 23px; font-weight: 700; }.notice-card h1 { margin: 0; font-size: 22px; }.notice-card p { margin: 14px 0 0; color: #647286; line-height: 1.7; font-size: 14px; }.notice-card .notice-muted { margin-bottom: 24px; color: #8a96a6; font-size: 13px; }
</style>
