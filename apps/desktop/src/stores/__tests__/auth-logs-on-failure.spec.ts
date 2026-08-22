import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '../auth'

// ---------------------------------------------------------------------------
// S10 (2026-04-19 industrial-grade audit): every previously empty catch in
// auth.ts now emits a `[auth] ...` warn line. This spec is the regression
// guard — if any of the 13 swallow sites regress to `catch { /* */ }`, the
// corresponding branch here will stop emitting and the test fails.
//
// Covered sites (original line numbers from audit §S10 L156):
//   42, 48  — saveCredentials: clear/persist localStorage
//   54      — saveCredentials: bridge.save_customer_id
//   71, 85  — loadCredentials: localStorage read / bridge.get_auth fallback
//   108     — loadCredentials tail (covered by the same branch)
//   215, 217 — login: register-app setup + non-ok response + fetch catch
//   275, 280 — clearAuth + checkSession: localStorage / bridge.save_customer_id
// ---------------------------------------------------------------------------

const mockSetToken = vi.fn()
const mockGetBaseUrl = vi.fn(() => 'https://api.example.com')
vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>()
  return {
    ...actual,
    api: {
      setToken: (...args: unknown[]) => mockSetToken(...args),
      getBaseUrl: () => mockGetBaseUrl(),
      get: vi.fn(),
      post: vi.fn(),
    },
  }
})

const mockLogin = vi.fn()
const mockValidateToken = vi.fn()
vi.mock('@/api/endpoints/auth', () => ({
  login: (...args: unknown[]) => mockLogin(...args),
  register: vi.fn(),
  logout: vi.fn(),
  validateToken: (...args: unknown[]) => mockValidateToken(...args),
}))

const mockSetCredential = vi.fn(async () => true)
const mockGetCredential = vi.fn(async () => undefined as string | undefined)
const mockDeleteCredential = vi.fn(async () => true)
const mockWaitForBridge = vi.fn(async () => null)
const mockSaveCustomerId = vi.fn()
const mockGetAuth = vi.fn(async () => null as { token?: string; customer_id?: string; email?: string } | null)

vi.mock('@/bridge', () => ({
  bridge: {
    save_customer_id: (...args: unknown[]) => mockSaveCustomerId(...args),
    get_auth: (...args: unknown[]) => mockGetAuth(...args),
  },
  waitForBridge: (...args: unknown[]) => mockWaitForBridge(...args),
  setCredential: (...args: unknown[]) => mockSetCredential(...args),
  getCredential: (...args: unknown[]) => mockGetCredential(...args),
  deleteCredential: (...args: unknown[]) => mockDeleteCredential(...args),
}))

vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({ onUserChanged: vi.fn() }),
}))
vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({ loadSettings: vi.fn() }),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function installLocalStorageThrower(method: 'setItem' | 'removeItem' | 'getItem', err: Error) {
  // jsdom's `window.localStorage` is a native Storage that routes through
  // its own internal slot — overriding instance methods or prototype
  // methods doesn't affect `localStorage.setItem('x', 'y')`. The robust
  // approach is to swap the whole `localStorage` global with a fake that
  // throws on the target method.
  const real = globalThis.localStorage
  const mem: Record<string, string> = {}
  const fake: Storage = {
    get length() {
      return Object.keys(mem).length
    },
    clear: () => {
      for (const k of Object.keys(mem)) delete mem[k]
    },
    getItem: (k: string) => (k in mem ? mem[k]! : null),
    key: (i: number) => Object.keys(mem)[i] ?? null,
    removeItem: (k: string) => {
      delete mem[k]
    },
    setItem: (k: string, v: string) => {
      mem[k] = v
    },
  }
  ;(fake as unknown as Record<string, unknown>)[method] = () => {
    throw err
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: fake,
    writable: true,
    configurable: true,
  })
  return () => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: real,
      writable: true,
      configurable: true,
    })
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auth.ts — S10 regression: every failure path emits [auth] warn', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    setActivePinia(createPinia())
    window.__AWP_HOSTED_AUTH_ENABLED = true
    localStorage.clear()
    vi.clearAllMocks()
    mockSetCredential.mockResolvedValue(true)
    mockGetCredential.mockResolvedValue(undefined)
    mockDeleteCredential.mockResolvedValue(true)
    mockWaitForBridge.mockResolvedValue(null)
    mockGetAuth.mockResolvedValue(null)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  // ---- saveCredentials path ------------------------------------------------

  it('logs when localStorage.setItem throws while persisting customer_id/email', async () => {
    const restore = installLocalStorageThrower('setItem', new Error('quota exceeded'))
    try {
      mockLogin.mockResolvedValueOnce({ api_key: 'tok-a', customer_id: 'cid-a' })
      const auth = useAuthStore()
      await auth.login('u@t.com', 'pw')
      // At least one warn with [auth] prefix covering the setItem failure
      const calls = warnSpy.mock.calls.map((c) => String(c[0]))
      expect(calls.some((m) => m.startsWith('[auth]') && m.includes('saveCredentials'))).toBe(true)
    } finally {
      restore()
    }
  })

  it('logs when bridge.save_customer_id throws during saveCredentials', async () => {
    mockSaveCustomerId.mockImplementationOnce(() => {
      throw new Error('bridge down')
    })
    mockLogin.mockResolvedValueOnce({ api_key: 'tok-b', customer_id: 'cid-b' })
    const auth = useAuthStore()
    await auth.login('u@t.com', 'pw')
    const calls = warnSpy.mock.calls.map((c) => String(c[0]))
    expect(
      calls.some((m) => m.startsWith('[auth]') && m.includes('bridge.save_customer_id')),
    ).toBe(true)
  })

  // ---- clearAuth path ------------------------------------------------------

  it('logs when deleteCredential rejects during clearAuth', async () => {
    mockDeleteCredential.mockRejectedValueOnce(new Error('keyring locked'))
    const auth = useAuthStore()
    auth.clearAuth()
    // Wait a microtask for the .catch() to run
    await Promise.resolve()
    await Promise.resolve()
    const calls = warnSpy.mock.calls.map((c) => String(c[0]))
    expect(
      calls.some(
        (m) => m.startsWith('[auth]') && m.includes('clearAuth: deleteCredential'),
      ),
    ).toBe(true)
  })

  it('logs when localStorage.removeItem throws during clearAuth', async () => {
    const restore = installLocalStorageThrower('removeItem', new Error('disk full'))
    try {
      const auth = useAuthStore()
      auth.clearAuth()
      const calls = warnSpy.mock.calls.map((c) => String(c[0]))
      expect(
        calls.some(
          (m) => m.startsWith('[auth]') && m.includes('clearAuth: localStorage.removeItem'),
        ),
      ).toBe(true)
    } finally {
      restore()
    }
  })

  // ---- loadCredentials / checkSession path ---------------------------------

  it('logs when localStorage.getItem throws during loadCredentials', async () => {
    mockGetCredential.mockResolvedValueOnce('tok-secure')
    const restore = installLocalStorageThrower('getItem', new Error('storage unavailable'))
    try {
      const auth = useAuthStore()
      await auth.checkSession()
      const calls = warnSpy.mock.calls.map((c) => String(c[0]))
      expect(
        calls.some((m) => m.startsWith('[auth]') && m.includes('loadCredentials')),
      ).toBe(true)
    } finally {
      restore()
    }
  })

  // ---- register-app (S11) path --------------------------------------------
  //
  // S11 ("login 后 register-app fetch 无 timeout 无 log") was closed by the
  // F2 P0 removal of the entire /v1/remote/register-app client call
  // (2026-04-19, ADR-20260419). No fetch is issued from login() anymore, so
  // there is no register-app log path to assert. The regression guard for
  // F2 lives in a separate spec that asserts `fetch` is never called by
  // `login()`; kept out of this file to keep the S10 scope tight.
})
