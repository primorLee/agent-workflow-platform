<script setup lang="ts">
import { reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { ChatMessage } from '@/api/types'
import { useChatStore } from '@/stores/chat'
import { useToastStore } from '@/stores/toast'

const { t } = useI18n()
const chatStore = useChatStore()
const toast = useToastStore()

const props = defineProps<{
  message: ChatMessage
  index: number
  messages: ChatMessage[]
}>()

// Track thumbs up/down state
const thumbsState = reactive<Record<number, 'up' | 'down' | null>>({})
// Track copy feedback
const copyFeedback = reactive<Record<number, boolean>>({})

function renderMarkdown(content: string): string {
  const html = marked.parse(content, { async: false }) as string
  return DOMPurify.sanitize(html, {
    // Saved generic artifacts use an app-owned URI handled by Electron.
    ALLOWED_URI_REGEXP:
      /^(?:(?:(?:f|ht)tps?|mailto|tel|awp):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  })
}
// --- Message action handlers ---

async function copyMessage(index: number, content: string) {
  try {
    await navigator.clipboard.writeText(content)
    copyFeedback[index] = true
    setTimeout(() => { copyFeedback[index] = false }, 2000)
  } catch {
    toast.info(t('chat.copyFailed'))
  }
}

function toggleThumb(index: number, direction: 'up' | 'down') {
  if (thumbsState[index] === direction) {
    thumbsState[index] = null
  } else {
    thumbsState[index] = direction
  }
}

function regenerate() {
  chatStore.regenerateLastResponse()
}
</script>

<template>
  <div class="chat-msg-wrapper" :class="message.role">
    <div class="chat-msg" :class="message.role">
      <template v-if="message.role === 'user'">
        <div class="user-avatar" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21a8 8 0 0116 0" />
          </svg>
        </div>
        <div class="msg-bubble user-bubble">{{ message.content }}</div>
      </template>
      <template v-else>
        <div class="ai-avatar">
          <img src="/awp-mark.svg" class="ai-avatar-img" alt="Agent Workflow Platform" draggable="false" />
        </div>
        <div class="ai-content">
          <div class="msg-bubble assistant-bubble" v-html="renderMarkdown(message.content)" />
          <!-- Inline charts: awp_plot matplotlib PNGs rendered in the
               Windows sandbox, shown directly in-message (not the sidebar).
               base64 is text-bound to :src (Vue escapes), never raw HTML. -->
          <div v-if="message.images && message.images.length" class="msg-plots">
            <figure v-for="img in message.images" :key="img.id" class="msg-plot">
              <img
                :src="`data:image/png;base64,${img.png_base64}`"
                :alt="img.title"
                class="msg-plot-img"
                loading="lazy"
              />
              <figcaption v-if="img.title" class="msg-plot-caption">{{ img.title }}</figcaption>
            </figure>
          </div>
          <!-- Message action buttons -->
          <div class="msg-actions">
            <button
              class="msg-action-btn"
              :class="{ active: thumbsState[index] === 'up' }"
              :title="t('chat.thumbUp')"
              @click="toggleThumb(index, 'up')"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" :fill="thumbsState[index] === 'up' ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3H14zM7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3"/></svg>
            </button>
            <button
              class="msg-action-btn"
              :class="{ active: thumbsState[index] === 'down' }"
              :title="t('chat.thumbDown')"
              @click="toggleThumb(index, 'down')"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" :fill="thumbsState[index] === 'down' ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 003 3l4-9V2H5.72a2 2 0 00-2 1.7l-1.38 9a2 2 0 002 2.3H10zM17 2h2.67A2.31 2.31 0 0122 4v7a2.31 2.31 0 01-2.33 2H17"/></svg>
            </button>
            <button
              class="msg-action-btn"
              :class="{ copied: copyFeedback[index] }"
              :title="copyFeedback[index] ? t('chat.copied') : t('chat.copy')"
              @click="copyMessage(index, message.content)"
            >
              <svg v-if="!copyFeedback[index]" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
              <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            </button>
            <button
              class="msg-action-btn"
              :title="t('chat.regenerate')"
              @click="regenerate"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
            </button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* ===== Messages ===== */
.chat-msg-wrapper { display: flex; flex-direction: column; }
.chat-msg-wrapper.user,
.chat-msg-wrapper.assistant { align-items: flex-start; }

.chat-msg { display: flex; width: 100%; }
.chat-msg.user,
.chat-msg.assistant { justify-content: flex-start; gap: 10px; align-items: flex-start; }

.user-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--panel-soft);
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--text-secondary);
}

.msg-bubble {
  max-width: min(760px, calc(100vw - 320px));
  padding: 14px 18px;
  border-radius: 16px;
  font-size: 14px;
  line-height: 1.75;
  word-break: break-word;
}

.user-bubble {
  background: var(--panel-blue-soft);
  color: var(--msg-user-text);
  max-width: 560px;
  border: 1px solid transparent;
  border-radius: 16px 16px 4px 16px;
  padding: 12px 16px;
}

/* Inline charts (awp_plot) — sandbox-rendered matplotlib PNGs shown
   directly in the assistant message, inside the assistant message. */
.msg-plots {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 8px 0 4px;
}
.msg-plot {
  margin: 0;
  max-width: 560px;
}
.msg-plot-img {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: #fff;
}
.msg-plot-caption {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-secondary);
  text-align: center;
}

.assistant-bubble {
  background: transparent;
  color: var(--text-primary);
  font-size: 14px;
  padding: 2px 0 0;
  line-height: 1.78;
}

.assistant-bubble :deep(p) { margin: 0 0 10px; }
.assistant-bubble :deep(p:last-child) { margin-bottom: 0; }
.assistant-bubble :deep(strong) { font-weight: 600; color: var(--text-primary); }

.assistant-bubble :deep(h1),
.assistant-bubble :deep(h2),
.assistant-bubble :deep(h3) {
  font-weight: 700;
  color: var(--text-primary);
  font-size: 15px;
  margin: 14px 0 10px;
  letter-spacing: -0.005em;
}
.assistant-bubble :deep(h1:first-child),
.assistant-bubble :deep(h2:first-child),
.assistant-bubble :deep(h3:first-child) { margin-top: 0; }

.assistant-bubble :deep(ul),
.assistant-bubble :deep(ol) { padding-left: 20px; margin: 6px 0 12px; }
.assistant-bubble :deep(li) { margin: 3px 0; padding-left: 2px; }
.assistant-bubble :deep(li::marker) { color: var(--text-muted); }

.assistant-bubble :deep(blockquote) {
  margin: 10px 0;
  padding: 12px 16px;
  background: var(--panel-soft);
  border: 1px solid var(--border);
  border-left: 3px solid var(--primary);
  border-radius: var(--radius-control);
  color: var(--text-primary);
  font-style: normal;
}
.assistant-bubble :deep(blockquote p) { margin: 0; }
.assistant-bubble :deep(blockquote p + p) { margin-top: 4px; color: var(--text-secondary); font-size: 13px; }

/* Hairline divider after the paper-title card (§5.3). Rendered only when a
 * blockquote is immediately followed by content, so a lone quote doesn't
 * grow a dangling line underneath. */
.assistant-bubble :deep(blockquote + *) {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--border-subtle);
}

.assistant-bubble :deep(hr) {
  border: none;
  border-top: 1px solid var(--border-subtle);
  margin: 14px 0;
}

.assistant-bubble :deep(code) {
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--inline-code-bg);
  padding: 2px 6px;
  border-radius: 6px;
  color: var(--text-primary);
}

.assistant-bubble :deep(pre) {
  background: var(--bg-terminal);
  padding: 14px 16px;
  border-radius: var(--radius-control);
  overflow-x: auto;
  margin: 12px 0;
  border: 1px solid var(--border);
}

.assistant-bubble :deep(pre code) { background: none; padding: 0; }
.assistant-bubble :deep(table) { border-collapse: collapse; margin: 8px 0; font-size: 12px; }

.assistant-bubble :deep(th),
.assistant-bubble :deep(td) { border: 1px solid var(--border, #2a2a4a); padding: 4px 10px; }
.assistant-bubble :deep(th) { background: var(--bg-hover, #2a2a4a); font-weight: 600; }

/* ===== AI avatar ===== */
.ai-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--primary-soft);
  border: 1px solid rgba(76, 111, 255, 0.18);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--primary);
  box-shadow: 0 1px 2px rgba(76, 111, 255, 0.08);
}

.ai-avatar-img { width: 20px; height: 20px; border-radius: 4px; display: block; -webkit-user-drag: none; user-select: none; }

.ai-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* ===== Message action buttons ===== */
.msg-actions {
  display: flex;
  gap: 4px;
  padding-left: 0;
}

.msg-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.msg-action-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
  border-color: var(--border);
}

.msg-action-btn.active { color: var(--text-primary); }
.msg-action-btn.copied { color: var(--text-secondary); }

@media (max-width: 980px) {
  .msg-bubble { max-width: 100%; }
}
</style>
