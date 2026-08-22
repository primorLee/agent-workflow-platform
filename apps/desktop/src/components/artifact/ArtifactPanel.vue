<script setup lang="ts">
import { computed } from 'vue'
import { useArtifactStore } from '@/stores/artifact'

const artifacts = useArtifactStore()
const ordered = computed(() => artifacts.savedArtifacts)

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <aside class="artifact-panel" aria-label="Generated artifacts">
    <header class="artifact-header">
      <div>
        <strong>Generated artifacts</strong>
        <span>{{ ordered.length }} saved</span>
      </div>
      <div class="header-actions">
        <button type="button" @click="artifacts.toggleMaximize()">
          {{ artifacts.isMaximized ? 'Restore' : 'Maximize' }}
        </button>
        <button type="button" aria-label="Close artifacts" @click="artifacts.close()">×</button>
      </div>
    </header>

    <div v-if="ordered.length === 0" class="empty-state">
      Files created by agent tools will appear here. The artifact event path is
      the same one used by packaged desktop builds.
    </div>

    <ul v-else class="artifact-list">
      <li
        v-for="artifact in ordered"
        :key="artifact.id"
        :class="{ focused: artifact.id === artifacts.focusedArtifactId }"
        @click="artifacts.focusArtifact(artifact.id)"
      >
        <div class="artifact-main">
          <strong>{{ artifact.name }}</strong>
          <p v-if="artifact.description">{{ artifact.description }}</p>
          <small>{{ artifact.kind }} · {{ artifact.ext || 'file' }} · {{ formatBytes(artifact.size_bytes) }}</small>
        </div>
        <a :href="artifact.uri" @click.stop>Open</a>
      </li>
    </ul>

    <footer v-if="ordered.length" class="artifact-footer">
      <button type="button" @click="artifacts.clearArtifacts()">Clear list</button>
    </footer>
  </aside>
</template>

<style scoped>
.artifact-panel { height: 100%; display: flex; flex-direction: column; background: var(--bg-card); border-left: 1px solid var(--border); }
.artifact-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--border); }
.artifact-header > div:first-child { display: grid; gap: 2px; }
.artifact-header span, small { color: var(--text-secondary); font-size: 12px; }
.header-actions { display: flex; align-items: center; gap: 6px; }
button, a { border: 1px solid var(--border); border-radius: 7px; background: var(--bg-hover); color: var(--text-primary); padding: 5px 9px; font: inherit; cursor: pointer; text-decoration: none; }
.empty-state { margin: auto; max-width: 320px; padding: 24px; color: var(--text-secondary); line-height: 1.6; text-align: center; }
.artifact-list { list-style: none; margin: 0; padding: 12px; overflow: auto; display: grid; gap: 8px; }
.artifact-list li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-primary); cursor: pointer; }
.artifact-list li.focused { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary-soft); }
.artifact-main { min-width: 0; }
.artifact-main strong, .artifact-main p { overflow-wrap: anywhere; }
.artifact-main p { margin: 5px 0; color: var(--text-secondary); font-size: 13px; }
.artifact-footer { margin-top: auto; padding: 12px 16px; border-top: 1px solid var(--border); }
</style>