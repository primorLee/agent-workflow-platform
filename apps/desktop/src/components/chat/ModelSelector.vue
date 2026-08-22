<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import type { ChatModel } from '@/api/types'

const props = defineProps<{
  models: ChatModel[]
  modelValue: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const open = ref(false)
const dropdownRef = ref<HTMLDivElement | null>(null)

function toggle() {
  open.value = !open.value
}

function select(id: string) {
  emit('update:modelValue', id)
  open.value = false
}

function currentModelName(): string {
  const m = props.models.find(m => m.id === props.modelValue)
  // 兜底文案只允许产品名（UI 禁词红线：不渲染任何内部模型名）。
  return m?.name || 'Agent Workflow Platform'
}

function onClickOutside(e: MouseEvent) {
  if (dropdownRef.value && !dropdownRef.value.contains(e.target as Node)) {
    open.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', onClickOutside, true)
})
onUnmounted(() => {
  document.removeEventListener('click', onClickOutside, true)
})
</script>

<template>
  <div ref="dropdownRef" class="model-selector">
    <button class="model-trigger" @click="toggle">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/></svg>
      <span class="model-name">{{ currentModelName() }}</span>
      <svg class="chevron" :class="{ rotated: open }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <Transition name="dropdown">
      <div v-if="open" class="model-dropdown">
        <button
          v-for="m in models"
          :key="m.id"
          class="model-option"
          :class="{ selected: m.id === modelValue }"
          @click="select(m.id)"
        >
          <div class="option-left">
            <span class="option-name">{{ m.name }}</span>
            <span class="option-desc">{{ m.description }}</span>
          </div>
          <svg v-if="m.id === modelValue" class="check-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.model-selector {
  position: relative;
  display: inline-flex;
}

.model-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  height: 30px;
  background: var(--bg-hover, #22223a);
  border: none;
  border-radius: 8px;
  color: var(--text-secondary, #ccccdd);
  font-family: 'Inter', system-ui, sans-serif;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
  user-select: none;
}
.model-trigger:hover {
  background: var(--bg-surface, #2a2a4a);
}
.model-trigger svg {
  color: var(--text-muted, #8888aa);
  flex-shrink: 0;
}
.model-name {
  white-space: nowrap;
}
.chevron {
  transition: transform 0.2s;
}
.chevron.rotated {
  transform: rotate(180deg);
}

/* Dropdown */
.model-dropdown {
  position: absolute;
  top: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  min-width: 260px;
  background: var(--bg-surface, #1e1e36);
  border: 1px solid var(--border, #2a2a4a);
  border-radius: 10px;
  padding: 4px;
  z-index: 1000;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}

.model-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 8px 12px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary, #ccccdd);
  font-family: 'Inter', system-ui, sans-serif;
  cursor: pointer;
  text-align: left;
  transition: background 0.12s;
}
.model-option:hover {
  background: var(--bg-hover, #2a2a4a);
}
.model-option.selected {
  background: var(--accent-dim, #6c63ff22);
}

.option-left {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.option-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary, #eee);
}
.option-desc {
  font-size: 11px;
  color: var(--text-muted, #8888aa);
}

.check-icon {
  color: var(--accent, #6c63ff);
  flex-shrink: 0;
}

/* Transition */
.dropdown-enter-active,
.dropdown-leave-active {
  transition: opacity 0.15s, transform 0.15s;
}
.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-4px);
}
.dropdown-enter-to,
.dropdown-leave-from {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}
</style>
