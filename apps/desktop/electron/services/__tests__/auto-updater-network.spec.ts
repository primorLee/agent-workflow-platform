import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowDowngrade: true,
    setFeedURL: vi.fn(),
    on: vi.fn(),
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
  },
  log: vi.fn(),
  showMessageBox: vi.fn(async () => ({ response: 1 })),
}))

vi.mock('electron-updater', () => ({ autoUpdater: mocks.autoUpdater }))
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
    getFocusedWindow: vi.fn(() => null),
  },
  dialog: { showMessageBox: mocks.showMessageBox },
}))
vi.mock('../../utils/logger', () => ({ log: mocks.log }))

const ENV_KEYS = [
  'AWP_CHANNEL',
  'AWP_UPDATE_URL',
  'AWP_UPDATE_INSIDERS_URL',
] as const

let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetModules()
  originalEnv = {}
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key]
    delete process.env[key]
  }

  mocks.autoUpdater.autoDownload = false
  mocks.autoUpdater.autoInstallOnAppQuit = false
  mocks.autoUpdater.allowDowngrade = true
  mocks.autoUpdater.setFeedURL.mockReset()
  mocks.autoUpdater.on.mockReset()
  mocks.autoUpdater.checkForUpdates.mockReset().mockResolvedValue(null)
  mocks.autoUpdater.downloadUpdate.mockReset().mockResolvedValue([])
  mocks.autoUpdater.quitAndInstall.mockReset()
  mocks.log.mockReset()
  mocks.showMessageBox.mockReset().mockResolvedValue({ response: 1 })
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  for (const key of ENV_KEYS) {
    const previous = originalEnv[key]
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
})

describe('normalizeUpdateFeedUrl', () => {
  it.each([
    ['https://Updates.Example.test:443/releases/./stable/', 'https://updates.example.test/releases/stable'],
    ['http://localhost:8787/releases/', 'http://localhost:8787/releases'],
    ['http://127.0.0.1:8100/', 'http://127.0.0.1:8100'],
    ['http://[0:0:0:0:0:0:0:1]:8787/releases/', 'http://[::1]:8787/releases'],
  ])('returns a canonical feed URL and path for %s', async (raw, expected) => {
    const { normalizeUpdateFeedUrl } = await import('../auto-updater')
    expect(normalizeUpdateFeedUrl(raw)).toBe(expected)
  })

  it.each([
    '',
    ' https://updates.example.test/releases',
    'https://updates.example.test/releases ',
    'http://updates.example.test/releases',
    'http://localhost.evil.test/releases',
    'http://127.1/releases',
    'http://2130706433/releases',
    'http://0177.0.0.1/releases',
    ['https://user', 'pass@updates.example.test/releases'].join(':'),
    'https://updates.example.test/releases?token=value',
    'https://updates.example.test/releases#fragment',
    'https://updates.example.test\\@other.example.test/releases',
    'https://updates.example.test/%ZZ',
    'https://updates.example.test/%0aescape',
    'https://updates.example.test/%5cescape',
    'https://updates.example.test/%2f%2fother.example.test',
    'https://updates.example.test//other.example.test',
    'https://updates.example.test:0/releases',
    'file:///tmp/releases',
  ])('rejects unsafe or ambiguous input without throwing: %s', async (raw) => {
    const { normalizeUpdateFeedUrl } = await import('../auto-updater')
    expect(normalizeUpdateFeedUrl(raw)).toBeNull()
  })
})

describe('auto updater feed network gate', () => {
  it('makes zero updater calls when no feed is configured', async () => {
    const { startAutoUpdater } = await import('../auto-updater')
    startAutoUpdater()
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000)

    expect(mocks.autoUpdater.setFeedURL).not.toHaveBeenCalled()
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('applies the canonical stable feed before the delayed first check', async () => {
    process.env.AWP_UPDATE_URL = 'https://Updates.Example.test:443/releases/stable/'
    const { startAutoUpdater, stopAutoUpdater } = await import('../auto-updater')
    startAutoUpdater()

    expect(mocks.autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://updates.example.test/releases/stable',
    })
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledOnce()
    expect(mocks.log.mock.calls.flat().join(' ')).not.toContain('updates.example.test')
    stopAutoUpdater()
  })

  it('keeps the insiders channel and feed isolated', async () => {
    process.env.AWP_CHANNEL = 'insiders'
    process.env.AWP_UPDATE_URL = 'https://stable.example.test/releases'
    process.env.AWP_UPDATE_INSIDERS_URL = 'https://preview.example.test/releases/'
    const { startAutoUpdater, stopAutoUpdater } = await import('../auto-updater')
    startAutoUpdater()

    expect(mocks.autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://preview.example.test/releases',
      channel: 'insiders',
    })
    stopAutoUpdater()
  })

  it('makes zero network calls for an invalid explicit feed', async () => {
    process.env.AWP_UPDATE_URL = 'http://updates.example.test/releases'
    const { startAutoUpdater } = await import('../auto-updater')
    startAutoUpdater()
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000)

    expect(mocks.autoUpdater.setFeedURL).not.toHaveBeenCalled()
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('does not schedule a check when electron-updater rejects the feed', async () => {
    process.env.AWP_UPDATE_URL = 'https://updates.example.test/releases'
    mocks.autoUpdater.setFeedURL.mockImplementationOnce(() => {
      throw new Error('synthetic feed rejection')
    })
    const { startAutoUpdater } = await import('../auto-updater')
    startAutoUpdater()
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000)

    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('revalidates and reapplies the canonical feed before a manual check', async () => {
    process.env.AWP_UPDATE_URL = 'https://updates.example.test/releases/'
    const { stopAutoUpdater, triggerManualCheck } = await import('../auto-updater')
    await triggerManualCheck()

    expect(mocks.autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://updates.example.test/releases',
    })
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledOnce()
    stopAutoUpdater()
  })

  it('does not manually check an invalid feed', async () => {
    process.env.AWP_UPDATE_URL = 'https://updates.example.test/releases?token=value'
    const { triggerManualCheck } = await import('../auto-updater')
    await triggerManualCheck()

    expect(mocks.autoUpdater.setFeedURL).not.toHaveBeenCalled()
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })
})