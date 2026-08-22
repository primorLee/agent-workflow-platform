<script setup lang="ts">
import { useToastStore } from '@/stores/toast'

const toast = useToastStore()

function iconFor(type: string): string {
  switch (type) {
    case 'success': return '\u2713'
    case 'error':   return '\u2717'
    case 'warning': return '\u26A0'
    default:        return '\u2139'
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="ntoast-container" aria-live="polite">
      <TransitionGroup name="ntoast">
        <div
          v-for="t in toast.toasts"
          :key="t.id"
          class="ntoast"
          :class="`ntoast--${t.type}`"
          role="alert"
        >
          <span class="ntoast__icon">{{ iconFor(t.type) }}</span>
          <span class="ntoast__msg">{{ t.message }}</span>
          <button
            class="ntoast__close"
            @click.stop="toast.dismiss(t.id)"
            aria-label="Close"
          >&times;</button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.ntoast-container {
  position: fixed;
  /* titleBarOverlay 占 36px（见 main.ts BrowserWindow.titleBarOverlay.height）
     + 12px 呼吸空间，避开 Windows 三合一窗口控制按钮（最小化/最大化/关闭） */
  top: 48px;
  right: 16px;
  z-index: 9000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
  max-height: calc(100vh - 32px);
  overflow: hidden;
}

.ntoast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: var(--radius);
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  color: var(--text-primary);
  font-size: 13px;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35);
  max-width: 380px;
  min-width: 240px;
}

.ntoast__icon {
  font-size: 15px;
  flex-shrink: 0;
  width: 18px;
  text-align: center;
}

.ntoast__msg {
  flex: 1;
  line-height: 1.4;
  word-break: break-word;
}

.ntoast__close {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 16px;
  cursor: pointer;
  padding: 0 2px;
  line-height: 1;
  flex-shrink: 0;
  transition: color 0.15s;
}
.ntoast__close:hover {
  color: var(--text-primary);
}

/* Type-specific borders & icon colors */
.ntoast--success { border-left: 3px solid var(--success); }
.ntoast--error   { border-left: 3px solid var(--danger); }
.ntoast--warning { border-left: 3px solid var(--warning); }
.ntoast--info    { border-left: 3px solid var(--accent); }

.ntoast--success .ntoast__icon { color: var(--success); }
.ntoast--error   .ntoast__icon { color: var(--danger); }
.ntoast--warning .ntoast__icon { color: var(--warning); }
.ntoast--info    .ntoast__icon { color: var(--accent); }

/* Slide-in from right */
.ntoast-enter-active { transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1); }
.ntoast-leave-active { transition: all 0.2s ease-in; }
.ntoast-enter-from   { opacity: 0; transform: translateX(100%); }
.ntoast-leave-to     { opacity: 0; transform: translateX(100%); }
.ntoast-move         { transition: transform 0.25s ease; }
</style>
