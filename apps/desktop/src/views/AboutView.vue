<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConnectionStore } from '@/stores/connection'
import { api } from '@/api/client'
import { runtime } from '@/bridge'

declare const __APP_VERSION__: string

const { t } = useI18n()
const connection = useConnectionStore()
const platformName = typeof navigator !== 'undefined' ? navigator.platform : 'unknown'
// `__APP_VERSION__` is a Vite `define` compile-time constant; it only gets
// replaced in <script> JS, not inside Vue template expressions (those compile
// to `_ctx.__APP_VERSION__` lookups which are undefined at runtime). Bind the
// value to a const here so the template can reference it normally.
// If Vite's define fails to inject, show '?' not a fake "0.1.0" that would
// mislead users about their actual build.
const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '?'
const changelogs = ref<Array<{ version: string; title: string; body: string; published_at: string }>>([])
const loadingChangelog = ref(true)

const modules = [
  { nameKey: 'about.moduleSessions', tech: 'Durable state', status: 'Active' },
  { nameKey: 'about.moduleStreaming', tech: 'SSE', status: 'Active' },
  { nameKey: 'about.moduleRemote', tech: 'SSH / Agent', status: 'Active' },
  { nameKey: 'about.moduleArtifacts', tech: 'Electron', status: 'Active' },
  { nameKey: 'about.moduleAi', tech: 'MCP', status: 'Active' },
]

const deps = [
  { name: 'electron', version: '37' },
  { name: '@modelcontextprotocol/sdk', version: '1' },
  { name: 'ssh2', version: '1' },
  { name: 'vue', version: '3' },
  { name: 'pinia', version: '3' },
]
const shortcuts = [
  { keys: 'Ctrl+S', actionKey: 'about.shortcutSave' },
  { keys: 'Ctrl+Z / Ctrl+Y', actionKey: 'about.shortcutUndoRedo' },
  { keys: 'Ctrl+Shift+P', actionKey: 'about.shortcutCommandPalette' },
  { keys: '?', actionKey: 'about.shortcutPanel' },
]

onMounted(async () => {
  try {
    changelogs.value = await api.get<Array<{ version: string; title: string; body: string; published_at: string }>>('/v1/changelog', { limit: '5' })
  } catch {
    // changelog not available
  } finally {
    loadingChangelog.value = false
  }
})
</script>

<template>
  <div class="about-page">
    <!-- Product Info -->
    <section class="about-card">
      <h2 class="about-title">Agent Workflow Platform Desktop</h2>
      <div class="product-version">v{{ appVersion }}</div>
      <p class="product-tagline">{{ t('about.tagline') }}</p>
      <div class="tech-stack">
        <span class="tech-badge">Vue 3</span>
        <span class="tech-badge">TypeScript</span>
        <span class="tech-badge">{{ runtime === 'electron' ? 'Electron' : 'pywebview' }}</span>
        <span class="tech-badge">FastAPI</span>
      </div>
      <div class="version-grid">
        <div class="version-item">
          <span class="version-label">Server</span>
          <span class="version-value">{{ connection.serverVersion || 'N/A' }}</span>
        </div>
        <div class="version-item">
          <span class="version-label">Platform</span>
          <span class="version-value">{{ platformName }}</span>
        </div>
      </div>
    </section>

    <!-- Feature Modules -->
    <section class="about-card">
      <h3 class="section-title">{{ t('about.featureModules') }}</h3>
      <div class="module-list">
        <div v-for="m in modules" :key="m.nameKey" class="module-row">
          <span class="module-name">{{ t(m.nameKey) }}</span>
          <span class="module-tech">{{ m.tech }}</span>
          <span class="module-status" :class="m.status.toLowerCase()">{{ m.status }}</span>
        </div>
      </div>
    </section>

    <!-- Dependencies -->
    <section class="about-card">
      <h3 class="section-title">{{ t('about.coreDependencies') }}</h3>
      <div class="dep-grid">
        <div v-for="d in deps" :key="d.name" class="dep-item">
          <span class="dep-name">{{ d.name }}</span>
          <span class="dep-ver">{{ d.version }}</span>
        </div>
      </div>
    </section>

    <!-- Keyboard Shortcuts -->
    <section class="about-card">
      <h3 class="section-title">{{ t('about.shortcutSummary') }}</h3>
      <div class="shortcut-list">
        <div v-for="s in shortcuts" :key="s.keys" class="shortcut-row">
          <kbd class="shortcut-keys">{{ s.keys }}</kbd>
          <span class="shortcut-action">{{ t(s.actionKey) }}</span>
        </div>
      </div>
      <p class="shortcut-hint">{{ t('about.shortcutHint', { key: '?' }) }}</p>
    </section>

    <!-- Release Notes -->
    <section class="about-card">
      <h3 class="section-title">{{ t('about.releaseNotes') }}</h3>
      <div v-if="loadingChangelog" class="changelog-loading">{{ t('about.loadingChangelog') }}</div>
      <div v-else-if="changelogs.length === 0" class="changelog-empty">{{ t('about.noReleaseNotes') }}</div>
      <div v-else class="changelog-list">
        <div v-for="entry in changelogs" :key="entry.version" class="changelog-entry">
          <div class="changelog-header">
            <span class="changelog-version">v{{ entry.version }}</span>
            <span class="changelog-date">{{ entry.published_at?.slice(0, 10) }}</span>
          </div>
          <div v-if="entry.title" class="changelog-title">{{ entry.title }}</div>
          <div v-if="entry.body" class="changelog-body">{{ entry.body }}</div>
        </div>
      </div>
    </section>

    <!-- License & Footer -->
    <section class="about-card about-footer">
      <p class="about-license">{{ t('about.license') }}</p>
      <p>{{ t('about.platformTagline') }}</p>
      <p class="about-copyright">&copy; 2026 Agent Workflow Platform. Released under the MIT License.</p>
    </section>
  </div>
</template>

<style scoped>
.about-page { max-width: 640px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
.about-card { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; }
.about-title { font-size: 22px; font-weight: 700; color: var(--accent); margin: 0; }
.product-version { font-size: 14px; font-family: var(--font-mono); color: var(--text-muted); margin-top: 4px; }
.product-tagline { font-size: 14px; color: var(--text-secondary); margin: 12px 0; line-height: 1.5; }
.tech-stack { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.tech-badge {
  font-size: 11px; font-family: var(--font-mono); color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
  border-radius: 4px; padding: 2px 8px;
}
.section-title { font-size: 15px; font-weight: 600; color: var(--text-primary); margin: 0 0 12px; }
.version-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.version-item { display: flex; flex-direction: column; gap: 2px; }
.version-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
.version-value { font-size: 14px; color: var(--text-primary); font-family: var(--font-mono); }

/* Modules */
.module-list { display: flex; flex-direction: column; gap: 8px; }
.module-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.module-name { flex: 1; color: var(--text-primary); font-weight: 500; }
.module-tech { color: var(--text-muted); font-family: var(--font-mono); font-size: 12px; }
.module-status {
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em;
  padding: 1px 8px; border-radius: 3px;
}
.module-status.active { color: #22c55e; background: rgba(34, 197, 94, 0.1); }
.module-status.beta { color: #f59e0b; background: rgba(245, 158, 11, 0.1); }

/* Dependencies */
.dep-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.dep-item { display: flex; justify-content: space-between; align-items: center; font-size: 12px; }
.dep-name { color: var(--text-secondary); font-family: var(--font-mono); }
.dep-ver { color: var(--text-muted); font-family: var(--font-mono); }

/* Shortcuts */
.shortcut-list { display: flex; flex-direction: column; gap: 8px; }
.shortcut-row { display: flex; align-items: center; gap: 12px; font-size: 13px; }
.shortcut-keys {
  font-family: var(--font-mono); font-size: 12px;
  background: var(--bg-primary); border: 1px solid var(--border);
  border-radius: 4px; padding: 2px 6px; color: var(--text-primary);
  min-width: 120px; text-align: center;
}
.shortcut-action { color: var(--text-secondary); }
.shortcut-hint { font-size: 12px; color: var(--text-muted); margin: 12px 0 0; }
.shortcut-hint kbd {
  font-family: var(--font-mono); background: var(--bg-primary);
  border: 1px solid var(--border); border-radius: 3px; padding: 0 4px;
}

/* Changelog */
.changelog-loading, .changelog-empty { font-size: 13px; color: var(--text-muted); padding: 12px 0; }
.changelog-list { display: flex; flex-direction: column; gap: 14px; }
.changelog-entry { border-left: 2px solid var(--accent); padding-left: 12px; }
.changelog-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.changelog-version { font-size: 13px; font-weight: 600; color: var(--accent); font-family: var(--font-mono); }
.changelog-date { font-size: 12px; color: var(--text-muted); }
.changelog-title { font-size: 14px; font-weight: 500; color: var(--text-primary); margin-bottom: 4px; }
.changelog-body { font-size: 13px; color: var(--text-secondary); line-height: 1.5; white-space: pre-line; }

/* Footer */
.about-footer { text-align: center; }
.about-footer p { font-size: 13px; color: var(--text-secondary); margin: 0; }
.about-license { font-size: 12px; color: var(--text-muted); margin-bottom: 8px !important; }
.about-copyright { font-size: 12px; color: var(--text-muted); margin-top: 4px !important; }
</style>
