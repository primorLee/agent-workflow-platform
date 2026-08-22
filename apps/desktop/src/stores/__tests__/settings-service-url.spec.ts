import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/bridge', () => ({
  bridge: null,
  isDesktop: true,
  waitForBridge: vi.fn(async () => null),
  setCredential: vi.fn(async () => undefined),
  getCredential: vi.fn(async () => undefined),
  deleteCredential: vi.fn(async () => undefined),
}))

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  vi.resetModules()
})

describe('settings service URL boundary', () => {
  it('ignores an unsafe persisted origin and keeps the local default', async () => {
    localStorage.setItem('awp_settings', JSON.stringify({
      serverUrl: 'http://example.test',
    }))
    const { useSettingsStore } = await import('../settings')
    const settings = useSettingsStore()
    await settings.loadSettings()
    expect(settings.serverUrl).toBe('http://127.0.0.1:8787')
  })

  it('rejects unsafe input without replacing the last safe origin', async () => {
    const { useSettingsStore } = await import('../settings')
    const settings = useSettingsStore()
    expect(settings.setServerUrl('http://localhost.evil:8787')).toBe(false)
    expect(settings.serverUrl).toBe('http://127.0.0.1:8787')
  })

  it('canonicalizes valid loopback and HTTPS origins', async () => {
    const { useSettingsStore } = await import('../settings')
    const settings = useSettingsStore()
    expect(settings.setServerUrl('http://localhost:9000/')).toBe(true)
    expect(settings.serverUrl).toBe('http://localhost:9000')
    expect(settings.setServerUrl('https://Service.Example.test/')).toBe(true)
    expect(settings.serverUrl).toBe('https://service.example.test')
  })
})