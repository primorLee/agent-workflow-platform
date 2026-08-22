<script setup lang="ts">
import { useToastStore } from '@/stores/toast'

const toast = useToastStore()
</script>

<template>
  <Teleport to="body">
    <div class="toast-container">
      <TransitionGroup name="toast">
        <div
          v-for="t in toast.toasts"
          :key="t.id"
          class="toast-item"
          :class="`toast-${t.type}`"
          @click="toast.dismiss(t.id)"
        >
          <span class="toast-icon">
            <template v-if="t.type === 'success'">&#x2713;</template>
            <template v-else-if="t.type === 'error'">&#x2717;</template>
            <template v-else-if="t.type === 'warning'">&#x26A0;</template>
            <template v-else>&#x2139;</template>
          </span>
          <span class="toast-msg">{{ t.message }}</span>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-container {
  position: fixed;
  /* titleBarOverlay 占 36px（见 main.ts BrowserWindow.titleBarOverlay.height）
     + 12px 呼吸空间，避开 Windows 三合一窗口控制按钮（最小化/最大化/关闭） */
  top: 48px;
  right: 16px;
  z-index: 3000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}
.toast-item {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-radius: var(--radius);
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  color: var(--text-primary);
  font-size: 13px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  cursor: pointer;
  max-width: 360px;
}
.toast-icon { font-size: 15px; flex-shrink: 0; }
.toast-success .toast-icon { color: var(--success); }
.toast-error .toast-icon { color: var(--danger); }
.toast-warning .toast-icon { color: var(--warning); }
.toast-info .toast-icon { color: var(--accent); }
.toast-success { border-left: 3px solid var(--success); }
.toast-error { border-left: 3px solid var(--danger); }
.toast-warning { border-left: 3px solid var(--warning); }
.toast-info { border-left: 3px solid var(--accent); }

.toast-enter-active { transition: all 0.25s ease-out; }
.toast-leave-active { transition: all 0.2s ease-in; }
.toast-enter-from { opacity: 0; transform: translateX(30px); }
.toast-leave-to { opacity: 0; transform: translateX(30px); }
.toast-move { transition: transform 0.2s; }
</style>
