/**
 * Regression coverage for SSE header construction.
 *
 * The transport must preserve common capability/version headers, enforce the
 * validated service origin, reject redirects, and attach the ephemeral demo
 * capability only to semantic loopback targets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSSEStream } from '../sse'

// Hold a reference to the captured headers so each test can assert on
// what the SSE client passed to fetch.
let capturedHeaders: Record<string, string> | null = null
let capturedUrl = ''
let capturedInit: RequestInit | undefined

beforeEach(() => {
  capturedHeaders = null
  capturedUrl = ''
  capturedInit = undefined
  // Mock global fetch with a no-op body that resolves quickly. SSE will
  // try to read the body via ReadableStream — we feed it an empty one
  // so the async stream loop exits after one tick.
  globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(_url)
    capturedInit = init
    capturedHeaders = (init?.headers as Record<string, string>) ?? null
    const body = new ReadableStream({
      start(controller) {
        controller.close()
      },
    })
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }) as unknown as Response
  }) as unknown as typeof fetch

  // Tell buildCommonHeaders we're in a renderer context with cap available.
  // This drives the `cc-on-desktop` token into X-AgentWorkflowPlatform-Capabilities.
  ;(globalThis as unknown as { window: unknown }).window = globalThis
  const w = globalThis as unknown as {
    __CC_LOCAL_RUNTIME_AVAILABLE?: boolean
    __APP_VERSION__?: string
  }
  w.__CC_LOCAL_RUNTIME_AVAILABLE = true
  w.__APP_VERSION__ = '0.1.0'
})

afterEach(() => {
  vi.restoreAllMocks()
  const w = globalThis as unknown as {
    __CC_LOCAL_RUNTIME_AVAILABLE?: boolean
  }
  delete w.__CC_LOCAL_RUNTIME_AVAILABLE
})

describe('createSSEStream — capability header wiring (2026-05-25 regression)', () => {
  it('builds only a same-origin relative endpoint and rejects redirects', async () => {
    createSSEStream('https://example.test', '/v1/chat/completions?stream=1', 'tok-test', () => {})
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(capturedUrl).toBe('https://example.test/v1/chat/completions?stream=1')
    expect(capturedInit?.redirect).toBe('error')
  })

  it('rejects unsafe bases and network-path references before fetch', () => {
    const fetchSpy = vi.mocked(globalThis.fetch)
    expect(() => createSSEStream('http://example.test', '/v1/events', '', () => {}))
      .toThrow('invalid_sse_base')
    expect(() => createSSEStream('https://example.test', '//evil.test/events', '', () => {}))
      .toThrow('invalid_sse_path')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  it('attaches the ephemeral demo capability to loopback SSE only', async () => {
    const w = globalThis as unknown as { __AWP_DEMO_TOKEN?: string; __AWP_DEMO_ORIGIN?: string }
    w.__AWP_DEMO_TOKEN = 'c'.repeat(43)
    w.__AWP_DEMO_ORIGIN = 'http://127.0.0.1:8787'

    createSSEStream('http://127.0.0.1:8787', '/v1/chat/completions', '', () => {})
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(capturedHeaders?.['X-AWP-Demo-Token']).toBe('c'.repeat(43))

    delete w.__AWP_DEMO_TOKEN
    delete w.__AWP_DEMO_ORIGIN
  })
  it('forwards X-AgentWorkflowPlatform-Capabilities into the fetch headers', async () => {
    createSSEStream('https://example.test', '/v1/chat/completions', 'tok-test', () => {})
    // Let the async fetch-mock complete.
    await new Promise((r) => setTimeout(r, 10))

    expect(capturedHeaders).not.toBeNull()
    // Must have advertised cc-on-desktop given the renderer-state setup.
    expect(capturedHeaders!['X-AgentWorkflowPlatform-Capabilities']).toBe('cc-on-desktop')
  })

  it('forwards X-AgentWorkflowPlatform-Client-Version into the fetch headers', async () => {
    createSSEStream('https://example.test', '/v1/chat/completions', 'tok-test', () => {})
    await new Promise((r) => setTimeout(r, 10))

    expect(capturedHeaders).not.toBeNull()
    expect(capturedHeaders!['X-AgentWorkflowPlatform-Client-Version']).toBe('0.1.0')
  })

  it('still sends Authorization + Accept (existing protocol invariants)', async () => {
    createSSEStream('https://example.test', '/v1/chat/completions', 'tok-abc', () => {})
    await new Promise((r) => setTimeout(r, 10))

    expect(capturedHeaders).not.toBeNull()
    expect(capturedHeaders!['Authorization']).toBe('Bearer tok-abc')
    expect(capturedHeaders!['Accept']).toBe('text/event-stream')
  })

  it('drops X-AgentWorkflowPlatform-Capabilities when runtime not available', async () => {
    const w = globalThis as unknown as { __CC_LOCAL_RUNTIME_AVAILABLE?: boolean }
    w.__CC_LOCAL_RUNTIME_AVAILABLE = false

    createSSEStream('https://example.test', '/v1/chat/completions', 'tok-test', () => {})
    await new Promise((r) => setTimeout(r, 10))

    expect(capturedHeaders).not.toBeNull()
    expect(capturedHeaders!['X-AgentWorkflowPlatform-Capabilities']).toBeUndefined()
  })
})
