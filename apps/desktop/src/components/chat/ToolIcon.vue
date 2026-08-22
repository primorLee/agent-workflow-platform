<script setup lang="ts">
/**
 * ToolIcon — renders a Lucide SVG icon for an Agent CLI tool-use event.
 *
 * Backend `cc_status` SSE events carry the tool name (Read / Edit /
 * Write / Bash / Grep / Glob / Agent / WebSearch / WebFetch /
 * TodoWrite / mcp__awp__* / thinking). We map to Lucide icons
 * below. Unknown tools degrade gracefully to a generic Wrench icon so
 * new backend tools don't break old clients.
 *
 * Special case — `tool === "thinking"`: renders a 3-dot pulse loader
 * instead of a Lucide icon. The 🧠/💭 emojis previously baked into the
 * backend `label` strings have been removed (2026-04-24). Pure CSS,
 * matches the minimal dot animation used by modern agent interfaces.
 *
 * Status state (running | done | error | idle) controls both icon
 * (loader / check / x / mapped) and color. Size defaults to 16px to
 * match the existing .todo-check width.
 */
import { computed, type Component } from 'vue'
import {
  BookOpen,
  Edit3,
  FilePlus,
  Terminal,
  SearchCode,
  FolderSearch,
  Bot,
  Globe2,
  DownloadCloud,
  ListChecks,
  Wrench,
  Loader2,
  CheckCircle2,
  XCircle,
} from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  /** Agent CLI tool name emitted by the configured adapter. */
  tool?: string
  /** Icon size in pixels. Default 16 matches existing todo-check width. */
  size?: number
  /** Render state. `idle` uses the mapped tool icon (default). */
  status?: 'running' | 'done' | 'error' | 'idle'
}>(), {
  tool: '',
  size: 16,
  status: 'idle',
})

// Exact mapping agreed in the design spec (docs/L3-tasks/reports/tool-icons-preview.html).
// Keys must match the exact strings the backend emits; do not lowercase.
const ICON_MAP: Record<string, Component> = {
  Read: BookOpen,
  Edit: Edit3,
  Write: FilePlus,
  Bash: Terminal,
  Grep: SearchCode,
  Glob: FolderSearch,
  Agent: Bot,
  WebSearch: Globe2,
  WebFetch: DownloadCloud,
  TodoWrite: ListChecks,
}

const isThinking = computed(() =>
  props.tool === 'thinking' && props.status !== 'done' && props.status !== 'error',
)

const iconComponent = computed<Component>(() => {
  if (props.status === 'running') return Loader2
  if (props.status === 'done') return CheckCircle2
  if (props.status === 'error') return XCircle
  return ICON_MAP[props.tool] || Wrench
})

const statusClass = computed(() => `tool-icon--${props.status}`)
</script>

<template>
  <!-- Thinking state: 3-dot pulse loader (no emoji, no Lucide icon). -->
  <span
    v-if="isThinking"
    class="thinking-dots"
    :class="statusClass"
    :style="{ width: size + 'px', height: size + 'px' }"
    data-testid="tool-icon"
    data-tool="thinking"
    :data-status="status"
  >
    <span /><span /><span />
  </span>

  <!-- Normal tool: Lucide SVG icon. -->
  <component
    v-else
    :is="iconComponent"
    :size="size"
    :stroke-width="1.8"
    :class="['tool-icon', statusClass]"
    data-testid="tool-icon"
    :data-tool="tool"
    :data-status="status"
  />
</template>

<style scoped>
.tool-icon {
  flex-shrink: 0;
  color: var(--accent, #38bdf8);
  display: inline-block;
  vertical-align: middle;
}

.tool-icon--running {
  animation: spin 1.5s linear infinite;
  color: var(--accent, #38bdf8);
}

.tool-icon--done {
  color: #22c55e;
}

.tool-icon--error {
  color: #ef4444;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ── Thinking 3-dot pulse — provider-neutral minimal loader ── */
.thinking-dots {
  flex-shrink: 0;
  display: inline-flex;
  gap: 3px;
  align-items: center;
  justify-content: center;
  vertical-align: middle;
}

.thinking-dots > span {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--accent, #38bdf8);
  opacity: 0.3;
  animation: thinking-pulse 1.4s ease-in-out infinite;
}

.thinking-dots > span:nth-child(1) { animation-delay: 0s; }
.thinking-dots > span:nth-child(2) { animation-delay: 0.2s; }
.thinking-dots > span:nth-child(3) { animation-delay: 0.4s; }

@keyframes thinking-pulse {
  0%, 60%, 100% { opacity: 0.3; transform: scale(0.9); }
  30%           { opacity: 1;   transform: scale(1.3); }
}
</style>
