/**
 * Regression coverage for graceful desktop shutdown.
 * Live CLI sessions must drain, but a stuck child must never block app quit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const callOrder: string[] = []
  return {
    callOrder,
    stopAllSessions: vi.fn<() => Promise<void>>(async () => { callOrder.push('sessions') }),
    stopAutoUpdater: vi.fn(),
    stopConnectionHealth: vi.fn(() => { callOrder.push('connections') }),
    stopAwpIdeServer: vi.fn(async () => undefined),
  }
})

vi.mock('../auto-updater', () => ({ startAutoUpdater: vi.fn(), stopAutoUpdater: mocks.stopAutoUpdater }))
vi.mock('../connection-health', () => ({
  startConnectionHealth: vi.fn(),
  stopConnectionHealth: mocks.stopConnectionHealth,
}))
vi.mock('../awp-ide-server', () => ({
  startAwpIdeServer: vi.fn(async () => ({ url: 'http://127.0.0.1:0', lockPath: 'synthetic.lock' })),
  stopAwpIdeServer: mocks.stopAwpIdeServer,
}))
vi.mock('../awp-ide-server/tools', () => ({
  dispatchAwpIdeTool: vi.fn(async () => ({ isError: false, content: [{ type: 'text', text: '{}' }] })),
}))
vi.mock('../startup-diagnostic', () => ({
  runStartupDiagnostic: vi.fn(async () => ({ ok: true, warnings: [], failures: [] })),
  showStartupDiagnosticDialog: vi.fn(),
}))
vi.mock('../connectivity-check', () => ({
  runConnectivityCheck: vi.fn(async () => ({ ok: true })),
  getLastConnectivityResult: vi.fn(() => null),
}))
vi.mock('../../cc/cc-runtime-updater', () => ({
  ensureInstalled: vi.fn(async () => ({ ok: true })),
  setProgressBroadcast: vi.fn(),
}))
vi.mock('../../cc/cc-runtime-handlers', () => ({ registerCcRuntimeHandlers: vi.fn() }))
vi.mock('../../cc/cc-wrapper', () => ({ stopAllSessions: mocks.stopAllSessions }))
vi.mock('../../utils/config', () => ({ getAuthPath: () => 'Z:\\nonexistent\\auth.json' }))
vi.mock('../../utils/logger', () => ({ log: vi.fn(), logError: vi.fn() }))
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test' },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}))

async function primeStarted() {
  const service = await import('../index')
  await service.startServices()
  return service
}

describe('stopServices CLI drain', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.stopAllSessions.mockReset()
    mocks.callOrder.length = 0
    mocks.stopAllSessions.mockImplementation(async () => { mocks.callOrder.push('sessions') })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('drains active CLI sessions and stops background services', async () => {
    const { stopServices } = await primeStarted()
    await stopServices()
    expect(mocks.stopAllSessions).toHaveBeenCalledTimes(1)
    expect(mocks.callOrder.indexOf('sessions')).toBeLessThan(mocks.callOrder.indexOf('connections'))
    expect(mocks.stopConnectionHealth).toHaveBeenCalledTimes(1)
    expect(mocks.stopAwpIdeServer).toHaveBeenCalledTimes(1)
    expect(mocks.stopAutoUpdater).toHaveBeenCalledTimes(1)
  })

  it('continues stopping services after a CLI drain error', async () => {
    mocks.stopAllSessions.mockRejectedValueOnce(new Error('synthetic drain failure'))
    const { stopServices } = await primeStarted()
    await expect(stopServices()).resolves.toBeUndefined()
    expect(mocks.stopConnectionHealth).toHaveBeenCalledTimes(1)
    expect(mocks.stopAllSessions).toHaveBeenCalledTimes(1)
  })

  it('caps a stuck drain at five seconds', async () => {
    vi.useFakeTimers()
    mocks.stopAllSessions.mockImplementationOnce(() => new Promise(() => {}))
    const { stopServices } = await primeStarted()
    const done = vi.fn()
    const pending = stopServices().then(done)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_100)
    await pending
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('is idempotent after the first stop', async () => {
    const { stopServices } = await primeStarted()
    await stopServices()
    await stopServices()
    expect(mocks.stopAllSessions).toHaveBeenCalledTimes(1)
  })
})