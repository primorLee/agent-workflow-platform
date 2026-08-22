<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useChatStore } from '@/stores/chat'
import { useActivityStore } from '@/stores/activity'
import { useSettingsStore } from '@/stores/settings'
import { useToastStore } from '@/stores/toast'
import { bridge, waitForBridge, isDesktop } from '@/bridge'
import { api } from '@/api/client'
import { isDevMode } from '@/utils/devMode'
import type { UploadedFileRef } from '@/api/endpoints/chat'
import ChatPanel from '@/components/chat/ChatPanel.vue'
import ModelSelector from '@/components/chat/ModelSelector.vue'
import ActivityTimeline from '@/components/chat/ActivityTimeline.vue'
import ArtifactListPanel from '@/components/chat/ArtifactListPanel.vue'

const { t } = useI18n()
const store = useChatStore()
const activityStore = useActivityStore()
const settings = useSettingsStore()
const toast = useToastStore()

const input = ref('')
const inputEl = ref<HTMLTextAreaElement | null>(null)
const fileInputEl = ref<HTMLInputElement | null>(null)
// 发送中 = isStreaming（从点击发送到流终结的全程 in-flight 标志），
// 不能用 streamingReply —— 它在思考期/CC 冷启动 30s+ 窗口为空，导致停止按钮缺位
// 且可重复发送（旧流被判 orphan 静默丢弃但照扣费）。
const sending = computed(() => store.isStreaming)
const showActivitySidebar = ref(false)
const isDark = computed(() => settings.theme === 'dark')
const inputFocused = ref(false)

// 冷启动期间禁止提交消息，直到运行时就绪；
// 进度横幅同时解释当前阶段。
//
const ccRuntimeReady = ref<boolean>(isDevMode)
const ccRuntimeStage = ref<'idle' | 'downloading' | 'verifying' | 'staging' | 'done' | 'error'>('idle')
const ccRuntimePercent = ref<number>(0)
let _ccRuntimeUnsub: (() => void) | null = null

onMounted(async () => {
  type Api = {
    cc_runtime_status?: () => Promise<{ currentVersion: string | null; available: boolean }>
    cc_runtime_progress?: () => Promise<{
      stage: 'idle' | 'downloading' | 'verifying' | 'staging' | 'done' | 'error'
      bytesDownloaded: number
      bytesTotal: number
    }>
    on_cc_runtime_progress?: (cb: (p: {
      stage: 'idle' | 'downloading' | 'verifying' | 'staging' | 'done' | 'error'
      bytesDownloaded: number
      bytesTotal: number
    }) => void) => () => void
    on_cc_runtime_installed?: (cb: (r: unknown) => void) => () => void
  }
  const api2 = (window as unknown as { electronAPI?: Api }).electronAPI
  if (!api2) {
    // Non-electron (browser / pywebview / test) — leave ready=true to keep
    // input live; the configured chat/SSE adapter handles routing.
    ccRuntimeReady.value = true
    return
  }
  if (typeof api2.cc_runtime_status === 'function') {
    try {
      const s = await api2.cc_runtime_status()
      ccRuntimeReady.value = isDevMode || s?.available === true
    } catch { ccRuntimeReady.value = false }
  }
  if (typeof api2.cc_runtime_progress === 'function') {
    try {
      const p = await api2.cc_runtime_progress()
      ccRuntimeStage.value = p.stage
      if (p.bytesTotal > 0) {
        ccRuntimePercent.value = Math.round((p.bytesDownloaded / p.bytesTotal) * 100)
      }
    } catch { /* noop */ }
  }
  if (typeof api2.on_cc_runtime_progress === 'function') {
    _ccRuntimeUnsub = api2.on_cc_runtime_progress((p) => {
      ccRuntimeStage.value = p.stage
      if (p.bytesTotal > 0) {
        ccRuntimePercent.value = Math.round((p.bytesDownloaded / p.bytesTotal) * 100)
      }
      if (p.stage === 'done') ccRuntimeReady.value = true
    })
  }
  if (typeof api2.on_cc_runtime_installed === 'function') {
    api2.on_cc_runtime_installed(() => { ccRuntimeReady.value = true })
  }
})

onUnmounted(() => { _ccRuntimeUnsub?.() })

const inputDisabled = computed(() => !ccRuntimeReady.value)
const inputPlaceholder = computed(() => {
  if (ccRuntimeReady.value) return t('chat.placeholder')
  switch (ccRuntimeStage.value) {
    case 'downloading': return `⏳ AI 引擎下载中 ${ccRuntimePercent.value}%, 完成后可发`
    case 'verifying':   return '⏳ 校验文件中, 即将就绪...'
    case 'staging':     return '⏳ 正在原子激活运行时，即将就绪…'
    case 'error':       return '❌ AI 引擎下载失败, 请去设置重试'
    default:            return '⏳ AI 引擎准备中...'
  }
})

const activeCount = computed(() =>
  activityStore.events.filter(e => e.status === 'running').length
)

// Wait for auth before fetching data (avoid "网络连接失败" toast on startup)
import { useAuthStore } from '@/stores/auth'
const auth = useAuthStore()
async function initChatData() {
  try { await Promise.all([store.fetchModels(), store.fetchHistory()]) } catch { /* offline */ }
  activityStore.connect()
}
onMounted(() => {
  focusInput()
  if (auth.isLoggedIn) {
    initChatData()
  } else {
    const stop = watch(() => auth.isLoggedIn, (loggedIn) => {
      if (loggedIn) { initChatData(); stop() }
    })
  }
})

// Do NOT stopStreaming here. Navigating away from the chat view
// (opening Settings — a separate /settings route — unmounts ChatView) must NOT
// kill the in-progress AI generation. The CC subprocess + stream state live in
// the store (global cc subscriptions wired at store-init + top-level refs), so
// they survive this unmount and re-render on re-mount. Generation is torn down
// only by explicit Stop / logout (onUserChanged) / app-quit. stopSimPoll +
// activityStore.disconnect are view-scoped resources that reconnect on mount.
onUnmounted(() => { activityStore.disconnect() })

function send() {
  const text = input.value.trim()
  if (!text || sending.value) return
  // Reject sends while the runtime is unavailable so the renderer does not
  // enter a session that cannot be serviced yet.
  if (inputDisabled.value) {
    toast.info(inputPlaceholder.value)
    return
  }
  input.value = ''
  store.sendMessage(text)
  autoResizeInput()
}
function handleQuickPrompt(prompt: string) {
  input.value = prompt
  send()
}
function onKeydown(e: KeyboardEvent) {
  // P0-1 (2026-06-10): 中文输入法组词期间按 Enter 是"确认候选词"，不是发送。
  // isComposing 是标准信号；keyCode 229 兜底部分 IME/WebView 在 compositionend
  // 前后发出的合成按键。两者任一命中都不触发 send。
  if (e.isComposing || e.keyCode === 229) return
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
}
function focusInput() { nextTick(() => inputEl.value?.focus()) }
function autoResizeInput() {
  nextTick(() => { if (!inputEl.value) return; inputEl.value.style.height = 'auto'; inputEl.value.style.height = Math.min(inputEl.value.scrollHeight, 120) + 'px' })
}
function toggleTheme() { settings.setTheme(isDark.value ? 'light' : 'dark') }

function openAttach() {
  if (uploading.value) return
  fileInputEl.value?.click()
}

// File-upload UI state. `uploading` gates the paperclip button (and blocks
// double-picks while the request is in-flight); errors surface via toast +
// alert so the user knows the file never reached the sandbox.
const uploading = ref(false)
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024  // 2026-04-23: 25→50MB for real paper PDFs

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Upload the picked file to the sandbox via `POST /v1/chat/upload` and stage
 * its metadata in `chatStore.pendingAttachments`. Replaces the legacy
 * `FileReader.readAsText` → "paste into prompt" path, which was broken for
 * binaries and blew up context window on anything above a few KB.
 *
 * The request is multipart/form-data; `api.postForm` intentionally omits
 * Content-Type so the browser fills in the boundary.
 */
async function onFileSelected(e: Event) {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return

  if (file.size > MAX_UPLOAD_BYTES) {
    alert(t('chatView.fileTooLarge', { max: '50 MB' }) || `文件超过 50 MB 限制`)
    target.value = ''
    return
  }

  uploading.value = true
  try {
    const form = new FormData()
    form.append('file', file)
    const convId = store.currentConversationId
    if (convId) form.append('conversation_id', convId)

    const up = await api.postForm<UploadedFileRef>('/v1/chat/upload', form, {
      // Uploads of large files over slow links routinely exceed the default
      // 30s timeout — 25 MB @ 1 Mbps ≈ 200 s. Give them 3 minutes.
      timeout: 180_000,
    })
    store.attachUpload(up)
    toast.info(t('chatView.fileAttached', { name: up.filename || file.name }))
  } catch (err: unknown) {
    const detail =
      (err as { detail?: string })?.detail ||
      (err as Error)?.message ||
      String(err)
    alert((t('chatView.uploadFailed') || '上传失败') + ': ' + detail)
  } finally {
    uploading.value = false
    target.value = ''
  }
}

function onRemoveAttachment(idx: number) {
  store.removeAttachment(idx)
}

function onMicClick() {
  toast.info(t('chatView.voiceNotAvailable'))
}

function closeSettings() {
  settings.showSettingsPanel = false
}

</script>

<template>
  <div class="layout">
    <!-- ===== Chat main ===== -->
    <div class="chat-main">
      <!-- Messages -->
      <ChatPanel
        :messages="store.currentMessages"
        :streaming="store.streamingReply"
        :loading="store.isStreaming"
        :activities="activityStore.events"
        class="chat-messages"
        @send-prompt="handleQuickPrompt"
      />

      <!-- Input -->
      <div class="input-area">
        <!-- Pending uploaded attachments — each a removable chip. Bytes are
             already in the sandbox by the time a chip renders here; the chip
             only carries metadata that will ride along in the next
             /v1/chat/completions request body as `uploaded_files`. -->
        <div
          v-if="store.pendingAttachments.length > 0"
          class="attachment-strip"
        >
          <div
            v-for="(att, idx) in store.pendingAttachments"
            :key="att.path + ':' + idx"
            class="attachment-chip"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            <span class="attachment-name" :title="att.filename">{{ att.filename }}</span>
            <span class="attachment-size">{{ formatFileSize(att.size) }}</span>
            <button
              class="attachment-remove"
              type="button"
              :title="t('chatView.removeAttachment') || '移除'"
              @click="onRemoveAttachment(idx)"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>
        </div>

        <div class="input-box" :class="{ focused: inputFocused }">
          <!-- Hidden file input -->
          <input
            ref="fileInputEl"
            type="file"
            style="display: none;"
            @change="onFileSelected"
            accept=".scs,.sp,.cir,.txt,.json,.csv,.pdf"
          />
          <button
            class="input-icon-btn"
            :title="t('chatView.attachment')"
            :disabled="uploading"
            @click="openAttach"
          >
            <svg v-if="!uploading" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            <svg v-else class="spinner" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M12 2a10 10 0 0110 10" />
            </svg>
          </button>
          <textarea
            ref="inputEl"
            v-model="input"
            class="chat-input"
            rows="1"
            :placeholder="inputPlaceholder"
            :disabled="inputDisabled"
            @keydown="onKeydown"
            @input="autoResizeInput"
            @focus="inputFocused = true"
            @blur="inputFocused = false"
          />
          <button
            class="input-icon-btn activity-toggle"
            :class="{ active: showActivitySidebar }"
            :title="t('chat.activityProgress')"
            :aria-label="t('chat.activityProgress')"
            data-testid="activity-toggle"
            @click="showActivitySidebar = !showActivitySidebar"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
            <span v-if="activeCount > 0" class="activity-badge">{{ activeCount }}</span>
          </button>
          <button class="input-icon-btn" :title="t('chatView.voice')" @click="onMicClick">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
          </button>
          <!-- 1.7.61: while streaming, replace send button with a stop button
               that calls store.stopStreaming() — kills CC subprocess + closes
               SSE so user isn't stuck "one-way down the road". -->
          <button
            v-if="sending"
            class="send-btn stop-btn"
            :title="t('chat.stopGenerating')"
            @click="store.stopStreaming"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>
          </button>
          <button
            v-else
            class="send-btn"
            :disabled="!input.trim()"
            @click="send"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </button>
        </div>
        <span class="input-hint">{{ t('chat.inputHint') }}</span>
      </div>
    </div>

    <!-- ===== Right sidebar: activity ===== -->
    <aside v-if="showActivitySidebar" class="activity-panel">
      <div class="panel-header">
        <span class="panel-title">{{ t('chat.activityProgress') }}</span>
        <button class="rail-btn small" @click="showActivitySidebar = false">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="panel-body">
        <ActivityTimeline :events="activityStore.events" />
        <!-- Generic file artifacts produced by the cloud sandbox (reports,
             documents, images, logs, and generated reports). Live-updates through the
             activity SSE `artifact_created` event; see stores/chat_artifacts.ts. -->
        <div class="metrics-section">
          <ArtifactListPanel />
        </div>
      </div>
    </aside>

    <!-- ===== Settings slide-over ===== -->
    <Transition name="slideover">
      <div v-if="settings.showSettingsPanel" class="settings-overlay" @click.self="closeSettings">
        <aside class="settings-panel">
          <div class="panel-header">
            <span class="panel-title">{{ t('chatView.settings') }}</span>
            <button class="rail-btn small" @click="closeSettings">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>
          <div class="settings-body">
            <!-- Theme -->
            <div class="settings-group">
              <div class="settings-label">{{ t('chatView.theme') }}</div>
              <div class="settings-row">
                <button class="theme-btn" :class="{ active: isDark }" @click="settings.setTheme('dark')">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
                  {{ t('chatView.darkTheme') }}
                </button>
                <button class="theme-btn" :class="{ active: !isDark }" @click="settings.setTheme('light')">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/></svg>
                  {{ t('chatView.lightTheme') }}
                </button>
              </div>
            </div>

            <!-- Language -->
            <div class="settings-group">
              <div class="settings-label">{{ t('chatView.language') }}</div>
              <div class="settings-row">
                <button class="theme-btn" :class="{ active: settings.language === 'zh-CN' }" @click="settings.setLanguage('zh-CN')">{{ t('chatView.chinese') }}</button>
                <button class="theme-btn" :class="{ active: settings.language === 'en' }" @click="settings.setLanguage('en')">English</button>
              </div>
            </div>

            <!-- Server URL -->
            <div class="settings-group">
              <div class="settings-label">{{ t('chatView.serverUrl') }}</div>
              <input class="settings-input" :value="settings.serverUrl" @change="settings.setServerUrl(($event.target as HTMLInputElement).value)" placeholder="http://127.0.0.1:8787" />
            </div>


          </div>
        </aside>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  height: 100%;
  overflow: hidden;
  background: transparent;
}

.rail-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--radius-sm, 6px);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: color 0.12s, background 0.12s;
}

.rail-btn:hover {
  color: var(--text-primary);
  background: var(--bg-hover, rgba(128, 128, 128, 0.08));
}

.rail-btn.small {
  width: 30px;
  height: 30px;
}

.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.model-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 44px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.chat-messages {
  flex: 1;
  min-height: 0;
}

.input-area {
  padding: 0 32px 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
  background: transparent;
}

.attachment-strip {
  width: 100%;
  max-width: 720px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}

.attachment-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 260px;
  padding: 4px 6px 4px 10px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 12px;
  color: var(--text-primary);
}

.attachment-chip svg {
  flex-shrink: 0;
  color: var(--text-muted);
}

.attachment-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 160px;
}

.attachment-size {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
}

.attachment-remove {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: color 0.12s, background 0.12s;
}

.attachment-remove:hover {
  color: var(--text-primary);
  background: var(--bg-hover, rgba(128, 128, 128, 0.12));
}

.spinner {
  animation: awp-spin 0.9s linear infinite;
}

@keyframes awp-spin {
  to { transform: rotate(360deg); }
}

.input-icon-btn:disabled {
  cursor: wait;
  opacity: 0.6;
}

.input-box {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  max-width: 760px;
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: 18px;
  padding: 0 10px 0 12px;
  height: 60px;
  box-shadow: 0 8px 18px rgba(15, 23, 42, 0.04);
  transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
}

.input-box:focus-within,
.input-box.focused {
  background: var(--panel-bg);
  border-color: rgba(91, 123, 234, 0.32);
  box-shadow: 0 0 0 3px rgba(91, 123, 234, 0.10), 0 8px 18px rgba(15, 23, 42, 0.04);
}

.chat-input {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  color: var(--text-primary);
  font-size: 16px;
  line-height: 1.5;
  resize: none;
  min-height: unset;
  max-height: 120px;
  font-family: var(--font-sans);
  padding: 6px 0;
}

.chat-input::placeholder {
  color: var(--text-tertiary);
}

.input-icon-btn {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--icon-muted);
  cursor: pointer;
  flex-shrink: 0;
  transition: color 0.12s, background 0.12s;
}

.input-icon-btn:hover {
  color: var(--text-primary);
  background: var(--panel-soft);
}

.activity-toggle {
  position: relative;
}

.activity-toggle.active {
  color: var(--primary);
  background: var(--primary-soft);
}

.activity-badge {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 7px;
  background: var(--primary);
  color: #fff;
  font-size: 9px;
  font-weight: 600;
  line-height: 14px;
  text-align: center;
  pointer-events: none;
}

.send-btn {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border: none;
  border-radius: 14px;
  background: var(--primary);
  color: #fff;
  cursor: pointer;
  flex-shrink: 0;
  box-shadow: none;
  transition: background 0.15s, box-shadow 0.15s, opacity 0.12s;
}

.send-btn:hover:not(:disabled) {
  background: var(--primary-hover);
  box-shadow: 0 1px 2px rgba(76, 111, 255, 0.22), 0 6px 14px rgba(76, 111, 255, 0.22);
}

.send-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
  box-shadow: none;
}

/* 1.7.61: stop button variant — visually distinct from send so user
   doesn't accidentally hit it. Square stop icon + warmer red. */
.send-btn.stop-btn {
  background: var(--danger, #dc2626);
}
.send-btn.stop-btn:hover {
  background: #b91c1c;
}

.input-hint {
  width: 100%;
  max-width: 760px;
  margin-top: 10px;
  padding-left: 8px;
  font-size: 12px;
  color: var(--text-tertiary);
  user-select: none;
}

.activity-panel {
  width: 320px;
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  overflow: hidden;
  background: var(--bg-secondary, var(--bg-primary));
}

.panel-header {
  min-height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  background: var(--bg-surface, var(--bg-secondary));
}

.panel-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.metrics-section {
  border-top: 1px solid var(--border);
  padding-top: 12px;
}

.metrics-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.settings-overlay {
  position: fixed;
  inset: 0;
  z-index: 900;
  background: rgba(0, 0, 0, 0.3);
  display: flex;
  justify-content: flex-end;
}

.settings-panel {
  width: min(400px, 100vw);
  height: 100%;
  background: var(--bg-surface, var(--bg-secondary));
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}

.settings-body {
  flex: 1;
  overflow-y: auto;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.settings-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.settings-label {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-placeholder);
  text-transform: uppercase;
  letter-spacing: 0.09em;
}

.settings-row {
  display: flex;
  gap: 8px;
}

.theme-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 38px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-surface, var(--bg-secondary));
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}

.theme-btn:hover {
  background: var(--bg-hover, rgba(128, 128, 128, 0.08));
}

.theme-btn.active {
  background: rgba(var(--accent-rgb), 0.10);
  border-color: rgba(var(--accent-rgb), 0.22);
  color: var(--text-primary);
}

.settings-input {
  min-height: 40px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-surface, var(--bg-secondary));
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: 13px;
  outline: none;
  transition: border-color 0.12s;
}

.settings-input:focus {
  border-color: var(--border-strong, var(--text-muted));
}

.settings-input::placeholder {
  color: var(--text-placeholder);
}

.vm-msg {
  font-size: 12px;
  margin-top: 6px;
  color: var(--danger);
  word-break: break-word;
  line-height: 1.5;
}

.vm-msg.ok {
  color: var(--success);
}

.vm-hint {
  font-size: 11px;
  margin-top: 4px;
  color: var(--text-muted);
  line-height: 1.5;
}

.vm-cred-summary {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  background: var(--bg-hover, rgba(0, 0, 0, 0.03));
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 12px;
}

.vm-cred-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.vm-cred-key {
  flex-shrink: 0;
  color: var(--text-muted);
  font-size: 11px;
  min-width: 72px;
}

.vm-cred-value {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  color: var(--text-primary);
  word-break: break-all;
}

.vm-cred-empty {
  color: var(--text-muted);
  font-style: italic;
}

.slideover-enter-active,
.slideover-leave-active {
  transition: opacity 0.22s;
}

.slideover-enter-active .settings-panel,
.slideover-leave-active .settings-panel {
  transition: transform 0.28s cubic-bezier(0.4, 0, 0.2, 1);
}

.slideover-enter-from {
  opacity: 0;
}

.slideover-enter-from .settings-panel {
  transform: translateX(100%);
}

.slideover-leave-to {
  opacity: 0;
}

.slideover-leave-to .settings-panel {
  transform: translateX(100%);
}

@media (max-width: 1180px) {
  .activity-panel {
    width: 296px;
  }
}

@media (max-width: 900px) {
  .input-area {
    padding-inline: 18px;
  }

  .input-box,
  .input-hint {
    max-width: none;
  }
}
</style>
