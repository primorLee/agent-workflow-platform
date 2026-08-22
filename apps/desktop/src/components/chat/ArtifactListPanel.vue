<script setup lang="ts">
/**
 * ArtifactListPanel — renders the files produced by the cloud sandbox
 * for the active conversation and lets the user download them.
 *
 * Data model lives in `stores/chat_artifacts.ts`, which also handles the
 * live SSE subscription to `artifact_created` events. This component is
 * purely presentational: mount it wherever makes sense in the layout and
 * it re-renders as items flow in.
 */
import { computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useChatArtifactsStore } from '@/stores/chat_artifacts'
import type { ChatArtifact } from '@/types/artifact'
import { useChatStore } from '@/stores/chat'
import { useToastStore } from '@/stores/toast'

const store = useChatArtifactsStore()
const chatStore = useChatStore()
const toast = useToastStore()
const { t } = useI18n()

const currentConvId = computed<string | undefined>(() => chatStore.currentConversationId ?? undefined)

function shortName(p: string): string {
  if (!p) return ''
  return p.split('/').pop() || p
}

function formatSize(n?: number): string {
  if (!n || n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function sizeOf(a: ChatArtifact): number | undefined {
  return a.size ?? a.size_bytes
}

async function onDownload(a: ChatArtifact): Promise<void> {
  try {
    await store.downloadAndSave(a)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    toast.error(t('chatArtifacts.downloadFailed', { msg }))
  }
}

function refresh(): void {
  store.load(currentConvId.value)
}

onMounted(() => {
  store.load(currentConvId.value)
})

// When the user switches conversation, re-scope the panel.
watch(currentConvId, (id) => {
  store.load(id)
})
</script>

<template>
  <div class="artifact-list-panel">
<div class="al-header">
      <span class="al-title">📎 {{ t('chatArtifacts.title') }} ({{ store.count }})</span>
      <button class="al-refresh" :title="t('chatArtifacts.refresh')" @click="refresh">⟳</button>
    </div>

    <div v-if="store.loading && store.items.length === 0" class="al-loading">
      {{ t('chatArtifacts.loading') }}
    </div>

    <div v-else-if="store.items.length === 0" class="al-empty">
      {{ t('chatArtifacts.empty') }}
    </div>

    <ul v-else class="al-items">
      <li v-for="art in store.items" :key="art.id" class="al-item">
        <div class="al-item-main">
          <span class="al-filename" :title="art.filename">{{ shortName(art.filename) }}</span>
          <span class="al-size">{{ formatSize(sizeOf(art)) }}</span>
        </div>
        <button class="al-dl-btn" :title="t('chatArtifacts.download')" @click="onDownload(art)">⬇</button>
      </li>
    </ul>

    <div v-if="store.error" class="al-error">{{ store.error }}</div>
  </div>
</template>

<style scoped>
.artifact-list-panel {
  padding: 10px 12px;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--text-primary);
}

.al-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.al-title {
  font-weight: 600;
  font-size: 12px;
  color: var(--text-secondary);
}

.al-refresh {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 14px;
  color: var(--text-muted);
  padding: 2px 6px;
  border-radius: 4px;
}

.al-refresh:hover {
  background: var(--bg-hover, rgba(0, 0, 0, 0.05));
  color: var(--text-primary);
}

.al-loading,
.al-empty {
  color: var(--text-muted);
  font-size: 12px;
  padding: 10px 2px;
}

.al-items {
  list-style: none;
  padding: 0;
  margin: 0;
  max-height: 260px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.al-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 8px;
  border-radius: 6px;
  gap: 8px;
}

.al-item:hover {
  background: var(--bg-hover, rgba(0, 0, 0, 0.04));
}

.al-item-main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.al-filename {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}

.al-size {
  color: var(--text-muted);
  font-size: 11px;
  margin-top: 1px;
}

.al-dl-btn {
  background: none;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 8px;
  cursor: pointer;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.al-dl-btn:hover {
  background: var(--bg-hover, rgba(0, 0, 0, 0.05));
  color: var(--text-primary);
}

.al-error {
  font-size: 11px;
  color: var(--danger, #dc2626);
  padding: 4px 2px;
  word-break: break-word;
}
</style>
