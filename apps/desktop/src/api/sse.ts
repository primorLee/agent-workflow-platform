/**
 * Fetch-based SSE client with a strict service-origin boundary.
 * Callers supply a validated service base plus an application-owned relative
 * path; redirects, unbounded handshakes, and unbounded idle streams are denied.
 */
import { buildCommonHeaders } from './buildCommonHeaders'
import { normalizeServiceBaseUrl } from '@/utils/service-base-url'
import { withDemoAuthHeaders } from './demo-auth'

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000
const DEFAULT_IDLE_TIMEOUT_MS = 45_000
const MAX_SSE_BUFFER_CHARS = 1_048_576

interface SSEOptions {
  method?: string
  body?: unknown
  handshakeTimeoutMs?: number
  idleTimeoutMs?: number
}

function buildSseUrl(baseUrl: string, relativePath: string): string {
  const base = normalizeServiceBaseUrl(baseUrl)
  if (!base) throw new Error('invalid_sse_base')
  if (
    typeof relativePath !== 'string'
    || !relativePath.startsWith('/')
    || relativePath.startsWith('//')
    || /[\\\u0000-\u001f\u007f]/u.test(relativePath)
  ) {
    throw new Error('invalid_sse_path')
  }

  const endpoint = new URL(relativePath, base)
  if (endpoint.origin !== base || endpoint.hash) throw new Error('invalid_sse_path')
  return endpoint.toString()
}

export function createSSEStream(
  baseUrl: string,
  relativePath: string,
  token: string,
  onMessage: (data: unknown) => void,
  onError?: (err: Error) => void,
  onHeaders?: (headers: Headers) => void,
  options?: SSEOptions,
): { close: () => void } {
  const url = buildSseUrl(baseUrl, relativePath)
  const controller = new AbortController()
  const method = options?.method ?? 'GET'
  const handshakeTimeoutMs = options?.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
  const idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  let closed = false
  let timeoutCode: 'sse_handshake_timeout' | 'sse_idle_timeout' | null = null
  let handshakeTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timeoutCode = 'sse_handshake_timeout'
    controller.abort()
  }, handshakeTimeoutMs)
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  const clearTimers = () => {
    if (handshakeTimer) clearTimeout(handshakeTimer)
    if (idleTimer) clearTimeout(idleTimer)
    handshakeTimer = null
    idleTimer = null
  }
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      timeoutCode = 'sse_idle_timeout'
      controller.abort()
    }, idleTimeoutMs)
  }

  ;(async () => {
    try {
      let headers: Record<string, string> = {
        Accept: 'text/event-stream',
        ...buildCommonHeaders(token || undefined),
      }
      if (token) headers.Authorization = `Bearer ${token}`
      headers = withDemoAuthHeaders(url, headers)

      const fetchInit: RequestInit = {
        method,
        headers,
        signal: controller.signal,
        redirect: 'error',
      }
      if (options?.body !== undefined && method !== 'GET') {
        headers['Content-Type'] = 'application/json'
        fetchInit.body = JSON.stringify(options.body)
      }

      const res = await fetch(url, fetchInit)
      if (handshakeTimer) clearTimeout(handshakeTimer)
      handshakeTimer = null

      if (!res.ok || !res.body) throw new Error(`sse_http_${res.status}`)
      const contentType = res.headers.get('content-type')?.toLowerCase() ?? ''
      if (contentType && !contentType.includes('text/event-stream')) {
        throw new Error('sse_invalid_content_type')
      }
      onHeaders?.(res.headers)
      resetIdleTimer()

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (!closed) {
        const { done, value } = await reader.read()
        if (done) break
        resetIdleTimer()
        buffer += decoder.decode(value, { stream: true })
        if (buffer.length > MAX_SSE_BUFFER_CHARS) throw new Error('sse_buffer_limit')

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const raw = line.slice(5).trimStart()
          if (raw === '[DONE]') {
            onMessage({ done: true })
            continue
          }
          try {
            onMessage(JSON.parse(raw))
          } catch {
            onMessage(raw)
          }
        }
      }
    } catch (err) {
      if (!closed) {
        if (timeoutCode) onError?.(new Error(timeoutCode))
        else if ((err as Error).name !== 'AbortError') onError?.(err as Error)
      }
    } finally {
      clearTimers()
    }
  })()

  return {
    close() {
      closed = true
      clearTimers()
      controller.abort()
    },
  }
}

/** SSE client with bounded exponential reconnects. */
export function createReconnectingSSE(
  baseUrl: string,
  relativePath: string,
  token: string,
  onMessage: (data: unknown) => void,
  onError?: (err: Error) => void,
  onHeaders?: (headers: Headers) => void,
  options?: SSEOptions & {
    maxRetries?: number
    onStalled?: () => void
    onReconnecting?: (attempt: number) => void
    onReconnected?: () => void
  },
): { close: () => void } {
  const maxRetries = options?.maxRetries ?? 3
  let attempt = 0
  let closed = false
  let currentHandle: { close: () => void } | null = null
  let stalledTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  const STALLED_TIMEOUT_MS = 3_000

  function resetStalledTimer(): void {
    if (stalledTimer) clearTimeout(stalledTimer)
    stalledTimer = setTimeout(() => {
      if (!closed) options?.onStalled?.()
    }, STALLED_TIMEOUT_MS)
  }

  function connect(): void {
    if (closed) return
    currentHandle = createSSEStream(
      baseUrl,
      relativePath,
      token,
      (data) => {
        attempt = 0
        resetStalledTimer()
        onMessage(data)
      },
      (err) => {
        if (closed) return
        if (stalledTimer) clearTimeout(stalledTimer)
        if (attempt < maxRetries) {
          attempt++
          const reconnectDelay = Math.min(1_000 * Math.pow(2, attempt - 1), 8_000)
          options?.onReconnecting?.(attempt)
          reconnectTimer = setTimeout(connect, reconnectDelay)
        } else {
          onError?.(err)
        }
      },
      (headers) => {
        if (attempt > 0) options?.onReconnected?.()
        resetStalledTimer()
        onHeaders?.(headers)
      },
      options,
    )
  }

  connect()
  return {
    close() {
      closed = true
      if (stalledTimer) clearTimeout(stalledTimer)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      currentHandle?.close()
    },
  }
}