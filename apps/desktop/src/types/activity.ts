/** General phases emitted by agent runtimes and control planes. */
export type ActivityPhase =
  | 'analyzing'
  | 'planning'
  | 'executing'
  | 'tool'
  | 'waiting'
  | 'validating'
  | 'publishing'
  | 'completed'
  | 'failed'

export type ActivityStatus = 'queued' | 'running' | 'completed' | 'failed' | 'skipped'

export interface MetricResult {
  name: string
  value: number
  unit?: string
  target?: number
  op?: string
  pass?: boolean
  margin?: number
  trend?: 'up' | 'down' | 'stable'
  prev_value?: number
}

export interface DiagnosticIssue {
  metric?: string
  severity: 'critical' | 'warning' | 'info'
  message: string
  suggestion?: string
  param_hint?: string
}

export interface DiagnosticInfo {
  issues: DiagnosticIssue[]
  overall_status: 'all_pass' | 'partial' | 'all_fail' | 'unknown'
  pass_count: number
  total_count: number
}

/** A single event in the live workflow progress stream. */
export interface ActivityEvent {
  id: string
  phase: ActivityPhase
  status: ActivityStatus
  title: string
  description?: string
  progress?: number
  timestamp: string
  task_id?: string
  iteration?: number
  metrics?: MetricResult[]
  diagnostics?: DiagnosticInfo
  duration_ms?: number
  children?: ActivityEvent[]
  kind?: string
  conversation_id?: string
  [key: string]: unknown
}

export const PHASE_META: Record<ActivityPhase, { labelKey: string; icon: string; color: string }> = {
  analyzing:  { labelKey: 'activity.types.analyzing',  icon: '◇', color: '#818cf8' },
  planning:   { labelKey: 'activity.types.planning',   icon: '≡', color: '#a78bfa' },
  executing:  { labelKey: 'activity.types.executing',  icon: '▶', color: '#60a5fa' },
  tool:       { labelKey: 'activity.types.tool',       icon: '◆', color: '#34d399' },
  waiting:    { labelKey: 'activity.types.waiting',    icon: '…', color: '#f59e0b' },
  validating: { labelKey: 'activity.types.validating', icon: '✓', color: '#2dd4bf' },
  publishing: { labelKey: 'activity.types.publishing', icon: '↑', color: '#f472b6' },
  completed:  { labelKey: 'activity.types.completed',  icon: '✓', color: '#22c55e' },
  failed:     { labelKey: 'activity.types.failed',     icon: '!', color: '#ef4444' },
}

export function formatMetric(value: number, unit = ''): string {
  return `${Number.isInteger(value) ? value : value.toFixed(2)}${unit}`
}

export function passRateText(
  diagnostics: DiagnosticInfo,
  translate: (key: string, params?: Record<string, unknown>) => string,
): string {
  return translate('activity.passRate', {
    pass: diagnostics.pass_count,
    total: diagnostics.total_count,
  })
}

export interface RichChatMessage {
  role: 'user' | 'assistant'
  content: string
  activities?: ActivityEvent[]
}