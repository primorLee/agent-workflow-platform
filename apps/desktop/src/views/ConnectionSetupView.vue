<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { isDevMode } from '@/utils/devMode'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { api } from '@/api/client'
import { useSettingsStore } from '@/stores/settings'
import type { HealthStatus } from '@/api/types'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'

const { t } = useI18n()
const router = useRouter()
const settings = useSettingsStore()

// DEV mode: skip setup entirely
onMounted(() => {
  if (isDevMode) {
    router.replace('/')
    return
  }
})

const serverUrl = ref(settings.serverUrl)
const status = ref<'idle' | 'checking' | 'success' | 'error'>('idle')
const statusMessage = ref('')

async function testConnection() {
  status.value = 'checking'
  statusMessage.value = ''
  try {
    api.setBaseUrl(serverUrl.value)
    const health = await api.get<HealthStatus>('/api/health')
    if (health.status === 'ok' || health.status === 'degraded') {
      status.value = 'success'
      statusMessage.value = t('connection.connected')
    } else {
      status.value = 'error'
      statusMessage.value = t('connection.serverReturnedStatus', { status: health.status })
    }
  } catch (err) {
    status.value = 'error'
    statusMessage.value = (err as Error).message
  }
}

function proceed() {
  if (!settings.setServerUrl(serverUrl.value)) {
    status.value = 'error'
    statusMessage.value = 'invalid_service_base'
    return
  }
  api.setBaseUrl(settings.serverUrl)
  router.push('/')
}

/** 服务器地址输入框 Enter 提交；中文输入法组词确认的 Enter 不算。
 *  （keyup.enter 在 compositionend 之后触发、isComposing 恒 false，挡不住 IME，故改 keydown。） */
function onServerUrlEnter(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) return
  void testConnection()
}
</script>

<template>
  <div class="setup-page">
    <div class="setup-card card">
      <div class="setup-logo">
        <span class="logo-icon">&#x25C8;</span>
        <span class="logo-text">Agent Workflow Platform</span>
      </div>
      <p class="text-secondary text-center mb-4">{{ t('app.tagline') }}</p>

      <label class="field-label">{{ t('connection.serverUrl') }}</label>
      <input
        v-model="serverUrl"
        class="input mb-2"
        placeholder="http://127.0.0.1:8787"
        @keydown.enter="onServerUrlEnter"
      />

      <button class="btn w-full mb-4" @click="testConnection" :disabled="status === 'checking'">
        <LoadingSpinner v-if="status === 'checking'" size="sm" />
        {{ t('connection.testConnection') }}
      </button>

      <p v-if="statusMessage" class="status-msg" :class="status">{{ statusMessage }}</p>

      <button
        class="btn btn-primary w-full mt-4"
        :disabled="status !== 'success'"
        @click="proceed"
      >
        {{ t('common.continue') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.setup-page {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-primary);
}
.setup-card {
  width: 380px;
  max-width: 90%;
}
.setup-logo {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-bottom: 8px;
}
.setup-logo .logo-icon {
  font-size: 28px;
  color: var(--accent);
}
.setup-logo .logo-text {
  font-size: 22px;
  font-weight: 700;
}
.field-label {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 4px;
  display: block;
}
.status-msg {
  font-size: 13px;
  text-align: center;
  padding: 8px;
  border-radius: var(--radius-sm);
}
.status-msg.success { color: var(--success); background: rgba(34, 197, 94, 0.1); }
.status-msg.error { color: var(--danger); background: rgba(239, 68, 68, 0.1); }
</style>
