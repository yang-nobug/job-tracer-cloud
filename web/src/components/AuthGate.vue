<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { login, submitRegistration } from '../auth'

const mode = ref<'login' | 'register'>('login')
const loading = ref(false)
const loginForm = ref({ email: '', password: '' })
const registerForm = ref({ displayName: '', email: '', password: '', confirmPassword: '' })

async function submitLogin(): Promise<void> {
  loading.value = true
  try {
    await login(loginForm.value)
    ElMessage.success('登录成功')
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    loading.value = false
  }
}

async function submitRegister(): Promise<void> {
  if (registerForm.value.password !== registerForm.value.confirmPassword) {
    ElMessage.warning('两次输入的密码不一致')
    return
  }
  loading.value = true
  try {
    const message = await submitRegistration(registerForm.value)
    ElMessage.success(message)
    loginForm.value.email = registerForm.value.email
    loginForm.value.password = ''
    mode.value = 'login'
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <main class="auth-page">
    <section class="auth-card">
      <div class="auth-brand"><span>JT</span><div><b>job tracer</b><small>求职工作台</small></div></div>
      <h1>{{ mode === 'login' ? '登录工作台' : '申请使用工作台' }}</h1>
      <p class="auth-hint">{{ mode === 'login' ? '使用管理员批准后的账号登录。' : '提交后需等待管理员审核，通过后可使用原密码登录。' }}</p>

      <el-form v-if="mode === 'login'" label-position="top" @submit.prevent="submitLogin">
        <el-form-item label="邮箱"><el-input v-model.trim="loginForm.email" autocomplete="email" /></el-form-item>
        <el-form-item label="密码"><el-input v-model="loginForm.password" type="password" show-password autocomplete="current-password" @keyup.enter="submitLogin" /></el-form-item>
        <el-button type="primary" native-type="submit" class="auth-submit" :loading="loading">登录</el-button>
      </el-form>

      <el-form v-else label-position="top" @submit.prevent="submitRegister">
        <el-form-item label="昵称"><el-input v-model.trim="registerForm.displayName" maxlength="80" /></el-form-item>
        <el-form-item label="邮箱"><el-input v-model.trim="registerForm.email" autocomplete="email" /></el-form-item>
        <el-form-item label="密码（至少 12 位）"><el-input v-model="registerForm.password" type="password" show-password autocomplete="new-password" /></el-form-item>
        <el-form-item label="确认密码"><el-input v-model="registerForm.confirmPassword" type="password" show-password autocomplete="new-password" @keyup.enter="submitRegister" /></el-form-item>
        <el-button type="primary" native-type="submit" class="auth-submit" :loading="loading">提交注册申请</el-button>
      </el-form>

      <button class="auth-switch" type="button" :disabled="loading" @click="mode = mode === 'login' ? 'register' : 'login'">
        {{ mode === 'login' ? '还没有账号？申请注册' : '已有已批准账号？去登录' }}
      </button>
    </section>
  </main>
</template>

<style scoped>
.auth-page { min-height: 100vh; display: grid; place-items: center; padding: 28px 16px; background: radial-gradient(circle at 12% 10%, #e9f1ff, transparent 38%), #f5f7fb; }
.auth-card { width: min(100%, 420px); padding: 34px; border: 1px solid #e3e9f2; border-radius: 20px; background: rgba(255,255,255,.96); box-shadow: 0 20px 55px rgba(26, 54, 97, .12); }
.auth-brand { display: flex; align-items: center; gap: 10px; color: #182230; }
.auth-brand > span { display: grid; width: 36px; height: 36px; place-items: center; border-radius: 10px; background: linear-gradient(135deg,#2f6fed,#5b8df5); color: white; font-size: 12px; font-weight: 800; }
.auth-brand div { display: grid; line-height: 1.1; }.auth-brand small { margin-top: 4px; color: #8994a6; font-size: 11px; }
h1 { margin: 28px 0 8px; font-size: 24px; }.auth-hint { margin: 0 0 24px; color: #738093; font-size: 13px; line-height: 1.65; }
.auth-submit { width: 100%; height: 40px; font-weight: 650; }.auth-switch { display: block; width: 100%; margin-top: 18px; border: 0; background: transparent; color: #2f6fed; font: inherit; font-size: 13px; cursor: pointer; }
.auth-switch:disabled { cursor: wait; color: #9aabca; }
</style>
