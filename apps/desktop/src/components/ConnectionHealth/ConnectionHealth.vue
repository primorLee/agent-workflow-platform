<script setup lang="ts">
/**
 * Compact connection status and event history for the retained local SSH path.
 *
 * The component reads cached main-process health, subscribes to updates, and
 * keeps a small in-memory event ring for local troubleshooting. It never
 * uploads diagnostics or triggers remote repair actions.
 */import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { waitForBridge } from '@/bridge'
import type {
  ConnectionHealthSnapshot,
  ConnectionHealthState,
} from '@/types/bridge'


const { t } = useI18n()

// ---------------------------------------------------------------------------
// State — snapshot, event log, UI bits.
// ---------------------------------------------------------------------------

const DEFAULT_SNAPSHOT: ConnectionHealthSnapshot = {
  state: 'connecting',
  agent_id: null,
  last_heartbeat: null,
  last_heartbeat_age_s: null,
  transport: 'unknown',
  active_tasks: 0,
  version: '',
  uptime_s: null,
  recent_errors: [],
  hostname: '',
  received_at_ms: 0,
  last_error: null,
}

const snapshot = ref<ConnectionHealthSnapshot>({ ...DEFAULT_SNAPSHOT })
const expanded = ref(false)
const hidden = ref(false)

// Channel badge reflects the last local preflight result.
// `channel` is derived from the last preflight result if available; defaults
// mode they are running under.
type ChannelBadge = 'ssh' | 'offline' | 'unknown'
const channel = ref<ChannelBadge>('unknown')

// Ring buffer — last 10 state events.
interface HealthEvent {
  ts: number
  state: ConnectionHealthState
  error: string | null
}
const events = ref<HealthEvent[]>([])

// Ping latency state.
const pinging = ref(false)
const pingMs = ref<number | null>(null)

// Sticky offline timer for the sustained-offline warning.
const offlineSinceMs = ref<number | null>(null)
const nowMs = ref(Date.now())

const HIDDEN_KEY = 'awp_connection_health_hidden'

let tickTimer: ReturnType<typeof setInterval> | null = null
let unsubscribe: (() => void) | null = null
let liveRegion: HTMLElement | null = null

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatAge(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return t('connectionHealth.summary.lastHeartbeatNever')
  if (seconds < 5) return t('connectionHealth.ago.now')
  if (seconds < 60) return t('connectionHealth.ago.secs', { n: Math.round(seconds) })
  if (seconds < 3600) return t('connectionHealth.ago.mins', { n: Math.round(seconds / 60) })
  if (seconds < 86_400) return t('connectionHealth.ago.hours', { n: Math.round(seconds / 3600) })
  return t('connectionHealth.ago.days', { n: Math.round(seconds / 86_400) })
}

// Transport tag → human-readable label.
const transportLabel = computed(() => {
  const t_ = snapshot.value.transport
  if (t_ === 'wss' || t_ === 'websocket') return t('connectionHealth.summary.transportWss')
  if (t_ === 'https-longpoll' || t_ === 'longpoll') return t('connectionHealth.summary.transportLongpoll')
  if (t_ === 'lan-direct' || t_ === 'lan') return t('connectionHealth.summary.transportLan')
  return t('connectionHealth.summary.transportUnknown')
})

// Live-updating age — we tick nowMs every second and derive a display age
// from the server-reported heartbeat_age_s + elapsed wall time since last
// received snapshot. This dodges clock-skew surprises (we never format the
// client's own clock against the server's timestamp).
const displayAgeSeconds = computed((): number | null => {
  const snap = snapshot.value
  if (snap.last_heartbeat_age_s === null || snap.last_heartbeat_age_s === undefined) return null
  if (!snap.received_at_ms) return snap.last_heartbeat_age_s
  const elapsed = (nowMs.value - snap.received_at_ms) / 1000
  return Math.max(0, snap.last_heartbeat_age_s + elapsed)
})

const summaryText = computed((): string => {
  const s = snapshot.value.state
  const age = formatAge(displayAgeSeconds.value)
  const tasks = snapshot.value.active_tasks
  const taskPart =
    tasks > 0
      ? t('connectionHealth.summary.activeTasks', { n: tasks })
      : t('connectionHealth.summary.activeTasksZero')
  if (s === 'online') {
    return `${t('connectionHealth.state.online')} · ${t('connectionHealth.summary.lastHeartbeat', { age })} · ${taskPart}`
  }
  if (s === 'degraded') {
    return `${t('connectionHealth.state.degraded')} · ${transportLabel.value} · ${t('connectionHealth.summary.lastHeartbeat', { age })}`
  }
  if (s === 'offline') {
    return `${t('connectionHealth.state.offline')} · ${t('connectionHealth.summary.lastHeartbeatLong', { age })}`
  }
  if (s === 'error') {
    return `${t('connectionHealth.state.error')} · ${snapshot.value.last_error ?? ''}`.trim()
  }
  if (s === 'connecting') return t('connectionHealth.state.connecting')
  return t('connectionHealth.state.unknown')
})

const showEscalation = computed(() => {
  if (snapshot.value.state !== 'offline' && snapshot.value.state !== 'error') return false
  if (offlineSinceMs.value === null) return false
  // 5 minutes sticky-red threshold — matches the UX doc.
  return nowMs.value - offlineSinceMs.value > 5 * 60 * 1000
})

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

function recordEvent(snap: ConnectionHealthSnapshot): void {
  const last = events.value[0]
  // Dedupe — only append when state or error changed.
  if (last && last.state === snap.state && last.error === snap.last_error) return
  events.value.unshift({
    ts: Date.now(),
    state: snap.state,
    error: snap.last_error,
  })
  if (events.value.length > 10) events.value.length = 10
}

function applySnapshot(snap: ConnectionHealthSnapshot): void {
  const prevState = snapshot.value.state
  snapshot.value = snap

  // Sticky-offline timer — start when we first see offline/error, clear
  // as soon as we recover.
  if (snap.state === 'offline' || snap.state === 'error') {
    if (offlineSinceMs.value === null) offlineSinceMs.value = Date.now()
  } else {
    offlineSinceMs.value = null
  }


  recordEvent(snap)

  // Accessibility: push the transition into the live region so screen
  // readers announce it without us stealing focus.
  if (snap.state !== prevState && liveRegion) {
    liveRegion.textContent = t('connectionHealth.aria.stateChanged', {
      state: t(`connectionHealth.state.${snap.state}`),
    })
  }
}

onMounted(async () => {
  // Restore hidden preference.
  try {
    hidden.value = localStorage.getItem(HIDDEN_KEY) === '1'
  } catch {
    /* localStorage unavailable — stay visible */
  }

  const bridge = await waitForBridge(3000)
  if (bridge?.get_connection_health) {
    try {
      const snap = await bridge.get_connection_health()
      if (snap) applySnapshot(snap as ConnectionHealthSnapshot)
    } catch {
      /* bridge hiccup — subscribe anyway */
    }
  }
  if (bridge?.on_connection_health) {
    unsubscribe = bridge.on_connection_health((snap) => {
      applySnapshot(snap as ConnectionHealthSnapshot)
    })
  }

  // Wall-clock tick drives the live-updating age and offline warning timer.
  tickTimer = setInterval(() => {
    nowMs.value = Date.now()
  }, 1_000)

  // v1.4.19 P5 — pull the last preflight channel / mode on mount. The main
  // process side populates this right after `runPreflight()` completes.
  void loadPreflightChannel()
})

onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer)
  if (unsubscribe) unsubscribe()
})

watch(hidden, (v) => {
  try {
    localStorage.setItem(HIDDEN_KEY, v ? '1' : '0')
  } catch {
    /* noop */
  }
})

// ---------------------------------------------------------------------------
// Local read-only action.
// ---------------------------------------------------------------------------

async function pingLatency(): Promise<void> {
  if (pinging.value) return
  pinging.value = true
  pingMs.value = null
  const bridge = await waitForBridge(1000)
  if (!bridge?.get_connection_health) {
    pinging.value = false
    return
  }
  const started = performance.now()
  try {
    await bridge.get_connection_health()
    pingMs.value = Math.round(performance.now() - started)
  } catch {
    pingMs.value = null
  } finally {
    pinging.value = false
  }
}

function togglePanel(): void {
  expanded.value = !expanded.value
}

function hidePanel(): void {
  expanded.value = false
  hidden.value = true
}

function showPanel(): void {
  hidden.value = false
}

function liveRegionRef(el: unknown): void {
  liveRegion = (el as HTMLElement) ?? null
}

// ---------------------------------------------------------------------------
// Icon / state → CSS class
// ---------------------------------------------------------------------------

const stateClass = computed(() => `state-${snapshot.value.state}`)

// v1.4.19 P5 — Channel badge derived from (state, channel) pair. We refresh
// the channel ref whenever the bridge exposes a preflight result; when not
// available we infer from the snapshot state (offline = offline badge).
const channelBadge = computed((): ChannelBadge => {
  const s = snapshot.value.state
  if (s === 'offline' || s === 'error') return 'offline'
  if (channel.value !== 'unknown') return channel.value
  return 'unknown'
})

const channelBadgeLabel = computed((): string => {
  switch (channelBadge.value) {
    case 'ssh':
      return t('connectionHealth.channel.ssh')
    case 'offline':
      return t('connectionHealth.channel.offline')
    default:
      return t('connectionHealth.channel.unknown')
  }
})

async function loadPreflightChannel(): Promise<void> {
  // Pull the last preflight result from the bridge if the main process
  // exposes it. Graceful degradation — we never block rendering on this.
  try {
    const b = await waitForBridge(1000)
    const extended = b as unknown as {
      get_preflight_channel?: () => Promise<{
        channel?: ChannelBadge
      } | null>
    }
    if (!extended?.get_preflight_channel) return
    const r = await extended.get_preflight_channel()
    if (!r) return
    if (r.channel) channel.value = r.channel
  } catch {
    /* bridge hiccup — keep defaults */
  }
}

function eventTimeLabel(ms: number): string {
  const diff = Math.max(0, Math.round((Date.now() - ms) / 1000))
  return formatAge(diff)
}
</script>

<template>
  <!-- Live region — screen-reader announcements for state transitions. -->
  <div :ref="liveRegionRef" class="ch-live-region" aria-live="polite" aria-atomic="true" />

  <!-- Show-me handle when user has hidden the panel. Small, unobtrusive. -->
  <button
    v-if="hidden"
    type="button"
    class="ch-show-handle"
    :class="stateClass"
    :title="t('connectionHealth.popover.show')"
    :aria-label="t('connectionHealth.popover.show')"
    @click="showPanel"
  >
    <span class="ch-dot" :class="stateClass" />
  </button>

  <div
    v-else
    class="ch-root"
    :class="[stateClass, { expanded }]"
    role="status"
    :aria-label="t('connectionHealth.aria.panel')"
  >
    <!-- Compact pill — always visible -->
    <button
      type="button"
      class="ch-pill"
      :class="stateClass"
      :aria-expanded="expanded ? 'true' : 'false'"
      :aria-label="expanded ? t('connectionHealth.aria.collapse') : t('connectionHealth.aria.expand')"
      @click="togglePanel"
    >
      <span class="ch-dot" :class="stateClass" />
      <span
        class="ch-channel-badge"
        :class="`channel-${channelBadge}`"
        :title="channelBadgeLabel"
        :aria-label="channelBadgeLabel"
      >
        <template v-if="channelBadge === 'ssh'">🔧</template>
        <template v-else-if="channelBadge === 'offline'">❌</template>
        <template v-else>·</template>
      </span>
      <span class="ch-summary">{{ summaryText }}</span>
      <svg class="ch-chevron" :class="{ rotated: expanded }" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>

    <!-- Expanded popover -->
    <div v-if="expanded" class="ch-popover" role="region">
      <div class="ch-pop-grid">
        <div class="ch-field">
          <span class="ch-field-label">{{ t('connectionHealth.popover.hostname') }}</span>
          <span class="ch-field-value">{{ snapshot.hostname || '—' }}</span>
        </div>
        <div class="ch-field">
          <span class="ch-field-label">{{ t('connectionHealth.popover.transport') }}</span>
          <span class="ch-field-value">{{ transportLabel }}</span>
        </div>
        <div class="ch-field">
          <span class="ch-field-label">{{ t('connectionHealth.popover.version') }}</span>
          <span class="ch-field-value">{{ snapshot.version || '—' }}</span>
        </div>
        <div class="ch-field">
          <span class="ch-field-label">{{ t('connectionHealth.popover.uptime') }}</span>
          <span class="ch-field-value">
            {{ snapshot.uptime_s !== null ? formatAge(snapshot.uptime_s) : '—' }}
          </span>
        </div>
        <div v-if="pingMs !== null" class="ch-field">
          <span class="ch-field-label">{{ t('connectionHealth.popover.pingLatency') }}</span>
          <span class="ch-field-value">{{ pingMs }} ms</span>
        </div>
      </div>

      <!-- Last observed channel summary -->
      <div class="ch-channel-row">
        <span class="ch-field-label">{{ t('connectionHealth.popover.channel') }}</span>
        <span class="ch-field-value">
          <span class="ch-channel-badge" :class="`channel-${channelBadge}`">
            <template v-if="channelBadge === 'ssh'">🔧</template>
            <template v-else-if="channelBadge === 'offline'">❌</template>
            <template v-else>·</template>
          </span>
          {{ channelBadgeLabel }}
        </span>
      </div>

      <!-- Event log -->
      <div class="ch-events">
        <div class="ch-events-head">{{ t('connectionHealth.popover.recentEvents') }}</div>
        <ul v-if="events.length" class="ch-event-list">
          <li v-for="(ev, idx) in events" :key="idx" class="ch-event-item" :class="`state-${ev.state}`">
            <span class="ch-event-dot" :class="`state-${ev.state}`" />
            <span class="ch-event-state">{{ t(`connectionHealth.state.${ev.state}`) }}</span>
            <span class="ch-event-time">{{ eventTimeLabel(ev.ts) }}</span>
            <span v-if="ev.error" class="ch-event-err">{{ ev.error }}</span>
          </li>
        </ul>
        <div v-else class="ch-no-events">{{ t('connectionHealth.popover.noEvents') }}</div>
      </div>

      <!-- Sustained-offline warning -->
      <div v-if="showEscalation" class="ch-escalation" role="alert">
        {{ t('connectionHealth.escalation') }}
      </div>

      <!-- Actions row -->
      <div class="ch-actions">
        <button type="button" class="ch-btn" :disabled="pinging" @click="pingLatency">
          {{ t('connectionHealth.popover.pingBtn') }}
        </button>
        <button type="button" class="ch-btn ch-btn-ghost" @click="hidePanel">
          {{ t('connectionHealth.popover.hide') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * Styling hews to the existing design tokens (see styles/themes.css).
 * No inline styles; no hardcoded colors beyond state-tinted backgrounds
 * which use the CSS var rgb channels used elsewhere in the app.
 */

.ch-live-region {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  border: 0;
}

.ch-root {
  position: fixed;
  bottom: 16px;
  right: 16px;
  z-index: 4000;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  font-size: 12px;
  font-family: var(--font-sans);
  color: var(--text-primary);
}

.ch-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  color: var(--text-primary);
  cursor: pointer;
  box-shadow: var(--shadow);
  transition: background 0.15s ease, border-color 0.15s ease;
  max-width: 420px;
}
.ch-pill:hover { background: var(--bg-hover); }

.ch-pill.state-online { border-color: rgba(87, 209, 140, 0.4); }
.ch-pill.state-degraded { border-color: rgba(246, 180, 84, 0.4); }
.ch-pill.state-offline,
.ch-pill.state-error { border-color: rgba(255, 107, 107, 0.45); }
.ch-pill.state-connecting,
.ch-pill.state-unknown { border-color: var(--border); }

.ch-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--text-muted);
}
.ch-dot.state-online { background: var(--success); }
.ch-dot.state-degraded { background: var(--warning); animation: ch-pulse 1.2s ease-in-out infinite; }
.ch-dot.state-offline,
.ch-dot.state-error { background: var(--danger); }
.ch-dot.state-connecting { background: var(--info); animation: ch-pulse 1s ease-in-out infinite; }
.ch-dot.state-unknown { background: var(--text-muted); }

@keyframes ch-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

.ch-summary {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  line-height: 1.4;
}

/* v1.4.19 P5 — channel badge */
.ch-channel-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border-radius: 4px;
  font-size: 11px;
  line-height: 1;
  user-select: none;
  flex-shrink: 0;
}
.ch-channel-badge.channel-agent { background: var(--info-bg, rgba(87, 176, 232, 0.12)); }
.ch-channel-badge.channel-ssh { background: var(--warning-bg, rgba(246, 180, 84, 0.12)); }
.ch-channel-badge.channel-offline { background: var(--danger-bg, rgba(255, 107, 107, 0.12)); }
.ch-channel-badge.channel-unknown { background: transparent; opacity: 0.5; }

.ch-channel-row {
  display: grid;
  grid-template-columns: auto 1fr auto 1fr;
  align-items: center;
  gap: 4px 12px;
  border-top: 1px solid var(--border-subtle);
  padding-top: 10px;
  font-size: 12px;
}

.ch-mode-link {
  margin-left: 8px;
  font-size: 10px;
  color: var(--info);
  text-decoration: none;
}
.ch-mode-link:hover {
  text-decoration: underline;
}

.ch-chevron {
  transition: transform 0.18s ease;
  flex-shrink: 0;
  opacity: 0.72;
}
.ch-chevron.rotated { transform: rotate(180deg); }

/* ---- Popover ---- */

.ch-popover {
  width: 380px;
  padding: 14px 16px 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--panel-shadow);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ch-pop-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 16px;
}

.ch-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.ch-field-label {
  font-size: 10px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.ch-field-value {
  font-size: 12px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- Events ---- */

.ch-events {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-top: 1px solid var(--border-subtle);
  padding-top: 10px;
}

.ch-events-head {
  font-size: 10px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.ch-event-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 160px;
  overflow-y: auto;
}

.ch-event-item {
  display: grid;
  grid-template-columns: 10px auto 1fr auto;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-secondary);
}

.ch-event-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
}
.ch-event-dot.state-online { background: var(--success); }
.ch-event-dot.state-degraded { background: var(--warning); }
.ch-event-dot.state-offline,
.ch-event-dot.state-error { background: var(--danger); }
.ch-event-dot.state-connecting { background: var(--info); }

.ch-event-state {
  font-weight: 500;
  color: var(--text-primary);
}

.ch-event-time {
  color: var(--text-muted);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.ch-event-err {
  grid-column: 2 / -1;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--danger);
  background: var(--danger-bg);
  padding: 1px 6px;
  border-radius: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ch-no-events {
  font-size: 11px;
  color: var(--text-muted);
  padding: 4px 0;
}

/* ---- Sustained-offline warning ---- */

.ch-escalation {
  font-size: 11px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--danger-bg);
  color: var(--danger);
  border: 1px solid rgba(255, 107, 107, 0.35);
  line-height: 1.4;
}

/* ---- Actions ---- */

.ch-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: flex-end;
}

.ch-btn {
  font-size: 11px;
  padding: 5px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg-surface);
  color: var(--text-primary);
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.ch-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  border-color: var(--border-strong);
}
.ch-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.ch-btn-ghost {
  background: transparent;
  color: var(--text-muted);
}
.ch-btn-ghost:hover:not(:disabled) {
  color: var(--text-primary);
}

/* ---- Hidden-state handle ---- */

.ch-show-handle {
  position: fixed;
  bottom: 16px;
  right: 16px;
  z-index: 4000;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  padding: 0;
  border: 1px solid var(--border);
  background: var(--bg-surface);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--shadow);
  opacity: 0.72;
  transition: opacity 0.2s ease;
}
.ch-show-handle:hover { opacity: 1; }

/* ---- Responsive — squeeze the popover on narrow windows ---- */
@media (max-width: 640px) {
  .ch-popover {
    width: calc(100vw - 32px);
    max-width: 380px;
  }
  .ch-summary {
    max-width: 200px;
  }
}
</style>
