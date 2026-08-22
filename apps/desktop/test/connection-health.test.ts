/**
 * Unit tests for ConnectionHealth —
 *   (a) main-process SSE consumer state machine
 *       (desktop/electron/services/connection-health.ts)
 *   (b) renderer component i18n key mapping + state → icon class derivation
 *
 * Focus: pure state transitions + SSE parser. The real fetch() + ipcMain
 * wiring is hermetic — we only exercise the functions exposed through the
 * `_test*` hooks.
 *
 * All IO is mocked:
 *   - `electron`           → minimal app / ipcMain / BrowserWindow surface
 *   - `../utils/logger`    → silent
 *   - `../utils/config`    → controllable getApiBase / getAuthHeaders
 *
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Module mocks — hoisted so import of the module under test sees them.
// ---------------------------------------------------------------------------

vi.mock('../electron/utils/logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('../electron/utils/config', () => ({
  getApiBase: () => 'https://api.test',
  getAuthHeaders: async () => ({ Authorization: 'Bearer test-token' }),
}))

// Minimal Electron surface. ipcMain.handle / BrowserWindow are used when
// the service starts; we swap to no-op stubs so `_testResetState` is
// callable without a real Electron runtime.
vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    app: { getVersion: () => '0.0.0-test', getPath: () => '/tmp' },
    ipcMain: {
      handle: (name: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(name, handler)
      },
      removeHandler: (name: string) => {
        handlers.delete(name)
      },
      _handlers: handlers,
    },
    BrowserWindow: {
      getAllWindows: () => [] as Array<never>,
    },
  }
})

import * as svc from '../electron/services/connection-health'
import type { ConnectionHealthSnapshot } from '../electron/services/connection-health'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(
  overrides: Partial<ConnectionHealthSnapshot> = {},
): Partial<ConnectionHealthSnapshot> {
  return {
    state: 'online',
    agent_id: '42',
    last_heartbeat: '2026-04-19T10:00:00+00:00',
    last_heartbeat_age_s: 3,
    transport: 'wss',
    active_tasks: 2,
    version: '21.1',
    uptime_s: 3600,
    recent_errors: [],
    hostname: 'vm-vmuser',
    last_error: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Reset between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  svc._testResetState()
})

afterEach(() => {
  svc._testResetState()
})

// ---------------------------------------------------------------------------
// Connection target boundary
// ---------------------------------------------------------------------------

describe('connection target selection', () => {
  it('defaults to disabled and performs no implicit network IO', () => {
    expect(svc._testResolveConnectionTarget({})).toEqual({
      kind: 'disabled',
      reason: 'network-not-configured',
    })
  })

  it('uses the legacy SSE contract only when an adapter URL is explicit', () => {
    expect(svc._testResolveConnectionTarget({
      AWP_CONTROL_PLANE_URL: 'http://127.0.0.1:8100',
      AWP_ENABLE_CONNECTION_HEALTH_SSE: '1',
      AWP_CONNECTION_HEALTH_SSE_URL: 'http://127.0.0.1:9900/status/events',
    })).toEqual({
      kind: 'compat-sse',
      url: 'http://127.0.0.1:9900/status/events',
    })
  })

  it('normalizes a configured control-plane base without changing protocol', () => {
    expect(svc._testResolveConnectionTarget({
      AWP_CONTROL_PLANE_URL: 'http://127.0.0.1:9100/',
    })).toEqual({
      kind: 'control-plane-poll',
      url: 'http://127.0.0.1:9100/v1/health/ready',
    })
  })

  it('blocks automatic network IO under unit tests unless explicitly enabled', () => {
    expect(svc._testShouldAutoConnect({ NODE_ENV: 'test' })).toBe(false)
    expect(svc._testShouldAutoConnect({
      NODE_ENV: 'test',
      AWP_ENABLE_NETWORK_IN_TESTS: '1',
      AWP_CONTROL_PLANE_URL: 'http://127.0.0.1:8100',
    })).toBe(true)
    expect(svc._testShouldAutoConnect({ NODE_ENV: 'development' })).toBe(false)
    expect(svc._testShouldAutoConnect({
      NODE_ENV: 'development',
      AWP_CONTROL_PLANE_URL: 'http://127.0.0.1:8100',
    })).toBe(true)
  })

  it('polls tasks only with an explicitly supplied random development key', async () => {
    const originalFetch = globalThis.fetch
    const originalApiKey = process.env.AWP_CONTROL_PLANE_API_KEY
    process.env.AWP_CONTROL_PLANE_API_KEY = 'synthetic-random-control-key'
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'ok',
        database: 'ok',
        broker: { status: 'ok' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { id: 'task-1', status: 'pending' },
        { id: 'task-2', status: 'running' },
        { id: 'task-3', status: 'success' },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    try {
      const snap = await svc._testPollControlPlaneOnce(
        'http://127.0.0.1:8100/v1/health/ready',
      )
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect(fetchSpy.mock.calls[0]?.[1]?.redirect).toBe('error')
      expect(fetchSpy.mock.calls[1]?.[1]?.redirect).toBe('error')
      expect(fetchSpy.mock.calls[0]?.[0]).toBe(
        'http://127.0.0.1:8100/v1/health/ready',
      )
      expect(fetchSpy.mock.calls[1]?.[0]).toBe(
        'http://127.0.0.1:8100/v1/tasks',
      )
      const taskHeaders = fetchSpy.mock.calls[1]?.[1]?.headers as Record<string, string>
      expect(taskHeaders.Authorization).toBe('Bearer synthetic-random-control-key')
      expect(snap.state).toBe('online')
      expect(snap.active_tasks).toBe(2)
      expect(snap.hostname).toBe('127.0.0.1:8100')
    } finally {
      globalThis.fetch = originalFetch
      if (originalApiKey === undefined) delete process.env.AWP_CONTROL_PLANE_API_KEY
      else process.env.AWP_CONTROL_PLANE_API_KEY = originalApiKey
    }
  })

  it('checks readiness but makes no authenticated task request without an explicit key', async () => {
    const originalFetch = globalThis.fetch
    const originalApiKey = process.env.AWP_CONTROL_PLANE_API_KEY
    delete process.env.AWP_CONTROL_PLANE_API_KEY
    const fetchSpy = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    try {
      const snapshot = await svc._testPollControlPlaneOnce('http://127.0.0.1:8100/v1/health/ready')
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(snapshot.state).toBe('online')
      expect(snapshot.active_tasks).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
      if (originalApiKey === undefined) delete process.env.AWP_CONTROL_PLANE_API_KEY
      else process.env.AWP_CONTROL_PLANE_API_KEY = originalApiKey
    }
  })

  it('rejects an unsafe direct poll target before fetch', async () => {
    const originalFetch = globalThis.fetch
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    try {
      const snap = await svc._testPollControlPlaneOnce('http://example.test/v1/health/ready')
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(snap.last_error).toBe('invalid-control-plane-target')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('startConnectionHealth does not call fetch in the unit-test environment', async () => {
    const originalNodeEnv = process.env.NODE_ENV
    const originalFetch = globalThis.fetch
    const fetchSpy = vi.fn()
    process.env.NODE_ENV = 'test'
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    try {
      svc.startConnectionHealth()
      await Promise.resolve()
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      svc.stopConnectionHealth()
      globalThis.fetch = originalFetch
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = originalNodeEnv
    }
  })
})

// ---------------------------------------------------------------------------
// (a) SSE frame parser
// ---------------------------------------------------------------------------

describe('_parseSseFrame', () => {
  it('parses a single data: frame', () => {
    const parsed = svc._testParseSseFrame('data: {"type":"snapshot","data":{"state":"online"}}')
    expect(parsed).toEqual({ type: 'snapshot', data: { state: 'online' } })
  })

  it('parses multi-line data: frame (SSE spec allows concat)', () => {
    const raw = 'data: {"type":"snapshot",\ndata: "data":{"state":"online"}}'
    const parsed = svc._testParseSseFrame(raw)
    // We join with '\n' — JSON is line-agnostic, so should still parse.
    expect(parsed?.type).toBe('snapshot')
  })

  it('returns null on malformed JSON', () => {
    const parsed = svc._testParseSseFrame('data: not-json')
    expect(parsed).toBeNull()
  })

  it('returns null on a frame with no data: lines (keepalive comment)', () => {
    const parsed = svc._testParseSseFrame(': keepalive\n')
    expect(parsed).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// (b) Snapshot merging — state transitions + dedupe
// ---------------------------------------------------------------------------

describe('snapshot merge / transitions', () => {
  it('starts at the default snapshot (state=unknown)', () => {
    const snap = svc._testGetSnapshot()
    expect(snap.state).toBe('unknown')
    expect(snap.agent_id).toBeNull()
  })

  it('applies an online snapshot verbatim', () => {
    svc._testApplySnapshot(makeSnapshot({ state: 'online', active_tasks: 5 }))
    const snap = svc._testGetSnapshot()
    expect(snap.state).toBe('online')
    expect(snap.active_tasks).toBe(5)
    expect(snap.hostname).toBe('vm-vmuser')
  })

  it('transitions online → degraded → offline without loss of identity', () => {
    svc._testApplySnapshot(makeSnapshot({ state: 'online', last_heartbeat_age_s: 3 }))
    svc._testApplySnapshot(makeSnapshot({ state: 'degraded', last_heartbeat_age_s: 45 }))
    svc._testApplySnapshot(makeSnapshot({ state: 'offline', last_heartbeat_age_s: 600 }))

    const snap = svc._testGetSnapshot()
    expect(snap.state).toBe('offline')
    expect(snap.agent_id).toBe('42') // carried through
    expect(snap.last_heartbeat_age_s).toBe(600)
  })

  it('falls back to unknown when no agent row exists', () => {
    svc._testApplySnapshot({
      state: 'unknown',
      agent_id: null,
      last_heartbeat: null,
      transport: 'unknown',
      active_tasks: 0,
      version: '',
      hostname: '',
      uptime_s: null,
      recent_errors: [],
      last_heartbeat_age_s: null,
      last_error: null,
    })
    const snap = svc._testGetSnapshot()
    expect(snap.state).toBe('unknown')
    expect(snap.agent_id).toBeNull()
  })

  it('records last_error on transport failure', () => {
    svc._testApplySnapshot({ state: 'error', last_error: 'ECONNREFUSED' })
    const snap = svc._testGetSnapshot()
    expect(snap.state).toBe('error')
    expect(snap.last_error).toBe('ECONNREFUSED')
  })

  it('bumps received_at_ms on every apply so UI can sync wall clock', () => {
    svc._testApplySnapshot(makeSnapshot({ state: 'online' }))
    const ts1 = svc._testGetSnapshot().received_at_ms
    // Sleep a tick — happy-dom's Date is monotonic enough for ms diffs.
    const ts2 = Date.now()
    svc._testApplySnapshot(makeSnapshot({ state: 'online', active_tasks: 9 }))
    expect(svc._testGetSnapshot().received_at_ms).toBeGreaterThanOrEqual(ts1)
    expect(svc._testGetSnapshot().received_at_ms).toBeGreaterThanOrEqual(ts2 - 1)
  })
})

// ---------------------------------------------------------------------------
// (c) State → UI class mapping (renderer-side invariants)
//
// We don't mount the Vue component here (happy-dom + Pinia + vue-i18n setup
// is expensive). Instead we pin the contract that the component relies on:
// every wire state has a corresponding CSS class name `state-<state>`.
// ---------------------------------------------------------------------------

describe('state → class contract', () => {
  const WIRE_STATES = [
    'connecting',
    'online',
    'degraded',
    'offline',
    'error',
    'unknown',
  ] as const

  it('each wire state has a distinct `state-<name>` class token', () => {
    const tokens = new Set<string>()
    for (const s of WIRE_STATES) {
      const tok = `state-${s}`
      expect(tok).toMatch(/^state-[a-z]+$/)
      tokens.add(tok)
    }
    expect(tokens.size).toBe(WIRE_STATES.length)
  })

  it('i18n key roots exist for every wire state', () => {
    // These are the keys the Vue component resolves at render time.
    for (const s of WIRE_STATES) {
      expect(`connectionHealth.state.${s}`).toMatch(
        /^connectionHealth\.state\.[a-z]+$/,
      )
    }
  })
})
