import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({ loaded: true, serverUrl: 'http://127.0.0.1:8787', loadSettings: vi.fn() }),
}))
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ isLoggedIn: false, checkSession: vi.fn(async () => false) }),
}))
vi.mock('@/api/client', () => ({
  api: { getBaseUrl: () => 'http://127.0.0.1:8787', setBaseUrl: vi.fn() },
}))

describe('router hosted-account opt-in', () => {
  beforeEach(() => {
    vi.resetModules()
    delete window.__AWP_HOSTED_AUTH_ENABLED
  })

  afterEach(() => {
    delete window.__AWP_HOSTED_AUTH_ENABLED
  })

  it('does not register the Login route in default local mode', async () => {
    const { default: router } = await import('../index')
    expect(router.hasRoute('login')).toBe(false)
  })

  it('registers the retained Login route after explicit opt-in', async () => {
    window.__AWP_HOSTED_AUTH_ENABLED = true
    const { default: router } = await import('../index')
    expect(router.hasRoute('login')).toBe(true)
  })
})
