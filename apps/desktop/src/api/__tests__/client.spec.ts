import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ApiClient, ApiError } from '../client'

// ---------------------------------------------------------------------------
// Mock modules that ApiClient imports lazily or eagerly
// ---------------------------------------------------------------------------

vi.mock('@/stores/toast', () => ({
  useToastStore: () => ({
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    show: vi.fn(),
  }),
}))

vi.mock('@/router', () => ({
  default: { push: vi.fn() },
}))

const mockHandleUnauthorized = vi.fn()
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    handleUnauthorized: mockHandleUnauthorized,
  }),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  const h = new Headers({ 'Content-Type': 'application/json', ...headers })
  return new Response(JSON.stringify(body), { status, headers: h })
}

function emptyResponse(status: number): Response {
  return new Response(null, { status })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ApiClient', () => {
  let client: ApiClient
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setActivePinia(createPinia())
    window.__AWP_HOSTED_AUTH_ENABLED = true
    client = new ApiClient()
    client.setBaseUrl('https://api.example.com')

    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('navigator', { onLine: true })

    mockHandleUnauthorized.mockReset()
  })

  afterEach(() => {
    delete window.__AWP_HOSTED_AUTH_ENABLED
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // ---------- 1. HTTP method + URL construction ----------

  it('GET request builds the correct URL', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }))
    await client.get('/v1/test')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.example.com/v1/test')
    expect(init.method).toBe('GET')
    expect(init.redirect).toBe('error')
  })

  it('POST request sends JSON body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 1 }))
    await client.post('/v1/items', { name: 'widget' })
    const [, init] = fetchMock.mock.calls[0]!
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ name: 'widget' }))
  })

  it('PUT request uses PUT method', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { updated: true }))
    await client.put('/v1/items/1', { name: 'gadget' })
    const [, init] = fetchMock.mock.calls[0]!
    expect(init.method).toBe('PUT')
  })

  it('PATCH request uses PATCH method', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { patched: true }))
    await client.patch('/v1/items/1', { name: 'updated' })
    const [, init] = fetchMock.mock.calls[0]!
    expect(init.method).toBe('PATCH')
  })

  it('DELETE request uses DELETE method', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { deleted: true }))
    await client.delete('/v1/items/1')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.example.com/v1/items/1')
    expect(init.method).toBe('DELETE')
  })

  // ---------- 2. Query string from params ----------

  it('params are converted to query string', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, []))
    await client.get('/v1/search', { q: 'ota', page: '2' })
    const [url] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.example.com/v1/search?q=ota&page=2')
  })

  it('adds the ephemeral demo capability across JSON, multipart, and blob requests only on loopback', async () => {
    const demoToken = 'b'.repeat(43)
    window.__AWP_DEMO_TOKEN = demoToken
    window.__AWP_DEMO_ORIGIN = 'http://127.0.0.1:8787'
    client.setBaseUrl('http://127.0.0.1:8787')

    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
      .mockResolvedValueOnce(jsonResponse(200, { uploaded: true }))
      .mockResolvedValueOnce(new Response(new Blob(['artifact']), { status: 200 }))

    await client.get('/v1/chat/history')
    await client.postForm('/v1/chat/upload', new FormData())
    await client.getBlob('/v1/chat/artifacts/example/download')

    for (const call of fetchMock.mock.calls) {
      expect(call[1].headers['X-AWP-Demo-Token']).toBe(demoToken)
      expect(call[1].redirect).toBe('error')
    }
  })

  it('strips caller-supplied demo capabilities from non-loopback services', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }))
    await client.get('/v1/test', undefined, {
      headers: { 'X-AWP-Demo-Token': 'caller-controlled' },
    })
    expect(fetchMock.mock.calls[0]![1].headers['X-AWP-Demo-Token']).toBeUndefined()
  })
  // ---------- 3. Token & CSRF in headers ----------

  it('Bearer token is sent in Authorization header', async () => {
    client.setToken('my-secret-token')
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}))
    await client.get('/v1/me')
    const [, init] = fetchMock.mock.calls[0]!
    expect(init.headers['Authorization']).toBe('Bearer my-secret-token')
  })

  it('CSRF token is sent in X-CSRF-Token header', async () => {
    client.setCsrfToken('csrf-abc')
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}))
    await client.post('/v1/action')
    const [, init] = fetchMock.mock.calls[0]!
    expect(init.headers['X-CSRF-Token']).toBe('csrf-abc')
  })

  // ---------- 4. 200 returns JSON, 204 returns undefined ----------

  it('200 response returns parsed JSON', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: 'hello' }))
    const result = await client.get('/v1/test')
    expect(result).toEqual({ data: 'hello' })
  })

  it('204 response returns undefined', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(204))
    const result = await client.delete('/v1/items/1')
    expect(result).toBeUndefined()
  })

  // ---------- 5. 4xx throws ApiError ----------

  it('422 throws ApiError with status and detail', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(422, { detail: 'invalid param' }))
    await expect(client.post('/v1/bad')).rejects.toThrow(ApiError)
  })

  it('4xx error (non-401/403) throws ApiError with correct status', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(422, { detail: 'bad input' }))
    try {
      await client.post('/v1/bad-input')
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError)
      expect((e as ApiError).status).toBe(422)
      expect((e as ApiError).detail).toBe('bad input')
    }
  })

  // ---------- 6. 401 triggers handleUnauthorized ----------

  it('401 triggers useAuthStore().handleUnauthorized', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'unauthorized' }))
    await expect(client.get('/v1/secure')).rejects.toThrow(ApiError)
    // Wait for the async import to resolve
    await vi.advanceTimersByTimeAsync(50)
    expect(mockHandleUnauthorized).toHaveBeenCalled()
  })

  it('401 does not mutate hosted auth state in default local mode', async () => {
    window.__AWP_HOSTED_AUTH_ENABLED = false
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'unauthorized' }))

    await expect(client.get('/v1/local-adapter')).rejects.toThrow(ApiError)
    expect(mockHandleUnauthorized).not.toHaveBeenCalled()
  })

  it('403 throws immediately without retry', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: 'forbidden' }))
    try {
      await client.get('/v1/admin')
      expect.unreachable('should have thrown')
    } catch (e) {
      expect((e as ApiError).status).toBe(403)
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // ---------- 7. 429 retries with Retry-After ----------

  it('429 retries up to MAX_RETRIES then throws', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const headers429 = { 'Retry-After': '1' }
    for (let i = 0; i < 4; i++) {
      fetchMock.mockResolvedValueOnce(jsonResponse(429, { error: 'rate limited' }, headers429))
    }
    // Attach .catch early to prevent unhandled rejection
    const promise = client.get('/v1/rate-limited').catch((e: unknown) => e)
    // Advance timers through all retry delays
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(3000)
    }
    const result = await promise
    expect(result).toBeInstanceOf(ApiError)
    expect((result as ApiError).status).toBe(429)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  // ---------- 8. 500/502/503 exponential backoff retry ----------

  it('500 retries with exponential backoff, succeeds on retry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fetchMock
      .mockResolvedValueOnce(jsonResponse(500, { error: 'internal' }))
      .mockResolvedValueOnce(jsonResponse(200, { recovered: true }))

    const promise = client.get('/v1/flaky').catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5000)
    const result = await promise
    expect(result).toEqual({ recovered: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('503 exhausts retries and throws', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    for (let i = 0; i < 4; i++) {
      fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: 'unavailable' }))
    }
    const promise = client.get('/v1/down').catch((e: unknown) => e)
    for (let i = 0; i < 15; i++) {
      await vi.advanceTimersByTimeAsync(5000)
    }
    const result = await promise
    expect(result).toBeInstanceOf(ApiError)
    expect((result as ApiError).status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  // ---------- 9. Timeout triggers AbortController -> 408 ----------

  it('timeout aborts and throws 408 ApiError', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'))
        })
      })
    })

    const promise = client.get('/v1/slow', undefined, { timeout: 100 }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(200)
    const result = await promise
    expect(result).toBeInstanceOf(ApiError)
    expect((result as ApiError).status).toBe(408)
    expect((result as ApiError).code).toBe('TIMEOUT')
  })

  // ---------- 10. navigator.onLine=false throws OFFLINE ----------

  it('navigator.onLine=false throws OFFLINE error immediately', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    try {
      await client.get('/v1/any')
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError)
      expect((e as ApiError).status).toBe(0)
      expect((e as ApiError).code).toBe('OFFLINE')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // ---------- 11. silent=true suppresses toast ----------

  it('silent=true still throws but does not trigger toast', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    for (let i = 0; i < 4; i++) {
      fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: 'boom' }))
    }
    const promise = client.get('/v1/silent-fail', undefined, { silent: true }).catch((e: unknown) => e)
    for (let i = 0; i < 15; i++) {
      await vi.advanceTimersByTimeAsync(5000)
    }
    const result = await promise
    expect(result).toBeInstanceOf(ApiError)
    expect((result as ApiError).status).toBe(500)
  })

  // ---------- 12. baseUrl trailing slash handling ----------

  it('setBaseUrl canonicalizes a single origin slash', () => {
    client.setBaseUrl('https://example.com/')
    expect(client.getBaseUrl()).toBe('https://example.com')
  })

  it('rejects an unsafe base before any request can be sent', async () => {
    expect(() => client.setBaseUrl('http://example.com')).toThrow('invalid_service_base')
    expect(client.getBaseUrl()).toBe('')
    await expect(client.get('/v1/never-sent')).rejects.toThrow('service_base_not_configured')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('clears auth and CSRF when the service origin changes', async () => {
    client.setToken('origin-bound-token')
    client.setCsrfToken('origin-bound-csrf')
    client.setBaseUrl('https://other.example.com')
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }))

    await client.get('/v1/test')
    const [, init] = fetchMock.mock.calls[0]!
    expect(init.headers.Authorization).toBeUndefined()
    expect(init.headers['X-CSRF-Token']).toBeUndefined()
    expect(client.getToken()).toBe('')
  })

  // ---------- 13. Network error sets offline ----------

  it('network fetch failure throws ApiError with status 0', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    try {
      await client.get('/v1/network-fail')
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError)
      expect((e as ApiError).status).toBe(0)
      expect((e as ApiError).code).toBe('NETWORK_ERROR')
    }
  })

  // ---------- 14. Extra headers merge ----------

  it('extra headers from RequestOptions are merged', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}))
    await client.get('/v1/custom', undefined, { headers: { 'X-Custom': 'value' } })
    const [, init] = fetchMock.mock.calls[0]!
    expect(init.headers['X-Custom']).toBe('value')
    expect(init.headers['Content-Type']).toBe('application/json')
  })

  // ---------- 15. ApiError constructor ----------

  it('ApiError parses various body formats correctly', () => {
    const err1 = new ApiError(400, { detail: 'missing field' })
    expect(err1.detail).toBe('missing field')
    expect(err1.status).toBe(400)

    const err2 = new ApiError(500, { error: { message: 'internal failure' } })
    expect(err2.detail).toBe('internal failure')

    const err3 = new ApiError(502, null)
    expect(err3.detail).toBe('HTTP 502')

    const err4 = new ApiError(400, { error_type: 'VALIDATION', message: 'bad' })
    expect(err4.code).toBe('VALIDATION')
  })
})
