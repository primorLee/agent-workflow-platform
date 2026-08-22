<script setup lang="ts">
import { computed } from 'vue'

import type { HealthSnapshot } from '@/api/controlPlane'

const props = defineProps<{
  health: HealthSnapshot | null
  loading: boolean
  error: string | null
}>()

defineEmits<{ retry: [] }>()

const brokerTone = computed(() => {
  const broker = props.health?.broker
  if (!broker) return 'neutral'
  if (broker.fallbackTriggered) return 'warning'
  if (broker.backend === 'memory') return 'good'
  return broker.redisConnected ? 'good' : 'bad'
})

const brokerDetail = computed(() => {
  const broker = props.health?.broker
  if (!broker) return 'Waiting for readiness probe'
  if (broker.backend === 'memory') return 'Single-process in-memory broker'
  if (broker.redisConnected) {
    return broker.lastPingMs === null ? 'Redis connected' : `Redis ping ${broker.lastPingMs} ms`
  }
  return 'Redis is not connected'
})
</script>

<template>
  <section class="health-section" aria-labelledby="health-title">
    <div class="section-heading">
      <div>
        <p class="section-kicker">READINESS</p>
        <h2 id="health-title">Control-plane health</h2>
      </div>
      <span v-if="loading" class="loading-label"><span class="spinner"></span> Probing</span>
    </div>

    <div v-if="error" class="inline-error" role="alert">
      <span>{{ error }}</span>
      <button type="button" @click="$emit('retry')">Retry</button>
    </div>

    <div class="health-grid" :class="{ stale: error && health }">
      <article class="health-card">
        <div class="card-topline">
          <span class="card-label">HTTP service</span>
          <span class="status-dot" :class="health?.live === 'ok' ? 'good' : 'neutral'"></span>
        </div>
        <strong>{{ health?.live ?? 'Unknown' }}</strong>
        <p>Liveness endpoint</p>
      </article>

      <article class="health-card">
        <div class="card-topline">
          <span class="card-label">Application</span>
          <span class="status-dot" :class="health?.status === 'ok' ? 'good' : 'neutral'"></span>
        </div>
        <strong>{{ health?.status ?? 'Unknown' }}</strong>
        <p>Readiness endpoint</p>
      </article>

      <article class="health-card">
        <div class="card-topline">
          <span class="card-label">Database</span>
          <span class="status-dot" :class="health?.database === 'ok' ? 'good' : 'neutral'"></span>
        </div>
        <strong>{{ health?.database ?? 'Unknown' }}</strong>
        <p>SQLite connectivity check</p>
      </article>

      <article class="health-card">
        <div class="card-topline">
          <span class="card-label">Broker</span>
          <span class="status-dot" :class="brokerTone"></span>
        </div>
        <strong>{{ health?.broker.backend ?? 'Unknown' }}</strong>
        <p>{{ brokerDetail }}</p>
      </article>
    </div>
  </section>
</template>

<style scoped>
.health-section { display: grid; gap: 14px; }
.section-heading { display: flex; align-items: end; justify-content: space-between; gap: 16px; }
.section-kicker { color: var(--accent); font-size: 10px; font-weight: 800; letter-spacing: 0.14em; }
h2 { margin-top: 3px; font-size: 19px; letter-spacing: -0.02em; }
.loading-label { color: var(--text-muted); font-size: 12px; }
.spinner { display: inline-block; width: 10px; height: 10px; border: 2px solid var(--border-strong); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
.health-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.health-grid.stale { opacity: .72; }
.health-card { min-width: 0; padding: 17px; border: 1px solid var(--border); border-radius: 14px; background: var(--bg-panel); box-shadow: var(--shadow-sm); }
.card-topline { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.card-label { color: var(--text-muted); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); box-shadow: 0 0 0 4px var(--bg-hover); }
.status-dot.good { background: var(--success); box-shadow: 0 0 0 4px var(--success-bg); }
.status-dot.warning { background: var(--warning); box-shadow: 0 0 0 4px var(--warning-bg); }
.status-dot.bad { background: var(--danger); box-shadow: 0 0 0 4px var(--danger-bg); }
.health-card strong { display: block; margin-top: 15px; overflow: hidden; color: var(--text-primary); font: 700 20px var(--font-mono); text-overflow: ellipsis; text-transform: capitalize; }
.health-card p { margin-top: 4px; color: var(--text-muted); font-size: 11px; }
.inline-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 13px; border: 1px solid var(--danger-border); border-radius: 10px; background: var(--danger-bg); color: var(--danger); font-size: 12px; }
.inline-error button { border: 0; background: transparent; color: inherit; font-weight: 700; cursor: pointer; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 900px) { .health-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 520px) { .health-grid { grid-template-columns: 1fr; } }
</style>
