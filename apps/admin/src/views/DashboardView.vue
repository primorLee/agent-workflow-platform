<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { clearConnection, configuredApiUrl } from '@/api/controlPlane'
import HealthOverview from '@/components/HealthOverview.vue'
import SessionTable from '@/components/SessionTable.vue'
import TaskDetailPanel from '@/components/TaskDetailPanel.vue'
import TaskTable from '@/components/TaskTable.vue'
import { useMonitorStore } from '@/stores/monitor'

const props = defineProps<{
  theme: string
  toggleTheme: () => void
}>()

const router = useRouter()
const monitor = useMonitorStore()
const autoRefresh = ref(true)
const apiUrl = configuredApiUrl()
let refreshTimer: number | null = null

const updatedLabel = computed(() => {
  if (!monitor.lastUpdatedAt) return 'Not refreshed yet'
  return `Updated ${monitor.lastUpdatedAt.toLocaleTimeString()}`
})

const summaries = computed(() => [
  { label: 'Total', value: monitor.taskCounts.total || 0 },
  { label: 'Pending', value: monitor.taskCounts.pending || 0 },
  { label: 'Running', value: monitor.taskCounts.running || 0 },
  { label: 'Succeeded', value: (monitor.taskCounts.success || 0) + (monitor.taskCounts.completed || 0) },
  { label: 'Failed', value: (monitor.taskCounts.failed || 0) + (monitor.taskCounts.error || 0) },
])

function syncTimer(): void {
  if (refreshTimer !== null) {
    window.clearInterval(refreshTimer)
    refreshTimer = null
  }
  if (autoRefresh.value) {
    refreshTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !monitor.refreshing) void monitor.refreshAll()
    }, 15_000)
  }
}

async function disconnect(): Promise<void> {
  clearConnection()
  monitor.reset()
  await router.replace({ name: 'connect' })
}

onMounted(async () => {
  if (!monitor.initialize()) {
    await router.replace({ name: 'connect' })
    return
  }
  await monitor.refreshAll()
  syncTimer()
})

watch(autoRefresh, syncTimer)
onBeforeUnmount(() => {
  if (refreshTimer !== null) window.clearInterval(refreshTimer)
})
</script>

<template>
  <main class="dashboard">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">AWP</div>
        <div>
          <strong>Control-plane monitor</strong>
          <span :title="apiUrl">{{ apiUrl }}</span>
        </div>
      </div>

      <div class="topbar-actions">
        <label class="auto-refresh">
          <input v-model="autoRefresh" type="checkbox" />
          <span>Auto 15s</span>
        </label>
        <button type="button" class="button" :disabled="monitor.refreshing" @click="monitor.refreshAll">
          {{ monitor.refreshing ? 'Refreshing…' : 'Refresh now' }}
        </button>
        <button type="button" class="button icon-button" :aria-label="`Use ${theme === 'dark' ? 'light' : 'dark'} theme`" @click="props.toggleTheme">
          {{ theme === 'dark' ? '☀' : '◐' }}
        </button>
        <button type="button" class="button disconnect-button" @click="disconnect">Disconnect</button>
      </div>
    </header>

    <div class="content">
      <section class="overview-bar" aria-label="Task summary">
        <div>
          <p class="eyebrow">LIVE LOCAL STATE</p>
          <h1>Workflow operations</h1>
          <p class="subtitle">A read-only view of the actual task and session stores.</p>
        </div>
        <div class="summary-wrap">
          <div v-for="item in summaries" :key="item.label" class="summary-item">
            <strong>{{ item.value }}</strong>
            <span>{{ item.label }}</span>
          </div>
          <p class="updated-label">{{ updatedLabel }}</p>
        </div>
      </section>

      <HealthOverview
        :health="monitor.health"
        :loading="monitor.pending.health"
        :error="monitor.errors.health"
        @retry="monitor.refreshHealth"
      />

      <div class="workspace-grid">
        <TaskTable
          :tasks="monitor.tasks"
          :selected-id="monitor.selectedTaskId"
          :loading="monitor.pending.tasks"
          :error="monitor.errors.tasks"
          @select="monitor.selectTask"
          @retry="monitor.refreshTasks"
        />

        <aside class="side-stack">
          <SessionTable
            :sessions="monitor.sessions"
            :loading="monitor.pending.sessions"
            :error="monitor.errors.sessions"
            @retry="monitor.refreshSessions"
          />
          <TaskDetailPanel :task="monitor.selectedTask" @close="monitor.selectTask(null)" />
        </aside>
      </div>
    </div>
  </main>
</template>

<style scoped>
.dashboard { min-height: 100vh; }
.topbar { position: sticky; top: 0; z-index: 20; min-height: 68px; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 12px clamp(18px, 4vw, 42px); border-bottom: 1px solid var(--border); background: var(--topbar-bg); backdrop-filter: blur(18px); }
.brand { min-width: 0; display: flex; align-items: center; gap: 11px; }
.brand-mark { width: 36px; height: 36px; flex: 0 0 auto; display: grid; place-items: center; border-radius: 10px; background: var(--accent); color: white; font-size: 11px; font-weight: 850; letter-spacing: -.04em; }
.brand div:last-child { min-width: 0; display: grid; }
.brand strong { font-size: 13px; }
.brand span { max-width: 360px; overflow: hidden; color: var(--text-muted); font: 500 10px var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
.topbar-actions { display: flex; align-items: center; gap: 8px; }
.auto-refresh { display: flex; align-items: center; gap: 7px; padding: 7px 9px; color: var(--text-secondary); font-size: 11px; cursor: pointer; }
.auto-refresh input { accent-color: var(--accent); }
.button { min-height: 36px; padding: 0 12px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg-panel); color: var(--text-primary); font: 650 11px var(--font-sans); cursor: pointer; }
.button:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
.button:disabled { opacity: .55; cursor: wait; }
.icon-button { width: 36px; padding: 0; font-size: 15px; }
.disconnect-button { color: var(--text-secondary); }
.content { width: min(1500px, 100%); display: grid; gap: 26px; margin: 0 auto; padding: 30px clamp(18px, 4vw, 42px) 50px; }
.overview-bar { display: flex; align-items: end; justify-content: space-between; gap: 28px; padding: 7px 0 2px; }
.eyebrow { color: var(--accent); font-size: 10px; font-weight: 800; letter-spacing: .15em; }
h1 { margin-top: 4px; font-size: clamp(27px, 4vw, 38px); letter-spacing: -.045em; }
.subtitle { margin-top: 5px; color: var(--text-muted); font-size: 13px; }
.summary-wrap { display: flex; align-items: center; justify-content: end; gap: 8px; flex-wrap: wrap; }
.summary-item { min-width: 72px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 11px; background: var(--bg-panel); text-align: center; }
.summary-item strong { display: block; font: 750 17px var(--font-mono); }
.summary-item span { color: var(--text-muted); font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
.updated-label { width: 100%; color: var(--text-muted); font-size: 10px; text-align: right; }
.workspace-grid { min-width: 0; display: grid; grid-template-columns: minmax(0, 1.8fr) minmax(300px, .8fr); align-items: start; gap: 16px; }
.side-stack { min-width: 0; display: grid; gap: 16px; }
@media (max-width: 1040px) { .workspace-grid { grid-template-columns: 1fr; } .side-stack { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 760px) { .topbar { position: static; align-items: flex-start; flex-direction: column; } .topbar-actions { width: 100%; flex-wrap: wrap; } .overview-bar { align-items: flex-start; flex-direction: column; } .summary-wrap { justify-content: start; } .updated-label { text-align: left; } .side-stack { grid-template-columns: 1fr; } }
@media (max-width: 480px) { .auto-refresh { order: 4; } .disconnect-button { margin-left: auto; } }
</style>
