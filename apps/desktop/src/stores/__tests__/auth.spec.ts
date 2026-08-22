import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '../auth'
import { ApiError } from '@/api/client'

// ---------------------------------------------------------------------------
// Mocks
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
const mockRegister = vi.fn()
const mockLogout = vi.fn()
const mockValidateToken = vi.fn()
vi.mock('@/api/endpoints/auth', () => ({
  login: (...args: unknown[]) => mockLogin(...args),
  register: (...args: unknown[]) => mockRegister(...args),
  logout: (...args: unknown[]) => mockLogout(...args),
  validateToken: (...args: unknown[]) => mockValidateToken(...args),
}))

const mockSetCredential = vi.fn(async () => false)
const mockGetCredential = vi.fn(async () => undefined as string | undefined)
const mockDeleteCredential = vi.fn(async () => true)
const mockWaitForBridge = vi.fn(async () => null)
vi.mock('@/bridge', () => ({
  bridge: null,
  waitForBridge: (...args: unknown[]) => mockWaitForBridge(...args),
  setCredential: (...args: unknown[]) => mockSetCredential(...args),
  getCredential: (...args: unknown[]) => mockGetCredential(...args),
  deleteCredential: (...args: unknown[]) => mockDeleteCredential(...args),
}))

// Mock chat + settings stores that auth.ts calls on login/logout
const mockChatOnUserChanged = vi.fn()
vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({
    onUserChanged: mockChatOnUserChanged,
  }),
}))

const mockLoadSettings = vi.fn()
vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({
    loadSettings: mockLoadSettings,
  }),
}))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useAuthStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // Existing hosted-adapter behavior is exercised only after explicit opt-in.
    window.__AWP_HOSTED_AUTH_ENABLED = true
    localStorage.clear()
    // Reset all mocks
    vi.clearAllMocks()
    // Default mock behaviors
    mockSetCredential.mockResolvedValue(false)
    mockGetCredential.mockResolvedValue(undefined)
    mockDeleteCredential.mockResolvedValue(true)
    mockLogout.mockResolvedValue(undefined)
    mockWaitForBridge.mockResolvedValue(null)
  })

  // ---------- 1. Initial state ----------

  it('default local mode rejects account operations without calling the adapter', async () => {
    window.__AWP_HOSTED_AUTH_ENABLED = false
    const auth = useAuthStore()

    await expect(auth.login('local@example.invalid', 'unused')).resolves.toBe(false)
    await expect(auth.register('local@example.invalid', 'unused')).resolves.toBe(false)
    await expect(auth.checkSession()).resolves.toBe(false)
    await auth.logout()

    expect(auth.error).toBe('hosted_auth_disabled')
    expect(mockLogin).not.toHaveBeenCalled()
    expect(mockRegister).not.toHaveBeenCalled()
    expect(mockValidateToken).not.toHaveBeenCalled()
    expect(mockLogout).not.toHaveBeenCalled()
  })

  it('initial state: isLoggedIn=false, token empty, user null', () => {
    const auth = useAuthStore()
    expect(auth.isLoggedIn).toBe(false)
    expect(auth.token).toBe('')
    expect(auth.user).toBeNull()
    expect(auth.error).toBeNull()
    expect(auth.loading).toBe(false)
  })

  // ---------- 2. Login success ----------

  it('login success sets token, user, isLoggedIn', async () => {
    mockLogin.mockResolvedValueOnce({
      api_key: 'tok-abc',
      customer_id: 'cust-123',
    })
    const auth = useAuthStore()
    const result = await auth.login('user@test.com', 'pass123')
    expect(result).toBe(true)
    expect(auth.token).toBe('tok-abc')
    expect(auth.user).toEqual({ email: 'user@test.com', customer_id: 'cust-123' })
    expect(auth.isLoggedIn).toBe(true)
    expect(auth.error).toBeNull()
    expect(auth.loading).toBe(false)
    expect(mockSetToken).toHaveBeenCalledWith('tok-abc')
  })

  // ---------- 3. Login failure ----------

  it('login failure with ApiError sets error field', async () => {
    mockLogin.mockRejectedValueOnce(new ApiError(401, { detail: 'Invalid credentials' }))
    const auth = useAuthStore()
    const result = await auth.login('bad@test.com', 'wrong')
    expect(result).toBe(false)
    expect(auth.error).toBe('Invalid credentials')
    expect(auth.isLoggedIn).toBe(false)
    expect(auth.loading).toBe(false)
  })

  it('login failure with generic error sets error message', async () => {
    mockLogin.mockRejectedValueOnce(new Error('Network timeout'))
    const auth = useAuthStore()
    const result = await auth.login('user@test.com', 'pass')
    expect(result).toBe(false)
    expect(auth.error).toBe('Network timeout')
  })

  // ---------- 4. Register success ----------

  it('register success sets token, user, isLoggedIn', async () => {
    mockRegister.mockResolvedValueOnce({
      api_key: 'tok-new',
      customer_id: 'cust-new',
    })
    const auth = useAuthStore()
    const result = await auth.register('new@test.com', 'pass123', 'newuser')
    expect(result).toBe(true)
    expect(auth.token).toBe('tok-new')
    expect(auth.user).toEqual({ email: 'new@test.com', customer_id: 'cust-new' })
    expect(auth.isLoggedIn).toBe(true)
    expect(mockSetToken).toHaveBeenCalledWith('tok-new')
  })

  // ---------- 5. Register failure ----------

  it('register failure sets error', async () => {
    mockRegister.mockRejectedValueOnce(new ApiError(409, { detail: 'Email exists' }))
    const auth = useAuthStore()
    const result = await auth.register('dup@test.com', 'pass')
    expect(result).toBe(false)
    expect(auth.error).toBe('Email exists')
  })

  // ---------- 6. Logout ----------

  it('logout calls authApi.logout + clearAuth', async () => {
    // First login
    mockLogin.mockResolvedValueOnce({ api_key: 'tok', customer_id: 'cid' })
    const auth = useAuthStore()
    await auth.login('u@t.com', 'p')
    expect(auth.isLoggedIn).toBe(true)

    // Then logout
    await auth.logout()
    expect(mockLogout).toHaveBeenCalled()
    expect(auth.token).toBe('')
    expect(auth.user).toBeNull()
    expect(auth.isLoggedIn).toBe(false)
  })

  // ---------- 7. clearAuth cleans everything ----------

  it('clearAuth clears token, user, localStorage, and calls deleteCredential', async () => {
    // Set up state
    mockLogin.mockResolvedValueOnce({ api_key: 'tok-clear', customer_id: 'cid-clear' })
    const auth = useAuthStore()
    await auth.login('u@t.com', 'p')
    localStorage.setItem('awp_token', 'tok-clear')
    localStorage.setItem('awp_customer_id', 'cid-clear')
    localStorage.setItem('awp_email', 'u@t.com')

    auth.clearAuth()
    expect(auth.token).toBe('')
    expect(auth.user).toBeNull()
    expect(mockSetToken).toHaveBeenLastCalledWith('')
    expect(mockDeleteCredential).toHaveBeenCalledWith('token')
    expect(localStorage.getItem('awp_token')).toBeNull()
    expect(localStorage.getItem('awp_customer_id')).toBeNull()
    expect(localStorage.getItem('awp_email')).toBeNull()
  })

  // ---------- 8. saveCredentials: safeStorage path ----------

  it('saveCredentials stores token via safeStorage when available', async () => {
    mockSetCredential.mockResolvedValueOnce(true)
    mockLogin.mockResolvedValueOnce({ api_key: 'tok-safe', customer_id: 'cid-safe' })
    const auth = useAuthStore()
    await auth.login('u@t.com', 'p')
    expect(mockSetCredential).toHaveBeenCalledWith('auth_token', 'tok-safe')
    // When safeStorage succeeds, localStorage token should be absent
    expect(localStorage.getItem('awp_token')).toBeNull()
    // Non-sensitive data remains in localStorage
    expect(localStorage.getItem('awp_customer_id')).toBe('cid-safe')
    expect(localStorage.getItem('awp_email')).toBe('u@t.com')
  })

  // ---------- 9. saveCredentials: no plaintext fallback (security hardening) ----------

  it('saveCredentials does NOT fall back to localStorage when safeStorage unavailable', async () => {
    // Security model: token has a single persistence sink (safeStorage).
    // If unavailable, token lives only in memory — never written plaintext.
    mockSetCredential.mockResolvedValueOnce(false)
    mockLogin.mockResolvedValueOnce({ api_key: 'tok-fallback', customer_id: 'cid-fb' })
    const auth = useAuthStore()
    await auth.login('u@t.com', 'p')
    // Token must NOT leak into localStorage
    expect(localStorage.getItem('awp_token')).toBeNull()
    // But in-memory ref still has it for this session
    expect(auth.token).toBe('tok-fallback')
  })

  // ---------- 10. loadCredentials priority ----------

  it('loadCredentials reads from safeStorage first', async () => {
    mockGetCredential.mockResolvedValueOnce('tok-secure')
    localStorage.setItem('awp_customer_id', 'cid-load')
    localStorage.setItem('awp_email', 'e@t.com')
    mockValidateToken.mockResolvedValueOnce({ valid: true, customer_id: 'cid-load', email: 'e@t.com' })

    const auth = useAuthStore()
    const ok = await auth.checkSession()
    expect(ok).toBe(true)
    expect(auth.token).toBe('tok-secure')
    expect(auth.user?.customer_id).toBe('cid-load')
  })

  it('loadCredentials does NOT accept localStorage token without safeStorage (no plaintext sink)', async () => {
    // Security model: no safeStorage → no token loaded (user must re-login).
    // localStorage token is NEVER a valid source post-login.
    mockGetCredential.mockResolvedValue(undefined)
    localStorage.setItem('awp_token', 'tok-ls-leak')
    localStorage.setItem('awp_customer_id', 'cid-ls')
    localStorage.setItem('awp_email', 'ls@t.com')

    const auth = useAuthStore()
    const ok = await auth.checkSession()
    expect(ok).toBe(false)
    expect(auth.token).toBe('')
  })

  // ---------- 12. checkSession with existing token ----------

  it('checkSession returns true immediately when token already in ref', async () => {
    mockLogin.mockResolvedValueOnce({ api_key: 'tok-existing', customer_id: 'cid-ex' })
    const auth = useAuthStore()
    await auth.login('u@t.com', 'p')
    // Token is already loaded, should return true without validation
    const ok = await auth.checkSession()
    expect(ok).toBe(true)
    // validateToken should NOT be called since token is already present
    expect(mockValidateToken).not.toHaveBeenCalled()
  })

  // ---------- 13. checkSession server 401 clears credentials ----------

  it('checkSession clears credentials on server 401', async () => {
    mockGetCredential.mockResolvedValueOnce('tok-expired')
    localStorage.setItem('awp_customer_id', 'cid-exp')
    localStorage.setItem('awp_email', 'exp@t.com')
    mockValidateToken.mockRejectedValueOnce(new ApiError(401, { error: 'token expired' }))

    const auth = useAuthStore()
    const ok = await auth.checkSession()
    expect(ok).toBe(false)
    expect(auth.token).toBe('')
    expect(auth.user).toBeNull()
  })

  // ---------- 14. checkSession network error trusts cache ----------

  it('checkSession trusts cached token on network error', async () => {
    mockGetCredential.mockResolvedValueOnce('tok-cached')
    localStorage.setItem('awp_customer_id', 'cid-cache')
    localStorage.setItem('awp_email', 'cache@t.com')
    // validateToken returns null (network error)
    mockValidateToken.mockResolvedValueOnce(null)

    const auth = useAuthStore()
    const ok = await auth.checkSession()
    expect(ok).toBe(true)
    expect(auth.token).toBe('tok-cached')
    expect(auth.user?.email).toBe('cache@t.com')
  })

  // ---------- 15. handleUnauthorized calls clearAuth ----------

  it('handleUnauthorized clears auth state', async () => {
    mockLogin.mockResolvedValueOnce({ api_key: 'tok-x', customer_id: 'cid-x' })
    const auth = useAuthStore()
    await auth.login('u@t.com', 'p')
    expect(auth.isLoggedIn).toBe(true)

    auth.handleUnauthorized()
    expect(auth.isLoggedIn).toBe(false)
    expect(auth.token).toBe('')
    expect(auth.user).toBeNull()
  })
})
