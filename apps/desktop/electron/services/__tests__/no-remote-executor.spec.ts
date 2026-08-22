/**
 * F2 P0 regression (2026-04-19, ADR-20260419).
 *
 * The client-side remote-executor poll loop against /v1/remote/pending was
 * removed in v1.4.14 after the 2026-04-19 industrial-grade audit found it
 * was a de-facto C2 channel gated only by a bearer token. The server-side
 * 503 gate in cloud/routes/remote_exec.py (v1.4.13) is covered by
 * cloud/tests/test_remote_exec_gate.py; this file guards the client tier.
 *
 * Invariants enforced:
 *
 *   1. `electron/services/remote-executor.ts` is absent from the repo.
 *   2. `startServices()` issues zero fetches to the OLD /v1/remote/pending
 *      (or any non-diag /v1/remote/* path) even after advancing fake
 *      timers well past the old 10 s init delay + several old 3 s poll
 *      ticks. No replacement remote polling channel exists in the public client.
 *
 * Cascade items that auto-close with F2:
 *   - S6 (parser validation of remote-supplied cmd strings): moot, no poll
 *   - S8 (outer silent catch in pollAndExecute): moot, function deleted
 *   - S9 (fire-and-forget register-app .catch(()=>{})): moot, call deleted
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'

vi.mock('../auto-updater', () => ({
  startAutoUpdater: vi.fn(),
  stopAutoUpdater: vi.fn(),
}))
vi.mock('../tunnel-keepalive', () => ({
  startTunnelKeepalive: vi.fn(),
  stopTunnelKeepalive: vi.fn(),
}))
vi.mock('../gateway-keepalive', () => ({
  startGatewayKeepalive: vi.fn(),
  stopGatewayKeepalive: vi.fn(),
  getGatewayClient: vi.fn(() => null),
  getGatewayTransport: vi.fn(() => null),
}))
vi.mock('../startup-diagnostic', () => ({
  runStartupDiagnostic: vi.fn(async () => ({ ok: true, failures: [], warnings: [] })),
  showStartupDiagnosticDialog: vi.fn(),
}))
vi.mock('../connectivity-check', () => ({
  runConnectivityCheck: vi.fn(async () => ({
    cloud_http: 'ok', cloud_sse: 'skipped', vm_ssh: 'skipped',
    details: {}, checked_at_ms: 0,
  })),
  getLastConnectivityResult: vi.fn(() => null),
}))
vi.mock('../awp-ide-server', () => ({
  startAwpIdeServer: vi.fn(async () => ({
    url: 'http://127.0.0.1:0', lockPath: 'synthetic-test-lock',
  })),
  stopAwpIdeServer: vi.fn(async () => undefined),
}))
vi.mock('../../cc/cc-runtime-updater', () => ({
  ensureInstalled: vi.fn(async () => ({ ok: true, status: 'already-installed' })),
  setProgressBroadcast: vi.fn(),
}))
vi.mock('../../cc/cc-runtime-handlers', () => ({
  registerCcRuntimeHandlers: vi.fn(),
}))
vi.mock('../../cc/cc-wrapper', () => ({
  stopAllSessions: vi.fn(async () => undefined),
}))
// 2026-06-10 fix: startServices() step 7 starts connection-health, whose
// startConnectionHealth() registers an ipcMain.handle — but the 'electron'
// module is not (and should not be) fully emulated in this spec. The async
// rejection ("Cannot read properties of undefined (reading 'handle')")
// surfaced as a vitest Unhandled Rejection that reddened otherwise-green
// runs. connection-health is irrelevant to the F2 remote-executor assertion
// — mock its lifecycle out like the other service stoppers above.
vi.mock('../connection-health', () => ({
  startConnectionHealth: vi.fn(),
  stopConnectionHealth: vi.fn(),
}))

vi.mock('../../utils/logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}))

const fetchMock = vi.fn()

describe('F2 regression: remote-executor removal', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('AbortSignal', {
      timeout: vi.fn(() => undefined as unknown as AbortSignal),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.resetAllMocks()
  })

  it('the source file remote-executor.ts is absent from the repo', () => {
    const filePath = path.resolve(__dirname, '..', 'remote-executor.ts')
    expect(existsSync(filePath)).toBe(false)
  })

  it('startServices() issues no request to a remote command channel', async () => {
    vi.useFakeTimers()

    const { startServices, stopServices } = await import('../index')
    // Await startup so every fire-and-forget initializer captures the mocked
    // network surface before afterEach restores real globals.
    await startServices()

    await vi.advanceTimersByTimeAsync(30_000)
    for (let i = 0; i < 32; i++) await Promise.resolve()

    // Any request below /v1/remote/ would reintroduce a background command channel.
    const offendingCalls = fetchMock.mock.calls.filter((c) => {
      const url = typeof c[0] === 'string' ? c[0] : ''
      return url.includes('/v1/remote/')
    })
    expect(offendingCalls).toEqual([])

    await stopServices()
    // 2026-06-10: 15s budget — under a fully-parallel suite run the default
    // 5s flakes on loaded runners (observed 5006ms locally + in CI).
  }, 15_000)
})
