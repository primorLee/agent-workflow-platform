<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { isHostedAuthEnabled } from '@/utils/hostedAuth'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'

const { t } = useI18n()
const router = useRouter()
const auth = useAuthStore()

onMounted(async () => {
  if (!isHostedAuthEnabled()) {
    await router.replace('/')
  }
})

const mode = ref<'login' | 'register'>('login')
const email = ref('')
const username = ref('')
const password = ref('')
const confirmPassword = ref('')
const loading = ref(false)
const error = ref('')
const successMsg = ref('')

async function handleSubmit() {
  if (!email.value || !password.value) return
  error.value = ''
  successMsg.value = ''

  if (mode.value === 'register') {
    if (!username.value.trim()) {
      error.value = t('login.usernameRequired')
      return
    }
    if (password.value.length < 8) {
      error.value = t('login.passwordMinLength')
      return
    }
    if (password.value !== confirmPassword.value) {
      error.value = t('login.passwordMismatch')
      return
    }
  }

  loading.value = true
  try {
    if (mode.value === 'login') {
      const ok = await auth.login(email.value, password.value)
      if (ok) {
        try {
          const { useChatStore } = await import('@/stores/chat')
          const chatStore = useChatStore()
          await chatStore.fetchHistory()
        } catch { /* non-fatal */ }
        router.push('/')
      } else {
        error.value = auth.error || t('login.loginFailed')
      }
    } else {
      const ok = await auth.register(email.value, password.value, username.value.trim())
      if (ok) {
        successMsg.value = t('login.registerSuccess')
        setTimeout(() => router.push('/'), 1500)
      } else {
        error.value = auth.error || t('login.registerFailed')
      }
    }
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    loading.value = false
  }
}

function switchMode() {
  mode.value = mode.value === 'login' ? 'register' : 'login'
  error.value = ''
  successMsg.value = ''
}

</script>

<template>
  <div class="login-page">
    <div class="login-card card">
      <div class="login-logo">
        <span class="logo-icon">&#x25C8;</span>
        <span class="logo-text">Agent Workflow Platform</span>
      </div>

      <div class="mode-tabs">
        <button
          :class="['tab', mode === 'login' && 'active']"
          data-testid="login-tab-login"
          aria-label="Login tab"
          @click="mode = 'login'"
        >{{ $t('auth.login') }}</button>
        <button
          :class="['tab', mode === 'register' && 'active']"
          data-testid="login-tab-register"
          aria-label="Register tab"
          @click="mode = 'register'"
        >{{ $t('login.register') }}</button>
      </div>

      <form @submit.prevent="handleSubmit">
        <label class="field-label">{{ $t('login.email') }}</label>
        <input v-model="email" class="input mb-4" type="email" autocomplete="email" placeholder="email@example.com" />

        <label class="field-label">{{ $t('auth.password') }}</label>
        <input v-model="password" type="password" class="input mb-4" autocomplete="current-password" :placeholder="$t('login.passwordPlaceholder')" />

        <template v-if="mode === 'register'">
          <label class="field-label">{{ $t('auth.username') }}</label>
          <input v-model="username" class="input mb-4" type="text" autocomplete="username" :placeholder="$t('login.displayName')" />


          <label class="field-label">{{ $t('login.confirmPassword') }}</label>
          <input v-model="confirmPassword" type="password" class="input mb-4" autocomplete="new-password" :placeholder="$t('login.confirmPasswordPlaceholder')" />

        </template>

        <p v-if="error" class="error-msg mb-4">{{ error }}</p>
        <p v-if="successMsg" class="success-msg mb-4">{{ successMsg }}</p>

        <button class="btn btn-primary w-full" type="submit" :disabled="loading">
          <LoadingSpinner v-if="loading" size="sm" />
          {{ mode === 'login' ? $t('auth.login') : $t('login.register') }}
        </button>
      </form>

      <p class="switch-hint">
        {{ mode === 'login' ? $t('login.noAccount') : $t('login.hasAccount') }}
        <a href="#" @click.prevent="switchMode">{{ mode === 'login' ? $t('login.registerNow') : $t('login.goLogin') }}</a>
      </p>
    </div>

  </div>
</template>

<style scoped>
.login-page {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-primary);
}
.login-card {
  width: 380px;
  max-width: 90%;
}
.login-logo {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-bottom: 20px;
}
.login-logo .logo-icon { font-size: 28px; color: var(--accent); }
.login-logo .logo-text { font-size: 22px; font-weight: 700; }
.mode-tabs {
  display: flex;
  gap: 0;
  margin-bottom: 20px;
  border-bottom: 2px solid var(--border);
}
.tab {
  flex: 1;
  padding: 8px 0;
  text-align: center;
  background: none;
  border: none;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -2px;
  transition: all 0.2s;
}
.tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}
.field-label {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 4px;
  display: block;
}
.error-msg {
  font-size: 13px;
  color: var(--danger);
  background: rgba(239, 68, 68, 0.1);
  padding: 8px;
  border-radius: var(--radius-sm);
  text-align: center;
}
.success-msg {
  font-size: 13px;
  color: var(--success, #22c55e);
  background: rgba(34, 197, 94, 0.1);
  padding: 8px;
  border-radius: var(--radius-sm);
  text-align: center;
}
.switch-hint {
  text-align: center;
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 16px;
}
.switch-hint a {
  color: var(--accent);
  text-decoration: none;
  font-weight: 500;
}
</style>
