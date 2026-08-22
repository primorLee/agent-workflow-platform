<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const router = useRouter()
const isOpen = ref(false)
const query = ref('')
const selectedIndex = ref(0)
const inputRef = ref<HTMLInputElement>()

interface Command {
  id: string
  label: string
  shortcut?: string
  action: () => void
}

const commands = computed<Command[]>(() => [
  { id: 'chat', label: t('cmd.goToChat'), shortcut: 'Ctrl+1', action: () => router.push({ name: 'chat' }) },
  { id: 'settings', label: t('cmd.goToSettings'), shortcut: 'Ctrl+3', action: () => router.push('/settings') },
  { id: 'about', label: t('cmd.goToAbout'), shortcut: 'Ctrl+4', action: () => router.push('/about') },
])

const filtered = computed(() => {
  if (!query.value.trim()) return commands.value
  const q = query.value.toLowerCase()
  return commands.value.filter(c => c.label.toLowerCase().includes(q) || c.id.includes(q))
})

watch(query, () => { selectedIndex.value = 0 })

function open() {
  isOpen.value = true
  query.value = ''
  selectedIndex.value = 0
  nextTick(() => inputRef.value?.focus())
}

function close() {
  isOpen.value = false
}

function execute(cmd: Command) {
  close()
  cmd.action()
}

function onKeydown(e: KeyboardEvent) {
  // 中文输入法组词期间（确认候选/选词翻页）的按键不触发命令执行/导航。
  if (e.isComposing || e.keyCode === 229) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selectedIndex.value = Math.min(selectedIndex.value + 1, filtered.value.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    selectedIndex.value = Math.max(selectedIndex.value - 1, 0)
  } else if (e.key === 'Enter' && filtered.value.length > 0) {
    e.preventDefault()
    execute(filtered.value[selectedIndex.value]!)
  } else if (e.key === 'Escape') {
    close()
  }
}

function handleGlobalKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault()
    if (isOpen.value) close()
    else open()
  }
}

onMounted(() => window.addEventListener('keydown', handleGlobalKeydown))
onUnmounted(() => window.removeEventListener('keydown', handleGlobalKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="cmd">
      <div v-if="isOpen" class="cmd-overlay" @click.self="close">
        <div class="cmd-panel">
          <div class="cmd-input-wrap">
            <svg class="cmd-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            <input
              ref="inputRef"
              v-model="query"
              class="cmd-input"
              :placeholder="t('cmd.placeholder')"
              @keydown="onKeydown"
            />
            <kbd class="cmd-esc">ESC</kbd>
          </div>
          <div class="cmd-list" v-if="filtered.length > 0">
            <button
              v-for="(cmd, i) in filtered"
              :key="cmd.id"
              class="cmd-item"
              :class="{ selected: i === selectedIndex }"
              @click="execute(cmd)"
              @mouseenter="selectedIndex = i"
            >
              <span class="cmd-label">{{ cmd.label }}</span>
              <kbd v-if="cmd.shortcut" class="cmd-shortcut">{{ cmd.shortcut }}</kbd>
            </button>
          </div>
          <div v-else class="cmd-empty">{{ t('common.noMatches') }}</div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.cmd-overlay { position: fixed; inset: 0; z-index: 2500; background: rgba(0,0,0,0.5); display: flex; justify-content: center; padding-top: 15vh; }
.cmd-panel { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); width: 480px; max-width: 90vw; max-height: 400px; box-shadow: 0 16px 48px rgba(0,0,0,0.5); overflow: hidden; display: flex; flex-direction: column; }
.cmd-input-wrap { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.cmd-search-icon { color: var(--text-muted); flex-shrink: 0; }
.cmd-input { flex: 1; background: none; border: none; color: var(--text-primary); font-size: 14px; outline: none; font-family: var(--font-sans); }
.cmd-input::placeholder { color: var(--text-muted); }
.cmd-esc { font-size: 10px; padding: 2px 6px; border-radius: 3px; background: var(--bg-surface); color: var(--text-muted); border: 1px solid var(--border); font-family: var(--font-mono); }
.cmd-list { overflow-y: auto; padding: 4px; }
.cmd-item { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 8px 12px; border: none; border-radius: var(--radius-sm); background: transparent; color: var(--text-secondary); font-size: 13px; cursor: pointer; text-align: left; }
.cmd-item.selected { background: var(--accent-dim); color: var(--accent); }
.cmd-item:hover { background: var(--bg-hover); }
.cmd-label { flex: 1; }
.cmd-shortcut { font-size: 11px; padding: 1px 6px; border-radius: 3px; background: var(--bg-surface); color: var(--text-muted); border: 1px solid var(--border); font-family: var(--font-mono); }
.cmd-empty { padding: 20px; text-align: center; font-size: 13px; color: var(--text-muted); }
.cmd-enter-active, .cmd-leave-active { transition: opacity 0.12s ease; }
.cmd-enter-from, .cmd-leave-to { opacity: 0; }
</style>
