<script setup lang="ts">
import { ref } from 'vue'
import { LockKeyhole } from 'lucide-vue-next'
import { useAccessAuth } from '../composables/useAccessAuth'

const emit = defineEmits<{ authenticated: [] }>()
const password = ref('')
const submitting = ref(false)
const { error, insecureTransport, login } = useAccessAuth()

async function submit(): Promise<void> {
  if (!password.value || submitting.value) return
  submitting.value = true
  try {
    if (await login(password.value)) {
      password.value = ''
      emit('authenticated')
    }
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <main class="access-login-page">
    <form class="access-login-card" @submit.prevent="submit">
      <div class="access-login-icon"><LockKeyhole :size="24" /></div>
      <h1>Nine1Bot WebUI</h1>
      <p>请输入访问密码后继续。</p>
      <div v-if="insecureTransport" class="access-http-warning">
        当前连接使用 HTTP。登录和访问可正常使用，但同一网络中的攻击者可能窃听密码和会话；公网访问建议配置 HTTPS。
      </div>
      <label for="nine1bot-access-password">访问密码</label>
      <input
        id="nine1bot-access-password"
        v-model="password"
        type="password"
        autocomplete="current-password"
        autofocus
        :disabled="submitting"
      />
      <div v-if="error" class="access-login-error" role="alert">{{ error }}</div>
      <button type="submit" :disabled="submitting || !password">
        {{ submitting ? '正在登录…' : '登录' }}
      </button>
    </form>
  </main>
</template>

<style scoped>
.access-login-page {
  flex: 1 1 100%;
  width: 100%;
  min-width: 0;
  min-height: 100vh;
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--bg-primary);
  color: var(--text-primary);
}

.access-login-card {
  width: min(420px, 100%);
  padding: 28px;
  border: 1px solid var(--border-default);
  border-radius: 14px;
  background: var(--bg-elevated);
  box-shadow: var(--shadow-lg);
}

.access-login-icon {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border-radius: 12px;
  background: var(--accent-subtle);
  color: var(--accent);
}

h1 { margin: 18px 0 6px; font-size: 22px; }
p { margin: 0 0 20px; color: var(--text-muted); }
label { display: block; margin-bottom: 7px; font-size: 13px; font-weight: 600; }
input {
  width: 100%;
  height: 42px;
  padding: 0 11px;
  border: 1px solid var(--border-default);
  border-radius: 9px;
  background: var(--bg-primary);
  color: var(--text-primary);
  outline: none;
}
input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-subtle); }
button {
  width: 100%;
  height: 42px;
  margin-top: 16px;
  border: 0;
  border-radius: 9px;
  background: var(--accent);
  color: var(--accent-fg);
  font-weight: 650;
  cursor: pointer;
}
button:disabled { cursor: not-allowed; opacity: 0.55; }
.access-http-warning,
.access-login-error {
  margin-bottom: 16px;
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.5;
}
.access-http-warning { background: var(--warning-subtle); color: var(--warning); }
.access-login-error { margin-top: 10px; margin-bottom: 0; background: var(--error-subtle); color: var(--error); }
</style>
