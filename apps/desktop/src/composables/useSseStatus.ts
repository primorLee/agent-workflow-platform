/**
 * useSseStatus — lightweight composable for the top-right status dot.
 *
 * Wraps the existing `connection-health` IPC surface (see
 * electron/services/connection-health.ts) and collapses the 6-way wire state
 * (`connecting | online | degraded | offline | error | unknown`) into a
 * 4-way UI bucket that can be read at a glance:
 *
 *   - `ready`         🟢 cloud SSE is delivering snapshots, agent is online
 *                        or degraded (degraded still means we have a channel)
 *   - `reconnecting`  🟡 the renderer has a snapshot but it's stale — we are
 *                        either in exponential backoff inside the main-process
 *                        SSE loop, or the server reported `connecting`
 *   - `down`          🔴 offline or transport error (agent timed out, auth
 *                        failed, cloud unreachable)
 *   - `init`          ⚪ very first <10s of app lifetime before any snapshot
 *                        has arrived — avoids flashing red on every launch
 *
 * The composable is deliberately thin: it relies on the main-process cache
 * for first paint and on `connection-health:update` for live updates. No
 * polling, no additional IPC round trips beyond the initial `get_connection_health()`.
 *
 * Test hook: the composable can be instantiated inside a setup script and
 * unit-tested by simulating `bridge.on_connection_health(cb)` invocations.
 *
 * Initialization regression: a healthy event stream may emit `state='unknown'`
 * before a worker has registered. Mapping that state to `reconnecting` leaves
 * the renderer stuck on an amber status even though the stream is healthy.
 *
 * The fix distinguishes authentication failures from a healthy stream with no
 * registered worker. Only the former remains in reconnecting state.
 *
 *
 *   Fix: distinguish main-process `unknown` (pre-auth / auth failure — these
 *   carry `last_error` like 'not-authenticated' / 'auth-401') from
 *   server-emitted `unknown` (no worker row, `last_error` is null). The
 *   former stays amber ("重连中"); the latter becomes `init` ("等待本地
 *   Agent 注册"). Green/ready still requires a live heartbeat.
 */

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { waitForBridge } from '@/bridge'
import type {
  ConnectionHealthSnapshot,
  ConnectionHealthState,
} from '@/types/bridge'

export type SseUiStatus = 'init' | 'ready' | 'reconnecting' | 'down'

export interface UseSseStatusReturn {
  /** 4-way UI bucket — what the status dot should render. */
  status: ComputedRef<SseUiStatus>
  /** Last snapshot — `null` until the first one arrives. */
  snapshot: Ref<ConnectionHealthSnapshot | null>
  /**
   * Short, translatable-ready tooltip blurb. Renderer layers proper i18n
   * over this; we keep the raw strings here so the composable stays testable
   * without pulling vue-i18n.
   */
  tooltip: ComputedRef<string>
  /** Seconds since the last snapshot was received — null when no snapshot yet. */
  secondsSinceLastEvent: ComputedRef<number | null>
}

// Window during which a total absence of snapshots is treated as "initializing"
// rather than "down". Matches the 1s startup delay inside
// electron/services/connection-health.ts::startConnectionHealth() plus two
// seconds of backoff slack so we don't flash red on cold start.
const INIT_GRACE_MS = 10_000

export function useSseStatus(): UseSseStatusReturn {
  const snapshot = ref<ConnectionHealthSnapshot | null>(null)
  const mountedAtMs = ref<number>(Date.now())
  // Wall clock ticker — the status bucket depends on "seconds since last event"
  // which only changes with time. 1s cadence matches the existing
  // ConnectionHealth popover and costs nothing on the renderer.
  const nowMs = ref<number>(Date.now())
  let unsubscribe: (() => void) | null = null
  let tickTimer: ReturnType<typeof setInterval> | null = null

  function applySnapshot(snap: ConnectionHealthSnapshot): void {
    snapshot.value = snap
  }

  onMounted(async () => {
    mountedAtMs.value = Date.now()
    // Tick every second so the "reconnecting for N seconds" text stays live.
    tickTimer = setInterval(() => {
      nowMs.value = Date.now()
    }, 1_000)

    const bridge = await waitForBridge(3_000)
    if (!bridge) return

    // First paint — fill from the main-process cache if available, so the
    // dot doesn't flicker on mount.
    if (bridge.get_connection_health) {
      try {
        const cached = (await bridge.get_connection_health()) as
          | ConnectionHealthSnapshot
          | null
        if (cached) applySnapshot(cached)
      } catch {
        /* bridge hiccup — subscribe anyway */
      }
    }

    // Live subscription.
    if (bridge.on_connection_health) {
      unsubscribe = bridge.on_connection_health((raw) => {
        applySnapshot(raw as ConnectionHealthSnapshot)
      })
    }
  })

  onBeforeUnmount(() => {
    if (unsubscribe) {
      try {
        unsubscribe()
      } catch {
        /* noop */
      }
      unsubscribe = null
    }
    if (tickTimer) {
      clearInterval(tickTimer)
      tickTimer = null
    }
  })

  const secondsSinceLastEvent = computed<number | null>(() => {
    const snap = snapshot.value
    if (!snap || !snap.received_at_ms) return null
    return Math.max(0, Math.round((nowMs.value - snap.received_at_ms) / 1000))
  })

  const status = computed<SseUiStatus>(() => {
    const snap = snapshot.value

    // No snapshot yet. If we're still inside the startup grace window, stay
    // white (init). Otherwise assume the main process couldn't connect at all
    // and promote to red.
    if (!snap || !snap.received_at_ms) {
      return nowMs.value - mountedAtMs.value < INIT_GRACE_MS ? 'init' : 'down'
    }

    return mapServerStateToUi(snap.state, snap.last_error)
  })

  const tooltip = computed<string>(() => {
    const s = status.value
    const snap = snapshot.value
    // Distinguish "no agent registered yet" from "still bootstrapping":
    // server-emitted `unknown` with null last_error means the cloud SSE is
    // live but the session has no active worker row. We surface that as
    // `init` bucket and use a distinct tooltip.
    if (s === 'init') {
      if (
        snap &&
        snap.state === 'unknown' &&
        !isAuthError(snap.last_error) &&
        snap.received_at_ms
      ) {
        return '云端 SSE: 已连接 · 等待本地 VM Agent 注册'
      }
      return '云端 SSE: 正在初始化'
    }
    if (s === 'ready') {
      const age = snap?.last_heartbeat_age_s
      if (age !== null && age !== undefined) {
        return `云端 SSE: 已连接 · 最近心跳 ${formatAge(age)}`
      }
      return '云端 SSE: 已连接'
    }
    if (s === 'reconnecting') {
      const secs = secondsSinceLastEvent.value
      const tail = secs !== null ? ` ${secs} 秒` : ''
      return `云端 SSE: 重连中${tail}`
    }
    // s === 'down'
    const err = snap?.last_error
    if (err) return `云端 SSE: 已断线 (${err}) — 检查网络或重启 app`
    return '云端 SSE: 已断线 — 检查网络或重启 app'
  })

  return { status, snapshot, tooltip, secondsSinceLastEvent }
}

// ---------------------------------------------------------------------------
// Internal — exported for unit tests
// ---------------------------------------------------------------------------

/**
 * Auth-failure `last_error` values set by electron/services/connection-health.ts
 * when it emits a local `state='unknown'` patch. Non-exhaustive; any string
 * starting with `auth-` or equal to `not-authenticated` counts as auth-related.
 */
export function isAuthError(lastError: string | null | undefined): boolean {
  if (!lastError) return false
  return lastError === 'not-authenticated' || lastError.startsWith('auth-')
}

export function mapServerStateToUi(
  state: ConnectionHealthState,
  lastError: string | null = null,
): SseUiStatus {
  switch (state) {
    case 'online':
    case 'degraded':
      // Degraded still means events are flowing; surface as green with the
      // tooltip doing the finer-grained reporting. We don't want the dot
      // bouncing between amber/green on every transport dip.
      return 'ready'
    case 'connecting':
      return 'reconnecting'
    case 'offline':
    case 'error':
      return 'down'
    case 'unknown':
    default:
      // Two distinct `unknown` sources:
      //   1. Main-process SSE loop couldn't authenticate (pre-login or token
      //      expired) — `last_error` is 'not-authenticated' / 'auth-401' /
      //      'auth-403'. Amber/reconnecting is correct: the user *should* see
      //      the app trying to come up.
      //   2. Server reports `unknown` because no agent row exists for the
      //      session yet. `last_error` is
      //      null. The cloud SSE channel itself is alive — what's missing is
      //      the downstream VM agent. Falling back to `init` (white, no
      //      pulse) avoids the "forever 重连中" misleading status regression.
      return isAuthError(lastError) ? 'reconnecting' : 'init'
  }
}

function formatAge(seconds: number): string {
  if (seconds < 5) return '刚刚'
  if (seconds < 60) return `${Math.round(seconds)} 秒前`
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} 小时前`
  return `${Math.round(seconds / 86_400)} 天前`
}
