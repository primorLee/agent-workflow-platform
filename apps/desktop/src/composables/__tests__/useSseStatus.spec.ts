/**
 * Regression spec for an initialization state that previously rendered as a permanent reconnect.
 *
 * The service may emit `state='unknown'` before a worker has registered.
 * Before the fix, `mapServerStateToUi` unconditionally mapped
 * `unknown → reconnecting`, so a healthy event stream rendered as a permanent
 * amber reconnect state.
 *
 *
 *
 * These unit tests nail down the new contract of `mapServerStateToUi`:
 *
 *   - `online` / `degraded`  → `ready` (green)
 *   - `connecting`           → `reconnecting` (amber)
 *   - `offline` / `error`    → `down` (red)
 *   - `unknown` + auth error → `reconnecting` (amber — user is pre-login /
 *                             token expired, we're trying to recover)
 *   - `unknown` + no error   → `init` (white — no agent registered yet; the
 *                             cloud SSE itself is fine, we just don't have
 *                             a VM agent to report on)
 *
 * Plus a state-machine smoke: the full transition
 *   init → connecting → connected → reconnecting → connected
 * is observable through the composable when snapshots flow in over time.
 *
 * We drive the composable inside a synthetic Vue component so `onMounted`
 * hooks run, matching the house style set by `useVmSetupNotifications.spec.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'

import type { ConnectionHealthSnapshot } from '@/types/bridge'

// -----------------------------------------------------------------------
// Bridge stub — owns the subscription callback registry so tests can push
// snapshot events at will. waitForBridge resolves to this fake bridge.
// -----------------------------------------------------------------------

const H = vi.hoisted(() => ({
  subscribers: [] as Array<(snap: ConnectionHealthSnapshot) => void>,
  unsubscribe: vi.fn(),
  get_connection_health: vi.fn(async () => null as ConnectionHealthSnapshot | null),
  on_connection_health: vi.fn(
    (cb: (snap: ConnectionHealthSnapshot) => void) => {
      H.subscribers.push(cb)
      return H.unsubscribe
    },
  ),
}))

vi.mock('@/bridge', () => ({
  waitForBridge: vi.fn(async () => ({
    get_connection_health: H.get_connection_health,
    on_connection_health: H.on_connection_health,
  })),
}))

import {
  mapServerStateToUi,
  isAuthError,
  useSseStatus,
  type SseUiStatus,
} from '../useSseStatus'

function makeSnapshot(
  overrides: Partial<ConnectionHealthSnapshot> = {},
): ConnectionHealthSnapshot {
  return {
    state: 'online',
    agent_id: null,
    last_heartbeat: null,
    last_heartbeat_age_s: null,
    transport: 'unknown',
    active_tasks: 0,
    version: '',
    uptime_s: null,
    recent_errors: [],
    hostname: '',
    received_at_ms: Date.now(),
    last_error: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Pure mapper — the load-bearing function for the initialization regression.
// ---------------------------------------------------------------------------

describe('mapServerStateToUi', () => {
  it('online → ready', () => {
    expect(mapServerStateToUi('online')).toBe<SseUiStatus>('ready')
  })
  it('degraded → ready (still delivering events)', () => {
    expect(mapServerStateToUi('degraded')).toBe<SseUiStatus>('ready')
  })
  it('connecting → reconnecting', () => {
    expect(mapServerStateToUi('connecting')).toBe<SseUiStatus>('reconnecting')
  })
  it('offline → down', () => {
    expect(mapServerStateToUi('offline')).toBe<SseUiStatus>('down')
  })
  it('error → down', () => {
    expect(mapServerStateToUi('error')).toBe<SseUiStatus>('down')
  })

  // THE BUG FIX — this was `reconnecting` before and stuck the dot amber forever
  // for any session without a registered worker.
  it('unknown + no last_error → init (server has no agent row; SSE itself is fine)', () => {
    expect(mapServerStateToUi('unknown', null)).toBe<SseUiStatus>('init')
    expect(mapServerStateToUi('unknown')).toBe<SseUiStatus>('init')
    expect(mapServerStateToUi('unknown', '')).toBe<SseUiStatus>('init')
  })

  it('unknown + auth last_error → reconnecting (we are trying to recover)', () => {
    expect(mapServerStateToUi('unknown', 'not-authenticated')).toBe<SseUiStatus>(
      'reconnecting',
    )
    expect(mapServerStateToUi('unknown', 'auth-401')).toBe<SseUiStatus>(
      'reconnecting',
    )
    expect(mapServerStateToUi('unknown', 'auth-403')).toBe<SseUiStatus>(
      'reconnecting',
    )
  })

  it('unknown + non-auth last_error → init (non-auth errors imply no agent row)', () => {
    // Defensive: the main-process code only sets last_error for HTTP / network
    // failures which already remap state to 'error'. If some unknown snapshot
    // somehow carried a non-auth last_error, treat it like "no agent".
    expect(mapServerStateToUi('unknown', 'network-hiccup')).toBe<SseUiStatus>(
      'init',
    )
  })
})

describe('isAuthError', () => {
  it('matches the main-process emitters', () => {
    expect(isAuthError('not-authenticated')).toBe(true)
    expect(isAuthError('auth-401')).toBe(true)
    expect(isAuthError('auth-403')).toBe(true)
  })
  it('rejects non-auth strings and empty values', () => {
    expect(isAuthError('')).toBe(false)
    expect(isAuthError(null)).toBe(false)
    expect(isAuthError(undefined)).toBe(false)
    expect(isAuthError('stream-closed')).toBe(false)
    expect(isAuthError('http-500')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Full composable — drives onMounted, subscribes, transitions the dot.
// ---------------------------------------------------------------------------

describe('useSseStatus state machine', () => {
  beforeEach(() => {
    H.subscribers.length = 0
    H.unsubscribe.mockClear()
    H.on_connection_health.mockClear()
    H.get_connection_health.mockClear()
    H.get_connection_health.mockResolvedValue(null)
  })

  async function mountComposable(): Promise<{
    result: ReturnType<typeof useSseStatus>
    app: ReturnType<typeof createApp>
  }> {
    let captured: ReturnType<typeof useSseStatus> | null = null
    const Host = defineComponent({
      setup() {
        captured = useSseStatus()
        return () => h('div')
      },
    })
    const app = createApp(Host)
    const root = document.createElement('div')
    app.mount(root)
    // Flush onMounted -> waitForBridge -> applySnapshot + subscribe.
    await nextTick()
    await new Promise((r) => setTimeout(r, 0))
    await nextTick()
    if (!captured) throw new Error('composable did not execute')
    return { result: captured, app }
  }

  it('init → ready when an online snapshot arrives', async () => {
    const { result, app } = await mountComposable()
    expect(result.status.value).toBe('init')
    H.subscribers[0]!(makeSnapshot({ state: 'online', last_heartbeat_age_s: 1 }))
    await nextTick()
    expect(result.status.value).toBe('ready')
    expect(result.tooltip.value).toContain('已连接')
    app.unmount()
  })

  it('ready → reconnecting when server switches to connecting', async () => {
    const { result, app } = await mountComposable()
    H.subscribers[0]!(makeSnapshot({ state: 'online' }))
    await nextTick()
    expect(result.status.value).toBe('ready')
    H.subscribers[0]!(makeSnapshot({ state: 'connecting' }))
    await nextTick()
    expect(result.status.value).toBe('reconnecting')
    expect(result.tooltip.value).toContain('重连中')
    app.unmount()
  })

  it('reconnecting → ready on the next online snapshot (never sticks)', async () => {
    const { result, app } = await mountComposable()
    H.subscribers[0]!(makeSnapshot({ state: 'connecting' }))
    await nextTick()
    expect(result.status.value).toBe('reconnecting')
    H.subscribers[0]!(makeSnapshot({ state: 'online', last_heartbeat_age_s: 0 }))
    await nextTick()
    expect(result.status.value).toBe('ready')
    app.unmount()
  })

  it("state='unknown' with no last_error shows init, NOT reconnecting", async () => {
    // This is the payload emitted before the session has a registered worker.
    //
    const { result, app } = await mountComposable()
    H.subscribers[0]!(
      makeSnapshot({ state: 'unknown', last_error: null, agent_id: null }),
    )
    await nextTick()
    expect(result.status.value).toBe('init')
    // Tooltip must tell them WHY it's white rather than implying a reconnect.
    expect(result.tooltip.value).toContain('等待本地 VM Agent 注册')
    expect(result.tooltip.value).not.toContain('重连中')
    app.unmount()
  })

  it("auth variant: state='unknown' with auth error still shows reconnecting", async () => {
    const { result, app } = await mountComposable()
    H.subscribers[0]!(
      makeSnapshot({ state: 'unknown', last_error: 'auth-401' }),
    )
    await nextTick()
    expect(result.status.value).toBe('reconnecting')
    expect(result.tooltip.value).toContain('重连中')
    app.unmount()
  })
})
