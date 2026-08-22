<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ActivityEvent } from '@/types/activity'
import { PHASE_META } from '@/types/activity'

const { t } = useI18n()

const props = defineProps<{
  event: ActivityEvent
}>()

const meta = computed(() => PHASE_META[props.event.phase] ?? PHASE_META.analyzing)
const isRunning = computed(() => props.event.status === 'running')
const isFailed = computed(() => props.event.status === 'failed')
const isCompleted = computed(() => props.event.status === 'completed')

const statusIcon = computed(() => {
  if (isFailed.value) return '❌'
  if (isCompleted.value) return '✅'
  return meta.value.icon
})

const statusText = computed(() => {
  if (isFailed.value) return `${props.event.title} — ${t('activityTimeline.phaseFailed')}`
  if (isCompleted.value) {
    const dur = props.event.duration_ms
    const durText = dur ? ` (${dur > 1000 ? (dur / 1000).toFixed(1) + 's' : dur + 'ms'})` : ''
    return `${props.event.title} — ${t('activityTimeline.phaseCompleted')}${durText}`
  }
  return props.event.description || t('activityTimeline.phaseRunning', { label: t(meta.value.labelKey) })
})

const progressWidth = computed(() => {
  if (props.event.progress != null) return `${props.event.progress}%`
  return isRunning.value ? '100%' : '0%'
})
</script>

<template>
  <div
    class="work-phase"
    :class="{ running: isRunning, completed: isCompleted, failed: isFailed }"
  >
    <div class="phase-header">
      <span class="phase-icon">{{ statusIcon }}</span>
      <span class="phase-title">{{ event.title }}</span>
      <span v-if="event.iteration" class="phase-iteration">#{{ event.iteration }}</span>
      <span v-if="isRunning" class="pulse-dot" :style="{ background: meta.color }" />
    </div>

    <div class="phase-desc">{{ statusText }}</div>

    <!-- Progress bar -->
    <div v-if="isRunning" class="progress-track">
      <div
        class="progress-fill"
        :class="{ indeterminate: event.progress == null }"
        :style="{
          width: progressWidth,
          background: meta.color,
        }"
      />
    </div>
  </div>
</template>

<style scoped>
.work-phase {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 14px;
  border-radius: var(--radius);
  background: var(--bg-surface);
  border-left: 3px solid var(--border);
  transition: border-color 0.3s, background 0.3s;
}

.work-phase.running {
  border-left-color: var(--accent);
  background: rgba(45, 225, 194, 0.05);
}

.work-phase.completed {
  border-left-color: var(--success);
  opacity: 0.8;
}

.work-phase.failed {
  border-left-color: var(--danger);
  background: rgba(239, 68, 68, 0.05);
}

.phase-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.phase-icon {
  font-size: 16px;
  flex-shrink: 0;
}

.phase-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.phase-iteration {
  font-size: 11px;
  color: var(--accent);
  background: var(--accent-dim);
  padding: 1px 6px;
  border-radius: 10px;
  font-weight: 600;
}

.pulse-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-left: auto;
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.8); }
}

.phase-desc {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.4;
}

.progress-track {
  height: 3px;
  background: var(--border);
  border-radius: 2px;
  overflow: hidden;
  margin-top: 2px;
}

.progress-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.5s ease;
}

.progress-fill.indeterminate {
  width: 30% !important;
  animation: slide 1.5s ease-in-out infinite;
}

@keyframes slide {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(400%); }
}
</style>
