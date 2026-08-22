<script setup lang="ts">
/**
 * ConnectionStatusDot — top-right SSE connectivity indicator.
 *
 * Tiny 10px colored dot with a native title tooltip. Sits inside the
 * Electron titlebar area (see App.vue) at the far right. Opts out of the
 * `-webkit-app-region: drag` set on the surrounding titlebar so clicks /
 * hovers still register.
 *
 * Source of truth for dot color: `useSseStatus()` — which subscribes to the
 * `connection-health` IPC stream the main process already broadcasts for
 * the (currently hidden) ConnectionHealth popover. No additional IPC cost.
 *
 * Source of truth for tooltip body (T-CU09): the explicit connectivity
 * preflight exposed via `bridge.connectivityLast()` / `connectivityCheck()`.
 * On mount we pull the cached result for immediate first paint; if the user
 * hovers > 1s we force a fresh probe so the tooltip never shows stale data.
 *
 * Design intent:
 *   - Four colors only (green / amber / red / white) — no iconography so
 *     the dot reads the same in light + dark themes without asset work.
 *   - Tooltip is plain `title` — no popover, no hover delay games, plays
 *     nicely with the existing tooltip conventions on other titlebar-level
 *     buttons (e.g. AppSidebar collapse button).
 *   - Zero layout cost when not mounted — the host container keeps its
 *     flex gap.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useSseStatus, type SseUiStatus } from '@/composables/useSseStatus'
import { waitForBridge } from '@/bridge'
import type { ConnectivityCheckResult } from '@/types/bridge'

const { status, tooltip: sseTooltip } = useSseStatus()

// Cached connectivity preflight result. `null` until the first call resolves.
const connectivity = ref<ConnectivityCheckResult | null>(null)
// Guards against overlapping refresh runs when the mouse wiggles in and out.
const refreshing = ref<boolean>(false)
// Hover-delay timer — fires a refresh after 1s of sustained hover.
let hoverTimer: ReturnType<typeof setTimeout> | null = null

// Map each UI bucket to a single class suffix. Keeps the template tidy and
// makes unit tests trivial (assert the class attribute matches the bucket).
const dotClass = computed<string>(() => `dot dot--${status.value}`)

// Expose the status string as a data attribute for e2e / Playwright selectors.
const dataStatus = computed<SseUiStatus>(() => status.value)

// -----------------------------------------------------------------------
// Tooltip formatting
//
// Three-line layout when we have a connectivity result:
//   兼容状态流: <SSE status — reuse useSseStatus tooltip text>
//   控制面健康: <ok | fail — detail>
//   VM SSH: <ok | fail | skipped — detail>
//
// Falls back to the single-line SSE-only tooltip when the preflight hasn't
// produced a result yet (first <10s of launch).
// -----------------------------------------------------------------------

function formatProbe(label: string, status: string, detail: string | undefined): string {
  if (status === 'ok') return `${label}: ok`
  const tail = detail ? ` (${detail})` : ''
  return `${label}: ${status}${tail}`
}

const tooltip = computed<string>(() => {
  const c = connectivity.value
  if (!c) return sseTooltip.value

  // Line 1 — prefer the live SSE-state tooltip from useSseStatus (it has the
  // "最近心跳 N 秒前" / "重连中" detail), falling back to the preflight's own
  // compatibility-stream result when the SSE composable is still in init.
  const sseLine = status.value === 'init'
    ? formatProbe('兼容状态流', c.cloud_sse, c.details.cloud_sse)
    : sseTooltip.value
  const httpLine = formatProbe('控制面健康', c.cloud_http, c.details.cloud_http)
  const sshLine = formatProbe('VM SSH', c.vm_ssh, c.details.vm_ssh)
  return `${sseLine}\n${httpLine}\n${sshLine}`
})

// aria-label duplicates the tooltip text for screen readers; keeping them
// identical means VoiceOver / Narrator users hear what sighted users read.
const ariaLabel = computed<string>(() => tooltip.value)

// -----------------------------------------------------------------------
// IPC wiring
// -----------------------------------------------------------------------

async function loadCached(): Promise<void> {
  const bridge = await waitForBridge(3_000)
  if (!bridge?.connectivityLast) return
  try {
    const res = await bridge.connectivityLast()
    if (res) connectivity.value = res
  } catch {
    /* bridge hiccup — ConnectionStatusDot keeps its fallback tooltip */
  }
}

async function forceRefresh(): Promise<void> {
  if (refreshing.value) return
  refreshing.value = true
  try {
    const bridge = await waitForBridge(1_000)
    if (!bridge?.connectivityCheck) return
    const res = await bridge.connectivityCheck()
    if (res) connectivity.value = res
  } catch {
    /* leave last-known-good cached value in place */
  } finally {
    refreshing.value = false
  }
}

function onPointerEnter(): void {
  if (hoverTimer) clearTimeout(hoverTimer)
  // 1s grace: avoids refreshing on incidental cursor passes-through. The
  // refresh itself is fire-and-forget; the tooltip will re-render reactively
  // when `connectivity.value` updates.
  hoverTimer = setTimeout(() => {
    void forceRefresh()
  }, 1_000)
}

function onPointerLeave(): void {
  if (hoverTimer) {
    clearTimeout(hoverTimer)
    hoverTimer = null
  }
}

onMounted(() => {
  void loadCached()
})

onBeforeUnmount(() => {
  if (hoverTimer) {
    clearTimeout(hoverTimer)
    hoverTimer = null
  }
})
</script>

<template>
  <span
    class="connection-status-dot"
    role="status"
    :aria-label="ariaLabel"
    :title="tooltip"
    :data-sse-status="dataStatus"
    @pointerenter="onPointerEnter"
    @pointerleave="onPointerLeave"
  >
    <span :class="dotClass" aria-hidden="true" />
  </span>
</template>

<style scoped>
/*
 * Pencil-style: compact, flat, single-purpose indicator. No animation on
 * `ready` — a steady green dot is less distracting than a constantly
 * pulsing one, and the `reconnecting` + `init` states keep the dynamic
 * signal where it matters.
 */

.connection-status-dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  /* Undo the titlebar drag region so the browser registers hover/click for
   * the tooltip. Electron only honors `no-drag` on the element itself. */
  -webkit-app-region: no-drag;
  cursor: help;
  /* A tiny hit-box expansion — the visual dot is 10px but the pointer
   * target is the whole 18px square, improving tooltip discoverability. */
  padding: 4px;
  box-sizing: content-box;
}

.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--text-muted, #9aa1a9);
  box-shadow: 0 0 0 1px var(--border, rgba(0, 0, 0, 0.08));
  transition: background-color 0.2s ease;
  flex-shrink: 0;
}

.dot--ready {
  background: var(--success, #57d18c);
  box-shadow: 0 0 0 1px rgba(87, 209, 140, 0.35);
}

.dot--reconnecting {
  background: var(--warning, #f6b454);
  box-shadow: 0 0 0 1px rgba(246, 180, 84, 0.35);
  animation: dot-pulse 1.2s ease-in-out infinite;
}

.dot--down {
  background: var(--danger, #ff6b6b);
  box-shadow: 0 0 0 1px rgba(255, 107, 107, 0.4);
}

.dot--init {
  background: var(--text-muted, #d4d8dc);
  box-shadow: 0 0 0 1px var(--border, rgba(0, 0, 0, 0.08));
  opacity: 0.72;
}

@keyframes dot-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}
</style>
