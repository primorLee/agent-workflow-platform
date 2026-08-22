/**
 * Explicitly configured connection-health monitor for the Electron shell.
 * No endpoint is contacted unless a validated control-plane or compatibility
 * stream URL is present. The local chat adapter is a separate service.
 */
import { BrowserWindow, ipcMain } from 'electron'
import { log } from '../utils/logger'
import { getAuthHeaders } from '../utils/config'
import {
  normalizeServiceBaseUrl,
  normalizeServiceEndpointUrl,
} from '../utils/service-base-url'

export type ConnectionState =
  | 'connecting'
  | 'online'
  | 'degraded'
  | 'offline'
  | 'error'
  | 'unknown'

export interface ConnectionHealthSnapshot {
  state: ConnectionState
  agent_id: string | null
  last_heartbeat: string | null
  last_heartbeat_age_s: number | null
  transport: string
  active_tasks: number
  version: string
  uptime_s: number | null
  recent_errors: string[]
  hostname: string
  received_at_ms: number
  last_error: string | null
}

const DEFAULT_SNAPSHOT: ConnectionHealthSnapshot = {
  state: 'unknown',
  agent_id: null,
  last_heartbeat: null,
  last_heartbeat_age_s: null,
  transport: 'disabled',
  active_tasks: 0,
  version: '',
  uptime_s: null,
  recent_errors: [],
  hostname: '',
  received_at_ms: 0,
  last_error: null,
}

let _lastSnapshot: ConnectionHealthSnapshot = { ...DEFAULT_SNAPSHOT }
let _abort: AbortController | null = null
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null
let _running = false
let _backoffMs = 2_000
const BACKOFF_CAP_MS = 30_000
const BACKOFF_CAP_AUTH_MS = 60_000
const CONTROL_PLANE_POLL_MS = 5_000
const REQUEST_TIMEOUT_MS = 5_000
const SSE_HANDSHAKE_TIMEOUT_MS = 10_000
const SSE_IDLE_TIMEOUT_MS = 45_000
const MAX_JSON_BYTES = 1_048_576
const MAX_SSE_BUFFER_CHARS = 1_048_576

type ConnectionTarget =
  | { kind: 'disabled'; reason: string }
  | { kind: 'control-plane-poll'; url: string }
  | { kind: 'compat-sse'; url: string }

function _resolveConnectionTarget(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ConnectionTarget {
  const streamRaw = env.AWP_CONNECTION_HEALTH_SSE_URL
  if (env.AWP_ENABLE_CONNECTION_HEALTH_SSE === '1') {
    const streamUrl = normalizeServiceEndpointUrl(streamRaw)
    if (!streamUrl) return { kind: 'disabled', reason: 'invalid-compat-sse-url' }
    return { kind: 'compat-sse', url: streamUrl }
  }
  if (streamRaw) return { kind: 'disabled', reason: 'compat-sse-not-enabled' }

  const configuredBase = env.AWP_CONTROL_PLANE_URL
  if (!configuredBase) return { kind: 'disabled', reason: 'network-not-configured' }
  const base = normalizeServiceBaseUrl(configuredBase)
  if (!base) return { kind: 'disabled', reason: 'invalid-control-plane-url' }
  return { kind: 'control-plane-poll', url: `${base}/v1/health/ready` }
}

function _shouldAutoConnect(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (_resolveConnectionTarget(env).kind === 'disabled') return false
  return env.NODE_ENV !== 'test' || env.AWP_ENABLE_NETWORK_IN_TESTS === '1'
}

function _controlPlaneHeaders(_url: string): Record<string, string> {
  const token = process.env.AWP_CONTROL_PLANE_API_KEY?.trim() ?? ''
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function _broadcastSnapshot(snap: ConnectionHealthSnapshot): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('connection-health:update', snap)
  }
}

function _mergeAndMaybeBroadcast(patch: Partial<ConnectionHealthSnapshot>): void {
  const next: ConnectionHealthSnapshot = {
    ..._lastSnapshot,
    ...patch,
    received_at_ms: Date.now(),
  }
  const changed =
    next.state !== _lastSnapshot.state
    || next.agent_id !== _lastSnapshot.agent_id
    || next.last_heartbeat !== _lastSnapshot.last_heartbeat
    || next.last_heartbeat_age_s !== _lastSnapshot.last_heartbeat_age_s
    || next.transport !== _lastSnapshot.transport
    || next.active_tasks !== _lastSnapshot.active_tasks
    || next.version !== _lastSnapshot.version
    || next.hostname !== _lastSnapshot.hostname
    || next.last_error !== _lastSnapshot.last_error
  _lastSnapshot = next
  if (changed) _broadcastSnapshot(_lastSnapshot)
}

async function _readJsonLimited(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) throw new Error('response-too-large')
  const text = await response.text()
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) {
    throw new Error('response-too-large')
  }
  return JSON.parse(text)
}

async function _runControlPlanePoll(readyUrl: string): Promise<void> {
  if (!_running) return
  const validatedReadyUrl = normalizeServiceEndpointUrl(readyUrl)
  if (!validatedReadyUrl || new URL(validatedReadyUrl).pathname !== '/v1/health/ready') {
    _mergeAndMaybeBroadcast({ state: 'unknown', last_error: 'invalid-control-plane-target' })
    return
  }

  _abort = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    _abort?.abort()
  }, REQUEST_TIMEOUT_MS)

  try {
    const readyResponse = await fetch(validatedReadyUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: _abort.signal,
      redirect: 'error',
    })
    if (!readyResponse.ok) {
      _mergeAndMaybeBroadcast({ state: 'error', last_error: `health-http-${readyResponse.status}` })
      _scheduleReconnect()
      return
    }

    const readyBody = await _readJsonLimited(readyResponse) as { status?: unknown }
    if (readyBody.status !== 'ok') {
      _mergeAndMaybeBroadcast({ state: 'degraded', last_error: 'health-not-ready' })
      _scheduleReconnect()
      return
    }

    let activeTasks = 0
    let summaryError: string | null = null
    const authHeaders = _controlPlaneHeaders(validatedReadyUrl)
    if (authHeaders.Authorization) {
      const tasksUrl = new URL('/v1/tasks', validatedReadyUrl).toString()
      const tasksResponse = await fetch(tasksUrl, {
        method: 'GET',
        headers: { Accept: 'application/json', ...authHeaders },
        signal: _abort.signal,
        redirect: 'error',
      })
      if (tasksResponse.ok) {
        const tasks = await _readJsonLimited(tasksResponse)
        if (Array.isArray(tasks)) {
          activeTasks = tasks.filter((task) => {
            if (!task || typeof task !== 'object') return false
            const status = (task as { status?: unknown }).status
            return status === 'pending' || status === 'running'
          }).length
        }
      } else {
        summaryError = `tasks-http-${tasksResponse.status}`
      }
    }

    const endpoint = new URL(validatedReadyUrl)
    _backoffMs = CONTROL_PLANE_POLL_MS
    _mergeAndMaybeBroadcast({
      state: summaryError ? 'degraded' : 'online',
      agent_id: null,
      last_heartbeat: null,
      last_heartbeat_age_s: null,
      transport: 'https-longpoll',
      active_tasks: activeTasks,
      version: 'public-control-plane',
      uptime_s: null,
      recent_errors: summaryError ? [summaryError] : [],
      hostname: endpoint.host,
      last_error: summaryError,
    })
    _scheduleReconnect(CONTROL_PLANE_POLL_MS)
  } catch (error) {
    if ((error as { name?: string })?.name === 'AbortError' && !_running) return
    const message = timedOut ? `health-timeout-${REQUEST_TIMEOUT_MS}ms` : 'health-request-failed'
    log(`[connection-health] control-plane poll error: ${message}`)
    _mergeAndMaybeBroadcast({ state: 'error', last_error: message })
    _scheduleReconnect()
  } finally {
    clearTimeout(timeout)
    _abort = null
  }
}

function _parseSseFrame(frame: string): { type: string; data?: unknown } | null {
  const dataLines: string[] = []
  for (const line of frame.split('\n')) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  if (dataLines.length === 0) return null
  try {
    const parsed = JSON.parse(dataLines.join('\n')) as { type?: string; data?: unknown }
    return { type: String(parsed.type ?? 'message'), data: parsed.data }
  } catch {
    return null
  }
}

async function _runSseLoop(streamUrl: string): Promise<void> {
  if (!_running) return
  const validatedUrl = normalizeServiceEndpointUrl(streamUrl)
  if (!validatedUrl) {
    _mergeAndMaybeBroadcast({ state: 'unknown', last_error: 'invalid-compat-sse-url' })
    return
  }

  const authHeaders = await getAuthHeaders().catch(() => ({} as Record<string, string>))
  _abort = new AbortController()
  let timeoutReason: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timeoutReason = 'sse-handshake-timeout'
    _abort?.abort()
  }, SSE_HANDSHAKE_TIMEOUT_MS)
  const resetIdleTimer = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timeoutReason = 'sse-idle-timeout'
      _abort?.abort()
    }, SSE_IDLE_TIMEOUT_MS)
  }

  try {
    const response = await fetch(validatedUrl, {
      method: 'GET',
      headers: { ...authHeaders, Accept: 'text/event-stream' },
      signal: _abort.signal,
      redirect: 'error',
    })
    if (timer) clearTimeout(timer)
    timer = null

    if (response.status === 401 || response.status === 403) {
      _mergeAndMaybeBroadcast({ state: 'unknown', last_error: `auth-${response.status}` })
      _scheduleReconnect(BACKOFF_CAP_AUTH_MS)
      return
    }
    if (!response.ok || !response.body) {
      _mergeAndMaybeBroadcast({ state: 'error', last_error: `http-${response.status}` })
      _scheduleReconnect()
      return
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (contentType && !contentType.includes('text/event-stream')) {
      _mergeAndMaybeBroadcast({ state: 'error', last_error: 'invalid-content-type' })
      _scheduleReconnect()
      return
    }

    _backoffMs = 2_000
    resetIdleTimer()
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      resetIdleTimer()
      buffer += decoder.decode(value, { stream: true })
      if (buffer.length > MAX_SSE_BUFFER_CHARS) throw new Error('sse-buffer-limit')
      let separatorIndex: number
      while ((separatorIndex = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, separatorIndex)
        buffer = buffer.slice(separatorIndex + 2)
        const parsed = _parseSseFrame(frame)
        if (parsed?.type !== 'snapshot' || !parsed.data) continue
        const raw = parsed.data as Partial<ConnectionHealthSnapshot>
        _mergeAndMaybeBroadcast({
          state: (raw.state as ConnectionState) ?? 'unknown',
          agent_id: raw.agent_id ?? null,
          last_heartbeat: raw.last_heartbeat ?? null,
          last_heartbeat_age_s: raw.last_heartbeat_age_s ?? null,
          transport: raw.transport ?? 'unknown',
          active_tasks: Number(raw.active_tasks ?? 0),
          version: raw.version ?? '',
          uptime_s: raw.uptime_s ?? null,
          recent_errors: Array.isArray(raw.recent_errors) ? raw.recent_errors.slice(0, 20) : [],
          hostname: raw.hostname ?? '',
          last_error: null,
        })
      }
    }
    _mergeAndMaybeBroadcast({ state: 'connecting', last_error: 'stream-closed' })
    _scheduleReconnect()
  } catch (error) {
    if ((error as { name?: string })?.name === 'AbortError' && !_running) return
    const message = timeoutReason ?? (error instanceof Error ? error.message : 'sse-failed')
    log(`[connection-health] compatibility stream error: ${message.slice(0, 120)}`)
    _mergeAndMaybeBroadcast({ state: 'error', last_error: message.slice(0, 120) })
    _scheduleReconnect()
  } finally {
    if (timer) clearTimeout(timer)
    _abort = null
  }
}

async function _runConnectionLoop(): Promise<void> {
  const target = _resolveConnectionTarget()
  if (target.kind === 'control-plane-poll') await _runControlPlanePoll(target.url)
  else if (target.kind === 'compat-sse') await _runSseLoop(target.url)
}

function _scheduleReconnect(overrideCapMs?: number): void {
  if (!_running || _reconnectTimer) return
  const cap = overrideCapMs ?? BACKOFF_CAP_MS
  const waitMs = Math.min(_backoffMs, cap)
  _backoffMs = Math.min(_backoffMs * 2, cap)
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null
    void _runConnectionLoop()
  }, waitMs)
}

export function startConnectionHealth(): void {
  if (_running) return
  _running = true
  ipcMain.handle('connection-health:get', (): ConnectionHealthSnapshot => ({ ..._lastSnapshot }))
  _lastSnapshot = { ...DEFAULT_SNAPSHOT, received_at_ms: Date.now() }

  const target = _resolveConnectionTarget()
  if (target.kind === 'disabled') {
    log(`[connection-health] disabled: ${target.reason}`)
    return
  }
  if (!_shouldAutoConnect()) {
    _mergeAndMaybeBroadcast({ state: 'unknown', last_error: 'network-disabled-in-test' })
    return
  }

  log(`[connection-health] starting ${target.kind}`)
  setTimeout(() => {
    if (_running) void _runConnectionLoop()
  }, 1_000)
}

export function stopConnectionHealth(): void {
  if (!_running) return
  _running = false
  log('[connection-health] stopping monitor')
  if (_reconnectTimer) clearTimeout(_reconnectTimer)
  _reconnectTimer = null
  _abort?.abort()
  _abort = null
}

export function _testResetState(): void {
  _running = false
  _lastSnapshot = { ...DEFAULT_SNAPSHOT }
  _backoffMs = 2_000
  if (_reconnectTimer) clearTimeout(_reconnectTimer)
  _reconnectTimer = null
  _abort?.abort()
  _abort = null
}

export function _testGetSnapshot(): ConnectionHealthSnapshot {
  return { ..._lastSnapshot }
}

export function _testApplySnapshot(patch: Partial<ConnectionHealthSnapshot>): void {
  _mergeAndMaybeBroadcast(patch)
}

export function _testParseSseFrame(frame: string): ReturnType<typeof _parseSseFrame> {
  return _parseSseFrame(frame)
}

export function _testResolveConnectionTarget(
  env: Readonly<Record<string, string | undefined>>,
): ConnectionTarget {
  return _resolveConnectionTarget(env)
}

export function _testShouldAutoConnect(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return _shouldAutoConnect(env)
}

export async function _testPollControlPlaneOnce(
  readyUrl: string,
): Promise<ConnectionHealthSnapshot> {
  _running = true
  try {
    await _runControlPlanePoll(readyUrl)
    return { ..._lastSnapshot }
  } finally {
    _running = false
    if (_reconnectTimer) clearTimeout(_reconnectTimer)
    _reconnectTimer = null
  }
}

export { DEFAULT_SNAPSHOT as _testDefaultSnapshot }