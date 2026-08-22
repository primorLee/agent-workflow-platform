<script setup lang="ts">
import type { SessionRecord } from '@/api/normalizers'

defineProps<{
  sessions: SessionRecord[]
  loading: boolean
  error: string | null
}>()

defineEmits<{ retry: [] }>()

function formatWhen(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value.endsWith('Z') || value.includes('+') ? value : `${value}Z`)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function resourceSummary(resources: Record<string, unknown>): string {
  const cpu = typeof resources.cpu_limit === 'number' ? `${resources.cpu_limit} CPU` : null
  const memory = typeof resources.mem_limit_mb === 'number' ? `${resources.mem_limit_mb} MB` : null
  return [cpu, memory].filter(Boolean).join(' · ') || 'No limits reported'
}
</script>

<template>
  <section class="panel" aria-labelledby="sessions-title">
    <header class="panel-header">
      <div>
        <p class="section-kicker">ACTIVE WORK</p>
        <h2 id="sessions-title">Sessions <span>{{ sessions.length }}</span></h2>
      </div>
      <span v-if="loading" class="loading-copy">Refreshing…</span>
    </header>

    <div v-if="error" class="inline-error" role="alert">
      <span>{{ error }}</span>
      <button type="button" @click="$emit('retry')">Retry</button>
    </div>

    <div v-if="!loading && !error && sessions.length === 0" class="empty-state">
      <strong>No active sessions</strong>
      <p>The API only returns non-terminated sessions for the connected local identity.</p>
    </div>

    <ul v-else class="session-list">
      <li v-for="session in sessions" :key="session.id">
        <div class="session-topline">
          <span class="session-type">{{ session.type }}</span>
          <span class="badge" :class="session.status === 'active' ? 'badge-success' : 'badge-neutral'">{{ session.status }}</span>
        </div>
        <code :title="session.id">{{ session.id }}</code>
        <dl>
          <div>
            <dt>Heartbeat</dt>
            <dd>{{ formatWhen(session.lastHeartbeat) }}</dd>
          </div>
          <div>
            <dt>Resources</dt>
            <dd>{{ resourceSummary(session.resources) }}</dd>
          </div>
        </dl>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.panel { min-width: 0; border: 1px solid var(--border); border-radius: 16px; background: var(--bg-panel); box-shadow: var(--shadow-sm); overflow: hidden; }
.panel-header { display: flex; align-items: end; justify-content: space-between; gap: 12px; padding: 19px 20px 14px; border-bottom: 1px solid var(--border); }
.section-kicker { color: var(--accent); font-size: 10px; font-weight: 800; letter-spacing: .14em; }
h2 { margin-top: 3px; font-size: 19px; letter-spacing: -.02em; }
h2 span { color: var(--text-muted); font: 500 12px var(--font-mono); }
.loading-copy { color: var(--text-muted); font-size: 12px; }
.inline-error { margin: 14px; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; border: 1px solid var(--danger-border); border-radius: 9px; background: var(--danger-bg); color: var(--danger); font-size: 12px; }
.inline-error button { border: 0; background: none; color: inherit; font-weight: 700; cursor: pointer; }
.session-list { max-height: 360px; overflow: auto; list-style: none; }
.session-list li { padding: 15px 18px; border-top: 1px solid var(--border-soft); }
.session-list li:first-child { border-top: 0; }
.session-topline { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.session-type { font-weight: 750; text-transform: capitalize; }
code { display: block; margin-top: 5px; overflow: hidden; color: var(--text-muted); font: 500 11px var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
dl { display: grid; gap: 6px; margin-top: 12px; }
dl div { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
dt { color: var(--text-muted); font-size: 10px; text-transform: uppercase; letter-spacing: .05em; }
dd { color: var(--text-secondary); font-size: 11px; text-align: right; }
.empty-state { min-height: 180px; display: grid; place-items: center; align-content: center; gap: 6px; padding: 28px; text-align: center; }
.empty-state p { color: var(--text-muted); font-size: 12px; }
</style>
