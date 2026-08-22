<script setup lang="ts">
import { computed } from 'vue'

import type { TaskRecord } from '@/api/normalizers'

const props = defineProps<{ task: TaskRecord | null }>()
defineEmits<{ close: [] }>()

const payload = computed(() => JSON.stringify(props.task?.payload ?? {}, null, 2))
const result = computed(() => JSON.stringify(props.task?.result ?? null, null, 2))

function formatWhen(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
</script>

<template>
  <section class="panel inspector" aria-labelledby="inspector-title">
    <header class="panel-header">
      <div>
        <p class="section-kicker">SELECTED RECORD</p>
        <h2 id="inspector-title">Task detail</h2>
      </div>
      <button v-if="task" type="button" class="close-button" aria-label="Close task detail" @click="$emit('close')">×</button>
    </header>

    <div v-if="!task" class="empty-state">
      <strong>Select a task</strong>
      <p>Choose a row to inspect the exact payload, result, assignment, and timestamps returned by the API.</p>
    </div>

    <div v-else class="detail-scroll">
      <div class="identity">
        <span class="badge badge-info">{{ task.status }}</span>
        <strong>{{ task.type }}</strong>
        <code>{{ task.id }}</code>
      </div>

      <dl>
        <div><dt>Created</dt><dd>{{ formatWhen(task.createdAt) }}</dd></div>
        <div><dt>Updated</dt><dd>{{ formatWhen(task.updatedAt) }}</dd></div>
        <div><dt>Delivered</dt><dd>{{ formatWhen(task.deliveredAt) }}</dd></div>
        <div><dt>Response</dt><dd>{{ formatWhen(task.responseReceivedAt) }}</dd></div>
        <div><dt>Assigned agent</dt><dd><code>{{ task.assignedAgentId ?? 'unassigned' }}</code></dd></div>
        <div><dt>Idempotency key</dt><dd><code>{{ task.idempotencyKey ?? '—' }}</code></dd></div>
      </dl>

      <div v-if="task.error" class="task-error">
        <strong>Error</strong>
        <p>{{ task.error }}</p>
      </div>

      <section class="json-section">
        <h3>Payload</h3>
        <pre>{{ payload }}</pre>
      </section>
      <section class="json-section">
        <h3>Result</h3>
        <pre>{{ result }}</pre>
      </section>
    </div>
  </section>
</template>

<style scoped>
.panel { min-width: 0; border: 1px solid var(--border); border-radius: 16px; background: var(--bg-panel); box-shadow: var(--shadow-sm); overflow: hidden; }
.panel-header { display: flex; align-items: end; justify-content: space-between; gap: 12px; padding: 19px 20px 14px; border-bottom: 1px solid var(--border); }
.section-kicker { color: var(--accent); font-size: 10px; font-weight: 800; letter-spacing: .14em; }
h2 { margin-top: 3px; font-size: 19px; letter-spacing: -.02em; }
.close-button { width: 30px; height: 30px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-surface); color: var(--text-secondary); font-size: 20px; line-height: 1; cursor: pointer; }
.close-button:hover { background: var(--bg-hover); color: var(--text-primary); }
.empty-state { min-height: 220px; display: grid; place-items: center; align-content: center; gap: 6px; padding: 28px; text-align: center; }
.empty-state p { color: var(--text-muted); font-size: 12px; }
.detail-scroll { max-height: 560px; overflow: auto; }
.identity { display: grid; gap: 7px; padding: 17px 19px; }
.identity .badge { justify-self: start; }
.identity code { overflow: hidden; color: var(--text-muted); font: 500 11px var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
dl { display: grid; gap: 8px; padding: 0 19px 17px; }
dl div { display: grid; grid-template-columns: 105px minmax(0, 1fr); gap: 10px; align-items: baseline; }
dt { color: var(--text-muted); font-size: 10px; text-transform: uppercase; letter-spacing: .05em; }
dd { overflow: hidden; color: var(--text-secondary); font-size: 11px; text-align: right; text-overflow: ellipsis; }
dd code { font: inherit var(--font-mono); }
.task-error { margin: 0 19px 17px; padding: 11px 12px; border: 1px solid var(--danger-border); border-radius: 9px; background: var(--danger-bg); color: var(--danger); font-size: 11px; overflow-wrap: anywhere; }
.task-error p { margin-top: 3px; }
.json-section { border-top: 1px solid var(--border); }
.json-section h3 { padding: 10px 19px; color: var(--text-muted); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
pre { max-height: 240px; overflow: auto; padding: 14px 19px; background: var(--bg-code); color: var(--code-text); font: 500 11px/1.55 var(--font-mono); white-space: pre-wrap; word-break: break-word; }
</style>
