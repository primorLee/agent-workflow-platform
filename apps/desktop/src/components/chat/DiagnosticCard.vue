<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DiagnosticInfo, DiagnosticIssue } from '@/types/activity'
import { passRateText } from '@/types/activity'

const { t } = useI18n()

const props = defineProps<{
  diagnostics: DiagnosticInfo
  iteration?: number
}>()

const criticals = computed(() => props.diagnostics.issues.filter(i => i.severity === 'critical'))
const warnings = computed(() => props.diagnostics.issues.filter(i => i.severity === 'warning'))
const infos = computed(() => props.diagnostics.issues.filter(i => i.severity === 'info'))

const overallColor = computed(() => {
  switch (props.diagnostics.overall_status) {
    case 'all_pass': return 'var(--success)'
    case 'partial': return 'var(--warning)'
    case 'all_fail': return 'var(--danger)'
    default: return 'var(--text-muted)'
  }
})

const overallLabel = computed(() => {
  switch (props.diagnostics.overall_status) {
    case 'all_pass': return t('diag.allPass')
    case 'partial': return t('diag.partial')
    case 'all_fail': return t('diag.allFail')
    default: return t('diag.unknown')
  }
})

function severityIcon(sev: string): string {
  switch (sev) {
    case 'critical': return '🔴'
    case 'warning': return '🟡'
    default: return '🔵'
  }
}

function severityLabel(sev: string): string {
  switch (sev) {
    case 'critical': return t('diag.critical')
    case 'warning': return t('diag.warning')
    default: return t('diag.info')
  }
}
</script>

<template>
  <div class="diag-card">
    <!-- Header -->
    <div class="diag-header">
      <div class="diag-header-left">
        <span class="diag-icon">🔧</span>
        <span class="diag-label">
          {{ iteration ? $t('diag.iterDiagnosis', { n: iteration }) : $t('diag.reportTitle') }}
        </span>
      </div>
      <div class="diag-badge" :style="{ color: overallColor, borderColor: overallColor }">
        {{ passRateText(diagnostics, t) }} · {{ overallLabel }}
      </div>
    </div>

    <!-- Issue groups -->
    <div v-if="criticals.length > 0" class="issue-group">
      <div class="group-label critical">{{ $t('diag.criticalIssues', { n: criticals.length }) }}</div>
      <div v-for="(issue, idx) in criticals" :key="'c' + idx" class="issue-item critical">
        <div class="issue-header">
          <span class="issue-icon">{{ severityIcon(issue.severity) }}</span>
          <span class="issue-metric">{{ issue.metric }}</span>
        </div>
        <div class="issue-message">{{ issue.message }}</div>
        <div class="issue-suggestion">
          <span class="suggestion-icon">💡</span>
          <span>{{ issue.suggestion }}</span>
          <code v-if="issue.param_hint" class="param-hint">{{ issue.param_hint }}</code>
        </div>
      </div>
    </div>

    <div v-if="warnings.length > 0" class="issue-group">
      <div class="group-label warning">{{ $t('diag.warningIssues', { n: warnings.length }) }}</div>
      <div v-for="(issue, idx) in warnings" :key="'w' + idx" class="issue-item warning">
        <div class="issue-header">
          <span class="issue-icon">{{ severityIcon(issue.severity) }}</span>
          <span class="issue-metric">{{ issue.metric }}</span>
        </div>
        <div class="issue-message">{{ issue.message }}</div>
        <div class="issue-suggestion">
          <span class="suggestion-icon">💡</span>
          <span>{{ issue.suggestion }}</span>
          <code v-if="issue.param_hint" class="param-hint">{{ issue.param_hint }}</code>
        </div>
      </div>
    </div>

    <div v-if="infos.length > 0" class="issue-group">
      <div class="group-label info">{{ $t('diag.infoIssues', { n: infos.length }) }}</div>
      <div v-for="(issue, idx) in infos" :key="'i' + idx" class="issue-item info">
        <div class="issue-header">
          <span class="issue-icon">{{ severityIcon(issue.severity) }}</span>
          <span class="issue-metric">{{ issue.metric }}</span>
        </div>
        <div class="issue-message">{{ issue.message }}</div>
        <div class="issue-suggestion">
          <span class="suggestion-icon">💡</span>
          <span>{{ issue.suggestion }}</span>
          <code v-if="issue.param_hint" class="param-hint">{{ issue.param_hint }}</code>
        </div>
      </div>
    </div>

    <!-- All pass -->
    <div v-if="diagnostics.overall_status === 'all_pass'" class="all-pass-msg">
      {{ $t('diag.allMetricsPass') }}
    </div>
  </div>
</template>

<style scoped>
.diag-card {
  border-radius: var(--radius);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  overflow: hidden;
}

.diag-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}

.diag-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.diag-icon {
  font-size: 16px;
}

.diag-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.diag-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border: 1px solid;
  border-radius: 12px;
}

/* Issue groups */
.issue-group {
  padding: 8px 14px;
}

.issue-group + .issue-group {
  border-top: 1px solid rgba(30, 41, 59, 0.4);
}

.group-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
}

.group-label.critical { color: var(--danger); }
.group-label.warning { color: var(--warning); }
.group-label.info { color: var(--accent); }

.issue-item {
  padding: 8px 0;
}

.issue-item + .issue-item {
  border-top: 1px solid rgba(30, 41, 59, 0.3);
}

.issue-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.issue-icon {
  font-size: 12px;
}

.issue-metric {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.issue-message {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.4;
  padding-left: 20px;
}

.issue-suggestion {
  display: flex;
  align-items: baseline;
  gap: 4px;
  font-size: 11px;
  color: var(--accent);
  margin-top: 4px;
  padding-left: 20px;
  line-height: 1.4;
}

.suggestion-icon {
  flex-shrink: 0;
}

.param-hint {
  font-family: var(--font-mono);
  font-size: 11px;
  background: rgba(45, 225, 194, 0.1);
  color: var(--accent);
  padding: 0 4px;
  border-radius: 3px;
  margin-left: 4px;
}

.all-pass-msg {
  padding: 16px;
  text-align: center;
  font-size: 14px;
  color: var(--success);
  font-weight: 600;
}
</style>
