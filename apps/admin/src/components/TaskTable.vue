<script setup lang="ts">
import { computed, ref } from 'vue'

import type { TaskRecord } from '@/api/normalizers'

const props = defineProps<{
  tasks: TaskRecord[]
  selectedId: string | null
  loading: boolean
  error: string | null
}>()

const emit = defineEmits<{
  select: [taskId: string]
  retry: []
}>()

const query = ref('')
const status = ref('all')

const statuses = computed(() => [...new Set(props.tasks.map((task) => task.status))].sort())
const filteredTasks = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return props.tasks.filter((task) => {
    const matchesStatus = status.value === 'all' || task.status === status.value
    const haystack = `${task.id} ${task.type} ${task.assignedAgentId ?? ''}`.toLowerCase()
    return matchesStatus && (!needle || haystack.includes(needle))
  })
})

function formatWhen(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function badgeTone(value: string): string {
  if (['success', 'completed'].includes(value)) return 'success'
  if (['failed', 'error', 'cancelled'].includes(value)) return 'danger'
  if (value === 'running') return 'info'
  if (value === 'pending') return 'warning'
  return 'neutral'
}
</script>

<template>
  <section class="panel task-panel" aria-labelledby="tasks-title">
    <header class="panel-header">
      <div>
        <p class="section-kicker">TASK LIFECYCLE</p>
        <h2 id="tasks-title">Tasks <span>{{ tasks.length }}</span></h2>
      </div>
      <span v-if="loading" class="loading-copy">Refreshing…</span>
    </header>

    <div class="toolbar">
      <label class="search-field">
        <span class="sr-only">Search tasks</span>
        <input v-model="query" type="search" placeholder="Search ID, type, or agent" />
      </label>
      <label>
        <span class="sr-only">Filter by status</span>
        <select v-model="status">
          <option value="all">All statuses</option>
          <option v-for="item in statuses" :key="item" :value="item">{{ item }}</option>
        </select>
      </label>
    </div>

    <div v-if="error" class="inline-error" role="alert">
      <span>{{ error }}</span>
      <button type="button" @click="emit('retry')">Retry</button>
    </div>

    <div v-if="!loading && !error && tasks.length === 0" class="empty-state">
      <div class="empty-icon">0</div>
      <strong>No tasks yet</strong>
      <p>Create a task through <code>POST /v1/tasks</code>; it will appear here on refresh.</p>
    </div>

    <div v-else-if="!error && filteredTasks.length === 0" class="empty-state compact">
      <strong>No matching tasks</strong>
      <p>Clear the search or choose another status.</p>
    </div>

    <div v-else class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Type</th>
            <th>Task ID</th>
            <th>Created</th>
            <th>Agent</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="task in filteredTasks"
            :key="task.id"
            :class="{ selected: task.id === selectedId }"
            tabindex="0"
            @click="emit('select', task.id)"
            @keydown.enter="emit('select', task.id)"
          >
            <td><span class="badge" :class="`badge-${badgeTone(task.status)}`">{{ task.status }}</span></td>
            <td class="task-type">{{ task.type }}</td>
            <td><code>{{ task.id }}</code></td>
            <td class="muted">{{ formatWhen(task.createdAt) }}</td>
            <td><code>{{ task.assignedAgentId ?? 'unassigned' }}</code></td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.panel { min-width: 0; border: 1px solid var(--border); border-radius: 16px; background: var(--bg-panel); box-shadow: var(--shadow-sm); overflow: hidden; }
.panel-header { display: flex; align-items: end; justify-content: space-between; gap: 16px; padding: 19px 20px 14px; }
.section-kicker { color: var(--accent); font-size: 10px; font-weight: 800; letter-spacing: .14em; }
h2 { margin-top: 3px; font-size: 19px; letter-spacing: -.02em; }
h2 span { color: var(--text-muted); font: 500 12px var(--font-mono); }
.loading-copy { color: var(--text-muted); font-size: 12px; }
.toolbar { display: grid; grid-template-columns: minmax(180px, 1fr) 160px; gap: 9px; padding: 0 20px 14px; }
input, select { width: 100%; height: 36px; padding: 0 11px; border: 1px solid var(--input-border); border-radius: 9px; background: var(--bg-surface); color: var(--text-primary); outline: none; }
input:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-dim); }
.table-scroll { min-height: 260px; max-height: 520px; overflow: auto; border-top: 1px solid var(--border); }
table { width: 100%; border-collapse: collapse; }
th { position: sticky; top: 0; z-index: 1; padding: 10px 13px; background: var(--bg-panel); color: var(--text-muted); font-size: 10px; text-align: left; text-transform: uppercase; letter-spacing: .06em; }
td { max-width: 260px; padding: 12px 13px; border-top: 1px solid var(--border-soft); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
tbody tr { cursor: pointer; outline: none; transition: background .14s; }
tbody tr:hover, tbody tr:focus { background: var(--bg-hover); }
tbody tr.selected { background: var(--accent-dim); box-shadow: inset 3px 0 var(--accent); }
.task-type { font-weight: 700; }
.muted { color: var(--text-secondary); }
code { color: var(--text-secondary); font: 500 11px var(--font-mono); }
.inline-error { margin: 0 20px 16px; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 13px; border: 1px solid var(--danger-border); border-radius: 10px; background: var(--danger-bg); color: var(--danger); font-size: 12px; }
.inline-error button { border: 0; background: none; color: inherit; font-weight: 700; cursor: pointer; }
.empty-state { min-height: 310px; display: grid; place-items: center; align-content: center; gap: 7px; padding: 30px; color: var(--text-secondary); text-align: center; }
.empty-state.compact { min-height: 220px; }
.empty-state p { max-width: 440px; color: var(--text-muted); font-size: 12px; }
.empty-icon { width: 42px; height: 42px; display: grid; place-items: center; border: 1px dashed var(--border-strong); border-radius: 13px; color: var(--text-muted); font: 700 14px var(--font-mono); }
@media (max-width: 620px) { .toolbar { grid-template-columns: 1fr; } th:nth-child(4), td:nth-child(4), th:nth-child(5), td:nth-child(5) { display: none; } }
</style>
