<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const isOpen = ref(false)

interface Shortcut {
  keys: string
  description: string
}

interface ShortcutGroup {
  title: string
  shortcuts: Shortcut[]
}

const groups = computed<ShortcutGroup[]>(() => [
  {
    title: t('kbd.global'),
    shortcuts: [
      { keys: 'Ctrl+S', description: t('kbd.save') },
      { keys: 'Ctrl+Z', description: t('kbd.undo') },
      { keys: 'Ctrl+Y', description: t('kbd.redo') },
      { keys: 'Ctrl+Shift+Z', description: t('kbd.redoAlt') },
      { keys: 'Ctrl+F', description: t('kbd.search') },
      { keys: 'Ctrl+K', description: t('kbd.commandPalette') },
      { keys: 'Ctrl+N', description: t('kbd.newThread') },
      { keys: '?', description: t('kbd.shortcutRef') },
      { keys: 'Ctrl+/', description: t('kbd.shortcutRefAlt') },
      { keys: 'F1', description: t('kbd.shortcutRefAlt') },
      { keys: 'Escape', description: t('kbd.closePanel') },
    ],
  },
])

function open() {
  isOpen.value = true
}

function close() {
  isOpen.value = false
}

function toggle() {
  isOpen.value = !isOpen.value
}

function handleKeydown(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName
  const isEditable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
    (e.target as HTMLElement)?.isContentEditable

  if (e.key === 'Escape' && isOpen.value) {
    e.preventDefault()
    close()
    return
  }

  if (isEditable) return

  if (e.key === '?' || e.key === 'F1' || ((e.ctrlKey || e.metaKey) && e.key === '/')) {
    e.preventDefault()
    toggle()
  }
}

onMounted(() => window.addEventListener('keydown', handleKeydown))
onUnmounted(() => window.removeEventListener('keydown', handleKeydown))

defineExpose({ open, close, toggle })
</script>

<template>
  <Teleport to="body">
    <Transition name="kbd">
      <div v-if="isOpen" class="kbd-overlay" @click.self="close">
        <div class="kbd-panel">
          <div class="kbd-header">
            <h2 class="kbd-title">{{ $t('kbd.title') }}</h2>
            <button class="kbd-close" @click="close" aria-label="Close">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>
          </div>
          <div class="kbd-body">
            <div v-for="group in groups" :key="group.title" class="kbd-group">
              <h3 class="kbd-group-title">{{ group.title }}</h3>
              <div class="kbd-list">
                <div v-for="s in group.shortcuts" :key="s.keys" class="kbd-row">
                  <span class="kbd-keys">
                    <kbd v-for="(part, i) in s.keys.split('+')" :key="i" class="kbd-key">{{ part.trim() }}</kbd>
                  </span>
                  <span class="kbd-desc">{{ s.description }}</span>
                </div>
              </div>
            </div>
          </div>
          <div class="kbd-footer">
            <span class="kbd-footer-hint">{{ $t('kbd.pressEscToClose') }}</span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.kbd-overlay {
  position: fixed;
  inset: 0;
  z-index: 2600;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 24px;
}

.kbd-panel {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  width: 560px;
  max-width: 90vw;
  max-height: 80vh;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.kbd-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}

.kbd-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.kbd-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.kbd-close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.kbd-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 20px 20px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}

.kbd-group {
  min-width: 0;
}

.kbd-group-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  margin: 0 0 8px;
}

.kbd-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.kbd-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
  gap: 12px;
}

.kbd-keys {
  display: flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
}

.kbd-key {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 22px;
  padding: 0 6px;
  font-size: 11px;
  font-family: var(--font-mono);
  font-weight: 500;
  color: var(--text-secondary);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  box-shadow: 0 1px 0 var(--border);
  line-height: 1;
  white-space: nowrap;
}

.kbd-desc {
  font-size: 13px;
  color: var(--text-secondary);
  text-align: right;
  white-space: nowrap;
}

.kbd-footer {
  padding: 10px 20px;
  border-top: 1px solid var(--border);
  text-align: center;
}

.kbd-footer-hint {
  font-size: 12px;
  color: var(--text-muted);
}

.kbd-footer-hint .kbd-key {
  font-size: 10px;
  height: 18px;
  min-width: 18px;
  padding: 0 4px;
  vertical-align: middle;
}

.kbd-enter-active, .kbd-leave-active {
  transition: opacity 0.15s ease;
}

.kbd-enter-from, .kbd-leave-to {
  opacity: 0;
}

@media (max-width: 600px) {
  .kbd-body {
    grid-template-columns: 1fr;
  }
}
</style>
