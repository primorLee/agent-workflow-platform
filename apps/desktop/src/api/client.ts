import { useToastStore } from '@/stores/toast'
import { useAuthStore } from '@/stores/auth'
import router from '@/router'
import { sanitizeErrorMessage } from '@/utils/sanitize'
import i18n from '@/i18n'
import { tryClaimAuthStale } from '@/api/authStaleCoordinator'
import { buildCommonHeaders } from '@/api/buildCommonHeaders'
import { isHostedAuthEnabled } from '@/utils/hostedAuth'
import { normalizeServiceBaseUrl } from '@/utils/service-base-url'
import { withDemoAuthHeaders } from '@/api/demo-auth'

/** Translate via shared i18n instance (works outside component setup). */
interface I18nGlobal {
  t: (key: string, params?: Record<string, unknown>) => string
}
function t(key: string, params?: Record<string, unknown>): string {
  return (i18n.global as unknown as I18nGlobal).t(key, params)
}

export class ApiError extends Error {
  status: number
  code: string
  detail: string

  constructor(status: number, body: unknown) {
    const b = (body ?? {}) as Record<string, unknown>
    const errField = b.error
    let detail: string = `HTTP ${status}`
    if (typeof b.detail === 'string') detail = b.detail
    else if (typeof b.message === 'string') detail = b.message
    else if (typeof errField === 'string') detail = errField
    else if (errField && typeof errField === 'object') {
      const e = errField as Record<string, unknown>
      if (typeof e.detail === 'string') detail = e.detail
      else if (typeof e.message === 'string') detail = e.message
    }
    super(detail)
    this.name = 'ApiError'
    this.status = status
    this.code = (typeof b.error_type === 'string' && b.error_type)
      || (typeof b.code === 'string' && b.code)
      || 'unknown'
    this.detail = detail
  }
}

/** Per-request options that callers can override. */
export interface RequestOptions {
  /** Request timeout in ms (default: 30000). */
  timeout?: number
  /** Suppress automatic toast notifications for errors. */
  silent?: boolean
  /** Extra headers merged on top of defaults. */
  headers?: Record<string, string>
}

// ---------------------------------------------------------------------------
// Retry / back-off configuration
// ---------------------------------------------------------------------------

/** Status codes that trigger an automatic retry with exponential back-off. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503])

/** Maximum number of retry attempts (on top of the initial request). */
const MAX_RETRIES = 3

/** Base delay for exponential back-off (doubles each retry). */
const BASE_DELAY_MS = 1000

/** Default request timeout. */
const DEFAULT_TIMEOUT_MS = 30_000

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Compute back-off delay.  For 429 responses the server may include a
 * `Retry-After` header (seconds) — honour it when present.
 */
function getRetryDelay(attempt: number, retryAfterHeader?: string | null): number {
  if (retryAfterHeader) {
    const secs = Number(retryAfterHeader)
    if (!Number.isNaN(secs) && secs > 0) return Math.min(secs * 1000, 60_000)
  }
  // Exponential back-off with jitter
  const exponential = BASE_DELAY_MS * Math.pow(2, attempt)
  const jitter = Math.random() * BASE_DELAY_MS * 0.5
  return Math.min(exponential + jitter, 30_000)
}

// ---------------------------------------------------------------------------
// Connection-store bridge (lazy — avoids import cycles with Pinia)
// ---------------------------------------------------------------------------

let _connectionStore: { connected: { value: boolean } } | null = null

/**
 * Called once during app bootstrap (e.g. in main.ts or a plugin) to wire the
 * API client to the connection store.  This avoids a direct import which would
 * create circular dependencies.
 */
export function bindConnectionStore(store: { connected: { value: boolean } }): void {
  _connectionStore = store
}

function setOffline(): void {
  if (_connectionStore) _connectionStore.connected.value = false
}

function isNavigatorOffline(): boolean {
  return typeof navigator !== 'undefined' && !navigator.onLine
}

// ---------------------------------------------------------------------------
// Toast helper
// ---------------------------------------------------------------------------

/**
 * Show a user-friendly toast for known HTTP error statuses.
 * Returns `true` if a toast was shown (i.e. the error was handled at the
 * interceptor level) so callers can decide whether to show their own message.
 */
function handleErrorStatus(err: ApiError, silent = false): boolean {
  if (silent) return false

  let toast: ReturnType<typeof useToastStore> | null = null
  try {
    toast = useToastStore()
  } catch {
    // Pinia may not be installed yet (e.g. during early boot) — degrade silently.
    return false
  }

  switch (err.status) {
    case 0:
      // Don't toast on network errors — connection store handles offline state silently.
      // Toasting here causes "网络连接失败" on every startup race condition.
      return true
    case 401:
      if (!isHostedAuthEnabled()) return true
      // Shared debounce with App.vue's SSE-side `onAuthTokenStale` handler.
      // The first 401 (whether from SSE or REST) claims the lock and runs
      // the full flow; subsequent 401s within the debounce window just swallow.
      // Without this, a login-expired user on the chat page gets spammed
      // by every background poll (tasks, sessions, and health).
      // DEV builds historically skipped this branch entirely — that left the
      // renderer stranded on a protected view after silent token expiry.
      // We now run the same flow in DEV too; the `isDevMode` route guard
      // still bypasses auth for local work, so this is purely additive.
      if (tryClaimAuthStale()) {
        toast.error(t('api.loginExpired'))
        // Wipe the cached token so the router guard / re-login flow starts
        // from a clean slate.
        try { useAuthStore().clearAuth() } catch { /* store not ready */ }
        try { router.push({ name: 'login' }) } catch { /* router not ready */ }
      }
      return true
    case 403:
      toast.error(t('api.forbidden'))
      return true
    case 404:
      // Don't toast 404 — many routes return 404 for "no data" in DEV mode
      return true
    case 408:
      toast.error(t('api.requestTimeout'))
      return true
    case 422:
      toast.error(t('api.badRequest', { detail: sanitizeErrorMessage(err.detail, err.detail ?? t('api.invalidParams')) }))
      return true
    case 429:
      toast.warning(t('api.tooManyRequests'))
      return true
    case 500:
      toast.error(t('api.serverError'))
      return true
    case 502:
      toast.error(t('api.badGateway'))
      return true
    case 503:
      toast.error(t('api.serviceUnavailable'))
      return true
    default:
      if (err.status >= 500) {
        toast.error(t('api.serverErrorWithStatus', { status: err.status }))
        return true
      }
      if (err.status >= 400) {
        const safe = err.detail ? sanitizeErrorMessage(err.detail, err.detail) : ''
        toast.error(safe || t('api.requestFailedWithStatus', { status: err.status }))
        return true
      }
      return false
  }
}

// ---------------------------------------------------------------------------
// ApiClient
// ---------------------------------------------------------------------------

export class ApiClient {
  private baseUrl: string = ''
  private token: string = ''
  private csrfToken: string = ''

  setBaseUrl(url: string): void {
    const normalized = normalizeServiceBaseUrl(url)
    if (!normalized) {
      this.baseUrl = ''
      this.token = ''
      this.csrfToken = ''
      throw new Error('invalid_service_base')
    }
    if (this.baseUrl && this.baseUrl !== normalized) {
      this.token = ''
      this.csrfToken = ''
    }
    this.baseUrl = normalized
  }

  setToken(token: string): void {
    this.token = token
  }

  setCsrfToken(csrf: string): void {
    this.csrfToken = csrf
  }

  getBaseUrl(): string {
    return this.baseUrl
  }

  getToken(): string {
    return this.token
  }

  private requireBaseUrl(): string {
    if (!this.baseUrl) throw new Error('service_base_not_configured')
    return this.baseUrl
  }

  private buildHeaders(targetUrl: string, extra?: Record<string, string>): Record<string, string> {
    // 2026-05-25 — merge buildCommonHeaders so every JSON request advertises
    // X-AgentWorkflowPlatform-Client-Version + X-AgentWorkflowPlatform-Capabilities (e.g. cc-on-desktop).
    // Without this the cloud chat.py mode_switch short-circuit never fires.
    // SSE path has a mirror fix in api/sse.ts.
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...buildCommonHeaders(this.token ?? undefined),
    }
    // buildCommonHeaders sets Authorization when this.token is set; the
    // explicit assignments below are defensive duplicates so a future
    // refactor of buildCommonHeaders can't silently drop them.
    if (this.token) h['Authorization'] = `Bearer ${this.token}`
    if (this.csrfToken) h['X-CSRF-Token'] = this.csrfToken
    if (extra) Object.assign(h, extra)
    return withDemoAuthHeaders(targetUrl, h)
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string>,
    opts?: RequestOptions,
  ): Promise<T> {
    // Early offline guard
    if (isNavigatorOffline()) {
      setOffline()
      const err = new ApiError(0, {
        error_type: 'OFFLINE',
        detail: t('api.offline'),
      })
      handleErrorStatus(err, opts?.silent)
      throw err
    }

    let url = `${this.requireBaseUrl()}${path}`
    if (params) {
      const qs = new URLSearchParams(params).toString()
      if (qs) url += `?${qs}`
    }

    const timeoutMs = opts?.timeout ?? DEFAULT_TIMEOUT_MS
    let lastError: ApiError | null = null

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Back-off delay before retries (skip on first attempt)
      if (attempt > 0 && lastError) {
        const retryAfter = (lastError as unknown as { _retryAfter?: string })._retryAfter
        await delay(getRetryDelay(attempt - 1, retryAfter))
      }

      // --- Abort controller for timeout ---
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      let res: Response
      try {
        res = await fetch(url, {
          method,
          headers: this.buildHeaders(url, opts?.headers),
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
          redirect: 'error',
        })
      } catch (_networkErr) {
        void _networkErr
        clearTimeout(timer)

        // Detect abort (timeout) vs real network error
        if (controller.signal.aborted) {
          const err = new ApiError(408, {
            error_type: 'TIMEOUT',
            detail: t('api.requestTimeoutWithMs', { ms: timeoutMs }),
          })
          handleErrorStatus(err, opts?.silent)
          throw err
        }

        // Network-level failure (DNS, connection refused, offline, etc.)
        setOffline()
        const err = new ApiError(0, {
          error_type: 'NETWORK_ERROR',
          detail: t('api.networkError'),
        })
        handleErrorStatus(err, opts?.silent)
        throw err
      } finally {
        clearTimeout(timer)
      }

      // --- Success ---
      if (res.ok) {
        if (res.status === 204) return undefined as T
        return res.json() as Promise<T>
      }

      // --- Parse error body ---
      let errorBody: unknown = {}
      try {
        errorBody = await res.json()
      } catch {
        /* non-JSON error body */
      }

      lastError = new ApiError(res.status, errorBody)

      // Stash Retry-After for 429 back-off computation
      if (res.status === 429) {
        ;(lastError as unknown as { _retryAfter?: string })._retryAfter =
          res.headers.get('Retry-After') ?? undefined
      }

      // --- Auth errors: no retry, handle immediately ---
      if (res.status === 401 || res.status === 403) {
        handleErrorStatus(lastError, opts?.silent)
        // Also notify auth store. Static import is safe here — auth.ts only
        // uses `api` inside store callbacks (lazy), so the cycle resolves by
        // the time useAuthStore() is invoked at runtime.
        if (res.status === 401 && isHostedAuthEnabled()) {
          try {
            useAuthStore().handleUnauthorized()
          } catch { /* store not ready (e.g. Pinia not installed yet) */ }
        }
        throw lastError
      }

      // --- Retry on retryable status codes ---
      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
        continue
      }

      // Not retryable or exhausted retries — break out
      break
    }

    // If we get here, lastError is always set
    handleErrorStatus(lastError!, opts?.silent)
    throw lastError!
  }

  // -----------------------------------------------------------------------
  // Public HTTP methods
  // -----------------------------------------------------------------------

  async get<T>(path: string, params?: Record<string, string>, opts?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, undefined, params, opts)
  }

  async post<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, body, undefined, opts)
  }

  async put<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>('PUT', path, body, undefined, opts)
  }

  async patch<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>('PATCH', path, body, undefined, opts)
  }

  async delete<T>(path: string, params?: Record<string, string>, opts?: RequestOptions): Promise<T> {
    return this.request<T>('DELETE', path, undefined, params, opts)
  }

  /**
   * POST a multipart/form-data payload (e.g. file upload). Goes out as a
   * real multipart request — the browser fills in the boundary, so we do NOT
   * set Content-Type ourselves (fetch would otherwise clobber the boundary).
   *
   * Auth / offline / timeout / 401-redirect behaviour mirrors the JSON
   * `request()` path; we intentionally skip the retry loop because resending
   * a large multipart body on 5xx is usually the wrong call (server-side
   * partial writes, idempotency unclear).
   */
  async postForm<T>(path: string, form: FormData, opts?: RequestOptions): Promise<T> {
    if (isNavigatorOffline()) {
      setOffline()
      const err = new ApiError(0, {
        error_type: 'OFFLINE',
        detail: t('api.offline'),
      })
      handleErrorStatus(err, opts?.silent)
      throw err
    }

    const url = `${this.requireBaseUrl()}${path}`
    const timeoutMs = opts?.timeout ?? DEFAULT_TIMEOUT_MS

    // Build headers without Content-Type so the browser sets
    // `multipart/form-data; boundary=...` itself.
    // 2026-05-25 — mirror the buildCommonHeaders integration in
    // buildHeaders() / sse.ts so multipart uploads also advertise
    // X-AgentWorkflowPlatform-Client-Version + X-AgentWorkflowPlatform-Capabilities. Future cloud
    // routes can gate behaviour on the capabilities header for uploads
    // (e.g. tarball-vs-streamed) without touching this path again.
    let headers: Record<string, string> = {
      Accept: 'application/json',
      ...buildCommonHeaders(this.token ?? undefined),
    }
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`
    if (this.csrfToken) headers['X-CSRF-Token'] = this.csrfToken
    if (opts?.headers) Object.assign(headers, opts.headers)
    // Defensive: strip any Content-Type the caller tried to set.
    delete headers['Content-Type']
    delete (headers as Record<string, string>)['content-type']
    headers = withDemoAuthHeaders(url, headers)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: form,
        signal: controller.signal,
        redirect: 'error',
      })
    } catch (_networkErr) {
      void _networkErr
      clearTimeout(timer)
      if (controller.signal.aborted) {
        const err = new ApiError(408, {
          error_type: 'TIMEOUT',
          detail: t('api.requestTimeoutWithMs', { ms: timeoutMs }),
        })
        handleErrorStatus(err, opts?.silent)
        throw err
      }
      setOffline()
      const err = new ApiError(0, {
        error_type: 'NETWORK_ERROR',
        detail: t('api.networkError'),
      })
      handleErrorStatus(err, opts?.silent)
      throw err
    } finally {
      clearTimeout(timer)
    }

    if (res.ok) {
      if (res.status === 204) return undefined as T
      return res.json() as Promise<T>
    }

    let errorBody: unknown = {}
    try {
      errorBody = await res.json()
    } catch {
      try { errorBody = { detail: await res.text() } } catch { /* unreadable */ }
    }
    const apiErr = new ApiError(res.status, errorBody)

    if (res.status === 401) {
      handleErrorStatus(apiErr, opts?.silent)
      if (isHostedAuthEnabled()) try {
        useAuthStore().handleUnauthorized()
      } catch (err) {
        console.warn('[api.postForm] failed to notify auth store after 401:', err)
      }
      throw apiErr
    }

    handleErrorStatus(apiErr, opts?.silent)
    throw apiErr
  }

  /**
   * GET a binary/CSV response as a Blob, with the same timeout, 401/403/429,
   * retry, offline, and structured-error handling as the JSON helpers. Added
   * so any authenticated blob download stops
   * bypassing ApiClient with a bare `fetch` (finding F5 of the 2026-04-19
   * industrial-grade audit).
   */
  async getBlob(
    path: string,
    params?: Record<string, string>,
    opts?: RequestOptions & { accept?: string },
  ): Promise<Blob> {
    const timeoutMs = opts?.timeout ?? DEFAULT_TIMEOUT_MS

    if (isNavigatorOffline()) {
      setOffline()
      const err = new ApiError(0, {
        error_type: 'OFFLINE',
        detail: t('api.offline'),
      })
      handleErrorStatus(err, opts?.silent)
      throw err
    }

    let url = `${this.requireBaseUrl()}${path}`
    if (params) {
      const qs = new URLSearchParams(params).toString()
      if (qs) url += `?${qs}`
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res: Response
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: this.buildHeaders(url, {
          ...(opts?.accept ? { Accept: opts.accept } : {}),
          ...opts?.headers,
        }),
        signal: controller.signal,
        redirect: 'error',
      })
    } catch (err) {
      if (controller.signal.aborted) {
        const e = new ApiError(408, {
          error_type: 'TIMEOUT',
          detail: t('api.requestTimeoutWithMs', { ms: timeoutMs }),
        })
        handleErrorStatus(e, opts?.silent)
        throw e
      }
      setOffline()
      const e = new ApiError(0, {
        error_type: 'NETWORK_ERROR',
        detail: t('api.networkError'),
      })
      handleErrorStatus(e, opts?.silent)
      throw e
    } finally {
      clearTimeout(timer)
    }

    if (res.ok) return res.blob()

    // Best-effort parse of error body (may be JSON, may be empty)
    let errorBody: unknown = {}
    try {
      errorBody = await res.json()
    } catch {
      try { errorBody = { detail: await res.text() } } catch { /* unreadable body */ }
    }
    const apiErr = new ApiError(res.status, errorBody)

    if (res.status === 401) {
      handleErrorStatus(apiErr, opts?.silent)
      if (isHostedAuthEnabled()) try {
        useAuthStore().handleUnauthorized()
      } catch (err) {
        console.warn('[api.getBlob] failed to notify auth store after 401:', err)
      }
      throw apiErr
    }

    handleErrorStatus(apiErr, opts?.silent)
    throw apiErr
  }
}

export const api = new ApiClient()
