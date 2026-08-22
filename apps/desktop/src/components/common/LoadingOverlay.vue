<script setup lang="ts">
defineProps<{
  loading: boolean
  message?: string
  /** Optional secondary message (e.g. current step detail) */
  subMessage?: string
  /** Progress percentage 0–100; omit to hide the progress bar */
  progress?: number
  /** If true, covers the full viewport instead of the parent container */
  fullscreen?: boolean
}>()
</script>

<template>
  <Transition name="loading-fade">
    <div v-if="loading" class="loading-overlay" :class="{ 'loading-overlay--fullscreen': fullscreen }">
      <div class="loading-overlay__spinner" />
      <p v-if="message" class="loading-overlay__message">{{ message }}</p>
      <div v-if="typeof progress === 'number'" class="loading-overlay__progress-track">
        <div
          class="loading-overlay__progress-bar"
          :style="{ width: Math.min(100, Math.max(0, progress)) + '%' }"
        />
      </div>
      <p v-if="subMessage" class="loading-overlay__sub-message">{{ subMessage }}</p>
    </div>
  </Transition>
</template>

<style scoped>
.loading-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: rgba(0, 0, 0, 0.5);
  z-index: 200;
}

.loading-overlay--fullscreen {
  position: fixed;
}

.loading-overlay__spinner {
  width: 38px;
  height: 38px;
  border: 3px solid var(--border, #374151);
  border-top-color: var(--accent, #3b82f6);
  border-radius: 50%;
  animation: lo-spin 0.75s linear infinite;
}

.loading-overlay__message {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary, #9ca3af);
  font-weight: 500;
  letter-spacing: 0.01em;
}

.loading-overlay__sub-message {
  margin: 0;
  font-size: 11px;
  color: var(--text-muted, #6b7280);
  font-weight: 400;
}

.loading-overlay__progress-track {
  width: 180px;
  height: 3px;
  border-radius: 2px;
  background: var(--border, #374151);
  overflow: hidden;
}

.loading-overlay__progress-bar {
  height: 100%;
  border-radius: 2px;
  background: var(--accent, #3b82f6);
  transition: width 0.3s ease;
}

@keyframes lo-spin {
  to { transform: rotate(360deg); }
}

/* Transition */
.loading-fade-enter-active,
.loading-fade-leave-active {
  transition: opacity 0.25s ease;
}
.loading-fade-enter-from,
.loading-fade-leave-to {
  opacity: 0;
}
</style>
