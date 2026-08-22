<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore, type Language, type Theme } from '@/stores/settings'
import { api } from '@/api/client'
import CcRuntimeSection from '@/views/settings/CcRuntimeSection.vue'
import AppUpdateSection from '@/views/settings/AppUpdateSection.vue'

declare const __APP_VERSION__: string

interface SettingsBridge {
  run_startup_diagnostic?: () => Promise<{
    ok: boolean
    failures: string[]
    warnings: string[]
    error?: string
  }>
}

const { locale } = useI18n()
const settings = useSettingsStore()
const saving = ref(false)
const saved = ref(false)
const connectionState = ref<'idle' | 'checking' | 'ok' | 'error'>('idle')
const connectionMessage = ref('')
const diagnosticBusy = ref(false)
const diagnosticMessage = ref('')

const ui = computed(() => settings.language === 'zh-CN' ? {
  title: '设置', appearance: '外观与语言', light: '浅色', dark: '深色', language: '语言',
  connection: '聊天适配器', url: '聊天服务地址', demo: '用于聊天与 SSE 事件。默认本地演示适配器：8787；任务控制平面由主进程单独配置。',
  test: '测试连接', testing: '连接中…', save: '保存设置', saved: '已保存',
  remote: '远程工作区', host: '主机', port: 'SSH 端口', user: 'SSH 用户', password: 'SSH 密码',
  runtime: '本地 Agent CLI', diagnostics: '诊断', runDiagnostic: '运行启动诊断',
  about: '关于', version: '版本', demoOk: '连接成功', demoFail: '连接失败',
} : {
  title: 'Settings', appearance: 'Appearance and language', light: 'Light', dark: 'Dark', language: 'Language',
  connection: 'Chat adapter', url: 'Chat service URL', demo: 'Used for chat and SSE events. The local demo adapter defaults to 8787; task control-plane settings are separate.',
  test: 'Test connection', testing: 'Connecting…', save: 'Save settings', saved: 'Saved',
  remote: 'Remote workspace', host: 'Host', port: 'SSH port', user: 'SSH user', password: 'SSH password',
  runtime: 'Local Agent CLI', diagnostics: 'Diagnostics', runDiagnostic: 'Run startup diagnostics',
  about: 'About', version: 'Version', demoOk: 'Connected', demoFail: 'Connection failed',
})

function desktopBridge(): SettingsBridge | null {
  if (typeof window === 'undefined') return null
  return (window as unknown as { electronAPI?: SettingsBridge }).electronAPI ?? null
}

async function testConnection(): Promise<void> {
  connectionState.value = 'checking'
  connectionMessage.value = ''
  try {
    api.setBaseUrl(settings.serverUrl)
    const health = await api.get<{ status: string; version?: string }>('/api/health')
    connectionState.value = 'ok'
    connectionMessage.value = `${ui.value.demoOk}${health.version ? ` · ${health.version}` : ''}`
  } catch (error) {
    connectionState.value = 'error'
    connectionMessage.value = `${ui.value.demoFail}: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function save(): Promise<void> {
  saving.value = true
  try {
    api.setBaseUrl(settings.serverUrl)
    await settings.saveSettings()
    locale.value = settings.language
    saved.value = true
    window.setTimeout(() => { saved.value = false }, 1600)
  } catch (error) {
    saved.value = false
    connectionState.value = 'error'
    connectionMessage.value = `${ui.value.demoFail}: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    saving.value = false
  }
}

async function runDiagnostics(): Promise<void> {
  const bridge = desktopBridge()
  if (!bridge?.run_startup_diagnostic) {
    diagnosticMessage.value = 'Desktop diagnostics are not available in this runtime.'
    return
  }
  diagnosticBusy.value = true
  try {
    const result = await bridge.run_startup_diagnostic()
    const details = [...result.failures, ...result.warnings]
    diagnosticMessage.value = result.ok && details.length === 0
      ? (settings.language === 'zh-CN' ? '所有检查均通过。' : 'All checks passed.')
      : details.join('\n') || result.error || 'Diagnostics completed with warnings.'
  } catch (error) {
    diagnosticMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    diagnosticBusy.value = false
  }
}

function setTheme(theme: Theme): void { settings.setTheme(theme) }
function setLanguage(language: Language): void {
  settings.setLanguage(language)
  locale.value = language
}

onMounted(async () => {
  await settings.loadSettings()
  api.setBaseUrl(settings.serverUrl)
  locale.value = settings.language
})
</script>

<template>
  <main class="settings-page">
    <header class="page-header">
      <div>
        <h1>{{ ui.title }}</h1>
        <p>Agent Workflow Platform</p>
      </div>
      <button class="primary" :disabled="saving" @click="save">
        {{ saved ? ui.saved : ui.save }}
      </button>
    </header>

    <section class="card">
      <h2>{{ ui.appearance }}</h2>
      <div class="row split">
        <div>
          <label>{{ ui.language }}</label>
          <select :value="settings.language" @change="setLanguage(($event.target as HTMLSelectElement).value as Language)">
            <option value="zh-CN">简体中文</option>
            <option value="en">English</option>
          </select>
        </div>
        <div>
          <label>Theme</label>
          <div class="segmented">
            <button :class="{ active: settings.theme === 'light' }" @click="setTheme('light')">{{ ui.light }}</button>
            <button :class="{ active: settings.theme === 'dark' }" @click="setTheme('dark')">{{ ui.dark }}</button>
          </div>
        </div>
      </div>
    </section>

    <section class="card">
      <h2>{{ ui.connection }}</h2>
      <label for="chat-adapter-url">{{ ui.url }}</label>
      <div class="inline">
        <input id="chat-adapter-url" v-model="settings.serverUrl" spellcheck="false" placeholder="http://127.0.0.1:8787" />
        <button :disabled="connectionState === 'checking'" @click="testConnection">
          {{ connectionState === 'checking' ? ui.testing : ui.test }}
        </button>
      </div>
      <p class="hint">{{ ui.demo }}</p>
      <p v-if="connectionMessage" class="status" :class="connectionState">{{ connectionMessage }}</p>
    </section>

    <section class="card">
      <h2>{{ ui.remote }}</h2>
      <div class="grid">
        <label>{{ ui.host }}<input v-model="settings.vmHost" placeholder="127.0.0.1" /></label>
        <label>{{ ui.port }}<input v-model.number="settings.sshPort" type="number" min="1" max="65535" /></label>
        <label>{{ ui.user }}<input v-model="settings.sshUser" autocomplete="username" placeholder="agent" /></label>
        <label>{{ ui.password }}<input v-model="settings.sshPassword" type="password" autocomplete="current-password" /></label>
      </div>
    </section>

    <section class="card">
      <h2>{{ ui.runtime }}</h2>
      <CcRuntimeSection />
    </section>

    <section class="card">
      <h2>{{ ui.diagnostics }}</h2>
      <button :disabled="diagnosticBusy" @click="runDiagnostics">{{ ui.runDiagnostic }}</button>
      <p v-if="diagnosticMessage" class="hint preline">{{ diagnosticMessage }}</p>
    </section>

    <section class="card"><AppUpdateSection /></section>

    <section class="card about">
      <h2>{{ ui.about }}</h2>
      <p>Agent Workflow Platform · {{ ui.version }} {{ __APP_VERSION__ }}</p>
    </section>
  </main>
</template>

<style scoped>
.settings-page { max-width: 920px; margin: 0 auto; padding: 32px 24px 56px; color: var(--text-primary); }
.page-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
h1 { margin: 0; font-size: 28px; } h2 { margin: 0 0 18px; font-size: 17px; }
.page-header p, .about p { color: var(--text-muted); margin: 5px 0 0; }
.card { padding: 22px; margin-bottom: 16px; border: 1px solid var(--border); border-radius: 14px; background: var(--bg-surface); }
.row, .inline { display: flex; gap: 12px; align-items: center; } .split > div { flex: 1; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
label { display: flex; flex-direction: column; gap: 7px; color: var(--text-secondary); font-size: 12px; }
input, select { width: 100%; box-sizing: border-box; padding: 9px 11px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-primary); color: var(--text-primary); }
.inline input { flex: 1; }
button { padding: 8px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-primary); color: var(--text-primary); cursor: pointer; }
button:hover:not(:disabled), .segmented button.active { border-color: var(--primary); background: var(--primary-soft); }
button:disabled { opacity: .55; cursor: default; } .primary { background: var(--primary); border-color: var(--primary); color: white; }
.segmented { display: flex; gap: 6px; } .segmented button { flex: 1; }
.hint, .status { margin: 9px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.status.ok { color: var(--success); } .status.error { color: var(--danger); } .preline { white-space: pre-line; }
@media (max-width: 680px) { .grid, .row.split { display: grid; grid-template-columns: 1fr; } .inline { align-items: stretch; } .settings-page { padding: 20px 14px 40px; } }
</style>