import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockApiGet = vi.fn()
vi.mock('@/api/client', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
  },
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    get: () => value,
  })
}

async function loadStore() {
  // Re-import after setting navigator.onLine so module-init captures correct value
  vi.resetModules()
  const mod = await import('../connection')
  return mod.useConnectionStore()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useConnectionStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    setOnline(true)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ---------- 1. Initial state ----------

  it('initial state: disconnected and not checking (browser online)', async () => {
    const conn = await loadStore()
    expect(conn.connected).toBe(false)
    expect(conn.checking).toBe(false)
    expect(conn.online).toBe(true)
    expect(conn.error).toBeNull()
    expect(conn.consecutiveFailures).toBe(0)
    // statusText should be 'disconnected' since connected=false and online=true and checking=false
    expect(conn.statusText).toBe('disconnected')
  })

  // ---------- 2. Browser offline transitions ----------

  it('browser offline skips network call and sets browserOffline i18n error', async () => {
    setOnline(false)
    const conn = await loadStore()
    // online ref captured false on init
    expect(conn.online).toBe(false)

    const ok = await conn.testConnection()
    expect(ok).toBe(false)
    expect(conn.connected).toBe(false)
    // Error message comes from i18n key connection.browserOffline
    // zh-CN: '浏览器离线', en: 'Browser offline' — either one is acceptable
    expect(conn.error).toMatch(/浏览器离线|Browser offline/)
    // api.get must NOT be called when offline
    expect(mockApiGet).not.toHaveBeenCalled()
    // statusText should be 'offline'
    expect(conn.statusText).toBe('offline')
  })

  // ---------- 3. Successful ping → connected ----------

  it('successful ping transitions to connected and resets consecutiveFailures', async () => {
    mockApiGet.mockResolvedValueOnce({ status: 'ok', version: '1.4.2' })
    const conn = await loadStore()

    // Pre-seed failures to prove they get reset
    conn.consecutiveFailures = 5

    const ok = await conn.testConnection()
    expect(ok).toBe(true)
    expect(conn.connected).toBe(true)
    expect(conn.serverVersion).toBe('1.4.2')
    expect(conn.consecutiveFailures).toBe(0)
    expect(conn.lastCheckTime).not.toBeNull()
    expect(conn.lastConnectedAt).not.toBeNull()
    expect(conn.wasConnected).toBe(true)
    expect(conn.error).toBeNull()
    expect(conn.statusText).toBe('connected')
    expect(mockApiGet).toHaveBeenCalledWith(
      '/api/health',
      undefined,
      expect.objectContaining({ silent: true, timeout: 10_000 }),
    )
  })

  it('degraded status still counts as connected', async () => {
    mockApiGet.mockResolvedValueOnce({ status: 'degraded', version: '1.4.2' })
    const conn = await loadStore()
    const ok = await conn.testConnection()
    expect(ok).toBe(true)
    expect(conn.connected).toBe(true)
  })

  // ---------- 4. Failed ping → error + scheduled retry ----------

  it('failed ping transitions to error, increments consecutiveFailures, and poller schedules retry', async () => {
    vi.useFakeTimers()
    // All probes fail
    mockApiGet.mockRejectedValue(new Error('ECONNREFUSED'))
    const conn = await loadStore()

    // Start polling at a short interval; this triggers an initial testConnection()
    // plus a scheduleNext using that same interval.
    conn.startHealthPolling(30_000)

    // Flush the first inline testConnection()
    await vi.waitFor(() => {
      expect(mockApiGet).toHaveBeenCalledTimes(1)
    })
    expect(conn.connected).toBe(false)
    expect(conn.error).toBe('ECONNREFUSED')
    expect(conn.consecutiveFailures).toBe(1)
    expect(conn.serverVersion).toBe('')

    // Advance timers to fire the scheduled retry
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mockApiGet).toHaveBeenCalledTimes(2)
    expect(conn.consecutiveFailures).toBe(2)

    conn.stopHealthPolling()
  })

  // ---------- 5. Manual retry ----------

  it('manual retry (testConnection) clears error and re-probes the server', async () => {
    // First call: failure
    mockApiGet.mockRejectedValueOnce(new Error('boom'))
    const conn = await loadStore()
    await conn.testConnection()
    expect(conn.error).toBe('boom')
    expect(conn.consecutiveFailures).toBe(1)

    // Second call: success — simulates user clicking "retry"
    mockApiGet.mockResolvedValueOnce({ status: 'ok', version: '2.0' })
    const ok = await conn.testConnection()
    expect(ok).toBe(true)
    expect(conn.error).toBeNull()
    expect(conn.connected).toBe(true)
    expect(conn.consecutiveFailures).toBe(0)
  })

  // ---------- 6. Timer cleanup (no leaks) ----------

  it('stopHealthPolling clears the pending poll timer (no leak)', async () => {
    vi.useFakeTimers()
    mockApiGet.mockResolvedValue({ status: 'ok', version: '1.0' })
    const conn = await loadStore()

    conn.startHealthPolling(30_000)
    // Let the initial inline testConnection() settle
    await vi.waitFor(() => expect(mockApiGet).toHaveBeenCalledTimes(1))

    // Stop polling — pending timeout must be cleared
    conn.stopHealthPolling()

    // Advancing far past the scheduled next-fire must NOT trigger another probe
    const beforeCount = mockApiGet.mock.calls.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(mockApiGet.mock.calls.length).toBe(beforeCount)
  })

  it('restarting polling cancels the previous timer (no double-schedule)', async () => {
    vi.useFakeTimers()
    mockApiGet.mockResolvedValue({ status: 'ok', version: '1.0' })
    const conn = await loadStore()

    conn.startHealthPolling(30_000)
    await vi.waitFor(() => expect(mockApiGet).toHaveBeenCalledTimes(1))

    // Restart — previous timer should be cleared, only one live timer remains
    conn.startHealthPolling(30_000)
    await vi.waitFor(() => expect(mockApiGet).toHaveBeenCalledTimes(2))

    const before = mockApiGet.mock.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    // Exactly one additional probe — not two
    expect(mockApiGet.mock.calls.length).toBe(before + 1)

    conn.stopHealthPolling()
  })

  // ---------- 7. statusText i18n-ready keys per state ----------

  it('statusText returns stable key for each state (offline/checking/connected/disconnected)', async () => {
    const conn = await loadStore()

    // Default: online=true, checking=false, connected=false → 'disconnected'
    expect(conn.statusText).toBe('disconnected')

    // checking=true → 'checking'
    conn.checking = true
    expect(conn.statusText).toBe('checking')

    // checking=false, connected=true → 'connected'
    conn.checking = false
    conn.connected = true
    expect(conn.statusText).toBe('connected')

    // online=false → 'offline' (overrides everything)
    conn.online = false
    expect(conn.statusText).toBe('offline')
  })

  // ---------- 8. onReconnect callback fires after recovery ----------

  it('onReconnect callback fires when reconnecting after a prior connected session', async () => {
    const conn = await loadStore()

    // Prime: was connected once
    mockApiGet.mockResolvedValueOnce({ status: 'ok', version: '1.0' })
    await conn.testConnection()
    expect(conn.wasConnected).toBe(true)

    // Then disconnect
    mockApiGet.mockRejectedValueOnce(new Error('net'))
    await conn.testConnection()
    expect(conn.connected).toBe(false)

    // Register callback, then reconnect
    const cb = vi.fn()
    const unsubscribe = conn.onReconnect(cb)
    mockApiGet.mockResolvedValueOnce({ status: 'ok', version: '1.0' })
    await conn.testConnection()
    expect(cb).toHaveBeenCalledTimes(1)

    // Unsubscribe — next reconnect should NOT fire
    unsubscribe()
    mockApiGet.mockRejectedValueOnce(new Error('net'))
    await conn.testConnection()
    mockApiGet.mockResolvedValueOnce({ status: 'ok', version: '1.0' })
    await conn.testConnection()
    expect(cb).toHaveBeenCalledTimes(1)
  })
})
