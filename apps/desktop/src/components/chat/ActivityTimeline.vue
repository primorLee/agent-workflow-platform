<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ActivityEvent } from '@/types/activity'
import { PHASE_META } from '@/types/activity'

const { t } = useI18n()

const props = defineProps<{
  events: ActivityEvent[]
  compact?: boolean
}>()

const emit = defineEmits<{
  select: [event: ActivityEvent]
}>()

const sortedEvents = computed(() =>
  [...props.events].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
)

function getMeta(phase: string) {
  return PHASE_META[phase as keyof typeof PHASE_META] ?? PHASE_META.analyzing
}

function statusColor(evt: ActivityEvent): string {
  if (evt.status === 'running') return getMeta(evt.phase).color
  if (evt.status === 'completed') return 'var(--success)'
  if (evt.status === 'failed') return 'var(--danger)'
  return 'var(--text-muted)'
}

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime()
  if (diff < 60000) return t('time.justNow')
  if (diff < 3600000) return t('activity.minutesAgo', { n: Math.floor(diff / 60000) })
  if (diff < 86400000) return t('activity.hoursAgo', { n: Math.floor(diff / 3600000) })
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function durationText(ms?: number): string {
  if (!ms) return ''
  if (ms > 60000) return `${(ms / 60000).toFixed(1)}min`
  if (ms > 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${ms}ms`
}
</script>

<template>
  <div class="timeline" :class="{ compact }">
    <div
      v-for="(evt, idx) in sortedEvents"
      :key="evt.id"
      class="timeline-item"
      :class="{ running: evt.status === 'running', failed: evt.status === 'failed' }"
      @click="emit('select', evt)"
    >
      <!-- Connector line -->
      <div class="timeline-line-container">
        <div v-if="idx > 0" class="timeline-line top" :style="{ borderColor: statusColor(sortedEvents[idx - 1]!) }" />
        <div
          class="timeline-dot"
          :class="{ pulse: evt.status === 'running' }"
          :style="{ background: statusColor(evt), boxShadow: evt.status === 'running' ? `0 0 8px ${statusColor(evt)}` : 'none' }"
        />
        <div v-if="idx < sortedEvents.length - 1" class="timeline-line bottom" :style="{ borderColor: statusColor(evt) }" />
      </div>

      <!-- Content -->
      <div class="timeline-content">
        <div class="timeline-header">
          <span class="timeline-icon">{{ getMeta(evt.phase).icon }}</span>
          <span class="timeline-title">{{ evt.title }}</span>
          <span v-if="evt.iteration" class="iter-badge">#{{ evt.iteration }}</span>
        </div>

        <div v-if="evt.description && !compact" class="timeline-desc">
          {{ evt.description }}
        </div>

        <div class="timeline-meta">
          <span class="timeline-time">{{ timeAgo(evt.timestamp) }}</span>
          <span v-if="evt.duration_ms" class="timeline-duration">{{ durationText(evt.duration_ms) }}</span>
          <span v-if="evt.metrics && evt.metrics.length > 0" class="timeline-metrics-hint">
            {{ $t('activityTimeline.passRate', { pass: evt.metrics.filter(m => m.pass).length, total: evt.metrics.length }) }}
          </span>
        </div>
      </div>
    </div>

    <div v-if="sortedEvents.length === 0" class="timeline-empty">
      {{ $t('activityTimeline.noActivity') }}
    </div>
  </div>
</template>

<style scoped>
.timeline {
  display: flex;
  flex-direction: column;
  padding: 8px 0;
}

.timeline-item {
  display: flex;
  gap: 12px;
  cursor: pointer;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  transition: background 0.15s;
}

.timeline-item:hover {
  background: var(--bg-hover);
}

.timeline-line-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 20px;
  flex-shrink: 0;
}

.timeline-line {
  width: 0;
  flex: 1;
  border-left: 2px solid var(--border);
}

.timeline-line.top {
  min-height: 8px;
}

.timeline-line.bottom {
  min-height: 8px;
}

.timeline-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
  z-index: 1;
}

.timeline-dot.pulse {
  animation: dotPulse 1.5s ease-in-out infinite;
}

@keyframes dotPulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.3); }
}

.timeline-content {
  flex: 1;
  min-width: 0;
  padding: 4px 0 12px;
}

.timeline-header {
  display: flex;
  align-items: center;
  gap: 6px;
}

.timeline-icon {
  font-size: 14px;
}

.timeline-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.iter-badge {
  font-size: 10px;
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-dim);
  padding: 0 5px;
  border-radius: 8px;
}

.timeline-desc {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 3px;
  line-height: 1.4;
}

.timeline-meta {
  display: flex;
  gap: 10px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-muted);
}

.timeline-duration {
  font-family: var(--font-mono);
}

.timeline-metrics-hint {
  color: var(--accent);
  font-weight: 500;
}

.timeline-empty {
  text-align: center;
  padding: 20px;
  color: var(--text-muted);
  font-size: 13px;
}

/* Compact mode */
.compact .timeline-content {
  padding-bottom: 6px;
}

.compact .timeline-meta {
  display: none;
}
</style>
