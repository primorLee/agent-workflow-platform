<script setup lang="ts">
import { ref, watch, onUnmounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useChatStore } from '@/stores/chat'
import ToolIcon from './ToolIcon.vue'

const { t } = useI18n()
const chatStore = useChatStore()

defineProps<{
  streaming: string
  loading: boolean
}>()

// Ticks every 500 ms so the "thinking (Xs)" counter updates twice a
// second — the spec wants visible motion in the sub-1s window where
// CC is warming up but no token / cc_status has arrived yet.
// We still display whole seconds in the label; the finer tick is for
// the 60s long-wait threshold crossing and the sub-second sub-text.
const nowTs = ref(Date.now())
let elapsedTimer: ReturnType<typeof setInterval> | null = null

watch(() => chatStore.isStreaming, (streaming) => {
  if (streaming) {
    nowTs.value = Date.now()
    elapsedTimer = setInterval(() => { nowTs.value = Date.now() }, 500)
  } else {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null }
  }
})

onUnmounted(() => {
  if (elapsedTimer) clearInterval(elapsedTimer)
})

/** Whole-second elapsed count since stream start. Returns 0 when no
 *  stream is active so templates can safely unconditionally interpolate
 *  without guarding against null. */
const elapsedSeconds = computed(() => {
  const start = chatStore.streamStartedAt
  if (!start) return 0
  return Math.max(0, Math.floor((nowTs.value - start) / 1000))
})

/** After 60s with no token/status, surface a "still waiting" hint so
 *  the user knows the CLI hasn't silently crashed. */
const longWait = computed(() => elapsedSeconds.value >= 60)

/** "AI 思考中 (Xs)" — the canonical placeholder label used when no
 *  cc_status has arrived yet. Once `ccStatus` populates we prefer it. */
const thinkingLabel = computed(() => {
  if (chatStore.ccStatus) return chatStore.ccStatus
  return t('chat.aiThinkingWithSec', { sec: elapsedSeconds.value })
})

function renderMd(content: string): string {
  const raw = marked.parse(content, { async: false }) as string
  return DOMPurify.sanitize(raw)
}
</script>

<template>
  <!-- Streaming response -->
  <div v-if="streaming" class="chat-msg-wrapper assistant">
    <div class="chat-msg assistant">
      <div class="ai-avatar">
        <img src="/awp-mark.svg" class="ai-avatar-img" alt="Agent Workflow Platform" draggable="false" />
      </div>
      <div class="ai-content">
        <div class="msg-bubble assistant-bubble">
          <span v-html="renderMd(streaming)" />
          <span class="typing-cursor" />
        </div>
      </div>
    </div>
  </div>

  <!-- Context usage bar -->
  <div v-if="chatStore.currentMessages.length > 5" class="context-usage-bar">
    <div class="ctx-bar-track">
      <div
        class="ctx-bar-fill"
        :class="{ warning: chatStore.contextWarning }"
        :style="{ width: chatStore.contextPercent + '%' }"
      />
    </div>
    <span class="ctx-label">
      {{ t('chat.contextUsed', { n: chatStore.contextPercent }) }}
      <span v-if="chatStore.contextWarning" class="ctx-warning-text">{{ t('chat.contextWarning') }}</span>
    </span>
  </div>

  <!-- Enhanced processing indicator. Shown whenever a stream is active;
       the elapsed badge renders from second 0 so the user sees motion
       before the first token arrives (CC cold-start can take 30s+). -->
  <div v-if="chatStore.isStreaming" class="processing-indicator">
    <div class="glimmer-bar">
      <div class="glimmer-fill" />
    </div>
    <span class="processing-text">{{ thinkingLabel }}</span>
    <span class="elapsed-badge">{{ elapsedSeconds }}s</span>
  </div>

  <!-- Long-wait hint: after 60s with no assistant token AND no cc_status
       progressing, surface a gentle "still waiting" line so the user
       knows the app hasn't silently wedged. We key off `longWait` + the
       absence of a rendered streaming reply so this doesn't flash after
       a late first token. -->
  <div v-if="chatStore.isStreaming && longWait && !streaming" class="long-wait-hint">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
    </svg>
    <span>{{ t('chat.waitedLong', { sec: elapsedSeconds }) }}</span>
  </div>

  <!-- Terminal error chunk (SSE `{type:"error"}` or onError). Rendered
       as its own red-bordered bubble so it doesn't mix with normal
       assistant content and so the user can explicitly dismiss it. -->
  <div v-if="chatStore.streamErrorChunk && !chatStore.isStreaming" class="stream-error-bubble">
    <div class="err-head">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <span class="err-title">{{ t('chat.streamErrorTitle') }}</span>
      <span v-if="chatStore.streamErrorChunk.code" class="err-code">{{ chatStore.streamErrorChunk.code }}</span>
    </div>
    <div class="err-msg">{{ chatStore.streamErrorChunk.message }}</div>
    <div class="err-actions">
      <button class="retry-btn" @click="chatStore.regenerateLastResponse()">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
        {{ t('chat.retry') }}
      </button>
      <button class="retry-btn" @click="chatStore.dismissStreamError()">
        {{ t('chat.dismiss') }}
      </button>
    </div>
  </div>

  <!-- CC Task Status / Todo List -->
  <div v-if="chatStore.ccTodoList.length > 0 && chatStore.isStreaming" class="todo-panel">
    <div class="todo-header">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
      <span>{{ t('chat.taskProgress') }}</span>
    </div>
    <div v-for="(item, idx) in chatStore.ccTodoList" :key="idx" class="todo-item" :class="{ done: item.done, current: !item.done && idx === chatStore.ccTodoList.length - 1 }">
      <!-- Lucide SVG tool icon. Status drives both icon and color:
           done -> green check, current running -> spinning loader,
           else the tool-specific icon (BookOpen/Terminal/etc.) in accent. -->
      <ToolIcon
        class="todo-check"
        :tool="item.tool || ''"
        :size="14"
        :status="item.done ? 'done' : (idx === chatStore.ccTodoList.length - 1 ? 'running' : 'idle')"
      />
      <span class="todo-label">{{ item.label }}</span>
    </div>
  </div>


  <!-- Enhanced loading animation -->
  <div v-if="loading && !streaming && chatStore.ccTodoList.length === 0" class="chat-msg-wrapper assistant">
    <div class="chat-msg assistant">
      <div class="ai-avatar">
        <img src="/awp-mark.svg" class="ai-avatar-img" alt="Agent Workflow Platform" draggable="false" />
      </div>
      <div class="ai-content">
        <div class="msg-bubble assistant-bubble loading-shimmer">
          <div class="shimmer-line" /><div class="shimmer-line short" /><div class="shimmer-line medium" />
        </div>
      </div>
    </div>
  </div>

  <!-- Error display with retry (legacy path; superseded by the
       stream-error bubble above when `streamErrorChunk` is populated) -->
  <div v-if="chatStore.error && !chatStore.isStreaming && !chatStore.streamErrorChunk" class="chat-error-block">
    <div class="error-card">
      <div class="error-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
      </div>
      <div class="error-content">
        <span class="error-text">{{ chatStore.error }}</span>
        <button class="retry-btn" @click="chatStore.regenerateLastResponse()">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
          {{ t('chat.retry') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ===== Streaming message ===== */
.chat-msg-wrapper { display: flex; flex-direction: column; }
.chat-msg-wrapper.assistant { align-items: flex-start; }

.chat-msg { display: flex; }
.chat-msg.assistant { justify-content: flex-start; gap: 10px; align-items: flex-start; }

.msg-bubble {
  max-width: min(760px, calc(100vw - 320px));
  padding: 14px 16px;
  border-radius: 8px;
  font-size: 14px;
  line-height: 1.7;
  word-break: break-word;
}

.assistant-bubble {
  background: transparent;
  color: var(--msg-ai-text);
  font-size: 14px;
  padding-left: 0;
}

.ai-avatar {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: var(--muted-surface, var(--bg-hover, rgba(255, 255, 255, 0.06)));
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.ai-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* ===== Typing / loading ===== */
.typing-cursor {
  display: inline-block;
  width: 2px;
  height: 14px;
  background: var(--text-muted);
  margin-left: 2px;
  vertical-align: text-bottom;
  animation: blink 0.8s step-end infinite;
}
@keyframes blink { 50% { opacity: 0; } }

.loading-shimmer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px 20px !important;
}

.shimmer-line {
  height: 10px;
  border-radius: 4px;
  background: linear-gradient(90deg, var(--track-bg), rgba(128, 128, 128, 0.16), var(--track-bg));
  background-size: 200% 100%;
  animation: shimmer 1.5s ease-in-out infinite;
  width: 85%;
}
.shimmer-line.short { width: 55%; }
.shimmer-line.medium { width: 70%; }
@keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }

/* ===== Glimmer processing indicator ===== */
.processing-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px 6px 38px;
  transition: all 0.3s;
  animation: fadeInUp 0.3s ease;
}

.glimmer-bar {
  width: 60px;
  height: 3px;
  background: var(--track-bg);
  border-radius: 2px;
  overflow: hidden;
}

.glimmer-fill {
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, transparent, var(--text-muted), transparent);
  animation: glimmer 1.5s ease-in-out infinite;
}

@keyframes glimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
@keyframes fadeInUp {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.processing-text { font-size: 12px; color: var(--text-muted); }
.elapsed-badge {
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-hover);
  padding: 1px 6px;
  border-radius: 6px;
  font-variant-numeric: tabular-nums;
}

/* Long-wait hint — shown only after 60s of dead air */
.long-wait-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px 4px 38px;
  font-size: 11px;
  color: #f59e0b;
  animation: fadeInUp 0.3s ease;
}
.long-wait-hint svg { flex-shrink: 0; }

/* Stream error bubble — explicit terminal error chunk */
.stream-error-bubble {
  margin: 6px 0 6px 38px;
  padding: 10px 14px;
  border-radius: 8px;
  background: rgba(239, 68, 68, 0.06);
  border: 1px solid rgba(239, 68, 68, 0.35);
  max-width: 520px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  animation: fadeInUp 0.25s ease;
}

.err-head {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--error-icon, #ef4444);
  font-size: 12px;
}

.err-title {
  font-weight: 600;
  color: var(--error-text-soft, #ef4444);
}

.err-code {
  margin-left: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  font-size: 11px;
  padding: 1px 6px;
  background: rgba(239, 68, 68, 0.12);
  border-radius: 4px;
  color: var(--error-text-soft, #ef4444);
}

.err-msg {
  font-size: 13px;
  color: var(--text-primary);
  line-height: 1.5;
  word-break: break-word;
}

.err-actions {
  display: flex;
  gap: 8px;
  margin-top: 2px;
}

.ai-avatar-img { width: 22px; height: 22px; border-radius: 4px; display: block; -webkit-user-drag: none; user-select: none; }

/* ===== Todo / Task Progress Panel ===== */
.todo-panel {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 16px;
  max-width: 400px;
  align-self: flex-start;
}

.todo-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.todo-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 3px 0;
  color: var(--text-muted);
  transition: color 0.2s;
}

.todo-item.done { color: var(--text-secondary); }
.todo-item.current { color: var(--text-primary); font-weight: 500; }

.todo-check { width: 16px; text-align: center; font-size: 11px; }
.todo-item.done .todo-check { color: var(--text-secondary); }
.todo-item.current .todo-check { color: var(--text-primary); }

.todo-spinner {
  width: 10px;
  height: 10px;
  border: 2px solid var(--border);
  border-top-color: var(--text-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ===== Context usage bar ===== */
.context-usage-bar { display: flex; align-items: center; gap: 8px; padding: 4px 0 8px 38px; }
.ctx-bar-track { flex: 0 0 80px; height: 3px; background: var(--track-bg); border-radius: 2px; overflow: hidden; }
.ctx-bar-fill { height: 100%; background: var(--text-muted); border-radius: 2px; transition: width 0.3s; }
.ctx-bar-fill.warning { background: #f59e0b; }
.ctx-label { font-size: 11px; color: var(--text-muted); }
.ctx-warning-text { color: #f59e0b; }

/* ===== Error display ===== */
.chat-error-block { display: flex; justify-content: flex-start; padding-left: 38px; }

.error-card {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: 8px;
  padding: 10px 14px;
  max-width: 500px;
}

.error-icon { color: var(--error-icon); flex-shrink: 0; margin-top: 1px; }
.error-content { display: flex; flex-direction: column; gap: 8px; }
.error-text { color: var(--error-text-soft); font-size: 13px; line-height: 1.5; }

.retry-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--error-bg-soft);
  color: var(--error-text-soft);
  border: 1px solid var(--error-border-soft);
  border-radius: 8px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
  width: fit-content;
}

.retry-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

@media (max-width: 980px) {
  .chat-error-block,
  .context-usage-bar {
    padding-left: 0;
    margin-left: 0;
  }
}
</style>
