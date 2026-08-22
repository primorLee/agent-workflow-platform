<script setup lang="ts">
import { ref, onErrorCaptured } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const router = useRouter()

const error = ref<Error | null>(null)
const errorInfo = ref<string>('')

onErrorCaptured((err: Error, instance, info: string) => {
  error.value = err
  errorInfo.value = info
  const componentName = instance?.$options?.name || instance?.$.type?.name || 'Unknown'
  console.error(
    `[ErrorBoundary] Error in <${componentName}> during "${info}":`,
    err,
  )
  if (err.stack) {
    console.error('[ErrorBoundary] Stack:', err.stack)
  }
  // Return false to prevent the error from propagating further
  return false
})

function retry() {
  error.value = null
  errorInfo.value = ''
}

function goHome() {
  error.value = null
  errorInfo.value = ''
  router.push({ name: 'chat' })
}
</script>

<template>
  <slot v-if="!error" />
  <div v-else class="error-boundary">
    <div class="error-boundary__icon">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
    </div>
    <h3 class="error-boundary__title">{{ t('error.somethingWrong') }}</h3>
    <p class="error-boundary__context">{{ t('error.occurredDuring', { info: errorInfo }) }}</p>
    <pre class="error-boundary__message">{{ error.message }}</pre>
    <div class="error-boundary__actions">
      <button class="error-boundary__retry" @click="retry">{{ t('error.reload') }}</button>
      <button class="error-boundary__home" @click="goHome">{{ t('error.goHome') }}</button>
    </div>
  </div>
</template>

<style scoped>
.error-boundary {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-height: 200px;
  padding: 32px;
  gap: 12px;
  color: var(--text-secondary, #9ca3af);
}

.error-boundary__icon {
  color: var(--danger, #ef4444);
  opacity: 0.7;
}

.error-boundary__title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary, #f3f4f6);
}

.error-boundary__message {
  margin: 0;
  padding: 12px 16px;
  max-width: 600px;
  width: 100%;
  font-size: 12px;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  background: var(--bg-secondary, #1f2937);
  border: 1px solid var(--border, #374151);
  border-radius: var(--radius-sm, 4px);
  color: var(--text-muted, #6b7280);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-y: auto;
  max-height: 200px;
}

.error-boundary__context {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted, #6b7280);
}

.error-boundary__actions {
  display: flex;
  gap: 12px;
  margin-top: 8px;
}

.error-boundary__retry {
  padding: 8px 24px;
  font-size: 13px;
  font-weight: 500;
  border: 1px solid var(--accent, #3b82f6);
  border-radius: var(--radius-sm, 4px);
  background: transparent;
  color: var(--accent, #3b82f6);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.error-boundary__retry:hover {
  background: var(--accent, #3b82f6);
  color: #fff;
}

.error-boundary__home {
  padding: 8px 24px;
  font-size: 13px;
  font-weight: 500;
  border: 1px solid var(--border, #374151);
  border-radius: var(--radius-sm, 4px);
  background: transparent;
  color: var(--text-secondary, #9ca3af);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.error-boundary__home:hover {
  background: var(--bg-secondary, #1f2937);
  color: var(--text-primary, #f3f4f6);
}
</style>
