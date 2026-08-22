import {
  DEFAULT_API_URL,
  isLoopbackHostname,
  normalizeApiBase,
  normalizeLive,
  normalizeReady,
  normalizeSessions,
  normalizeTasks,
  type ReadySnapshot,
  type SessionRecord,
  type TaskRecord,
} from './normalizers'

const KEY_STORAGE = 'awp.monitor.dev-key'
const CONFIGURED_API_URL = normalizeApiBase(import.meta.env.VITE_AWP_API_URL || DEFAULT_API_URL)

export interface HealthSnapshot extends ReadySnapshot {
  live: string
}

export interface ConnectionSettings {
  apiBase: string
  devKey: string
}

export interface ControlPlaneClient {
  health(): Promise<HealthSnapshot>
  tasks(): Promise<TaskRecord[]>
  sessions(): Promise<SessionRecord[]>
}

export function configuredApiUrl(): string {
  return CONFIGURED_API_URL
}

export function loadConnection(): ConnectionSettings | null {
  if (typeof window === 'undefined') return null
  const devKey = window.sessionStorage.getItem(KEY_STORAGE)?.trim()
  return devKey ? { apiBase: CONFIGURED_API_URL, devKey } : null
}

export function saveConnection(devKey: string): void {
  const cleanKey = devKey.trim()
  if (!cleanKey) throw new Error('Enter the development API key.')
  window.sessionStorage.setItem(KEY_STORAGE, cleanKey)
}

export function clearConnection(): void {
  if (typeof window !== 'undefined') window.sessionStorage.removeItem(KEY_STORAGE)
}

export function hasConnection(): boolean {
  return loadConnection() !== null
}

function shouldUseLocalProxy(apiBase: string): boolean {
  if (typeof window === 'undefined') return false
  const localUi = isLoopbackHostname(window.location.hostname)
  const supportedPort = window.location.port === '5174' || window.location.port === '4174'
  return localUi && supportedPort && apiBase === CONFIGURED_API_URL
}

function requestBase(apiBase: string): string {
  return shouldUseLocalProxy(apiBase) ? '/awp-api' : apiBase
}

function errorDetail(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 240)
  if (typeof value === 'object' && value !== null && 'detail' in value) {
    const detail = (value as { detail?: unknown }).detail
    if (typeof detail === 'string') return detail.slice(0, 240)
  }
  return ''
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) {
    if (!response.ok) return null
    throw new Error('The control plane returned a non-JSON response.')
  }
  return response.json()
}

export function createControlPlaneClient(settings: ConnectionSettings): ControlPlaneClient {
  const apiBase = normalizeApiBase(settings.apiBase)
  const devKey = settings.devKey.trim()
  const root = requestBase(apiBase)

  async function request(path: string, authenticated: boolean): Promise<unknown> {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 8_000)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (authenticated) headers.Authorization = `Bearer ${devKey}`

    try {
      const response = await fetch(`${root}${path}`, {
        method: 'GET',
        headers,
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      })
      const body = await readJson(response)
      if (!response.ok) {
        const detail = errorDetail(body)
        throw new Error(`Control plane ${response.status}${detail ? `: ${detail}` : ''}`)
      }
      return body
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error('The control plane did not respond within 8 seconds.')
      }
      if (error instanceof TypeError) {
        throw new Error(`Could not reach the control plane at ${apiBase}.`)
      }
      throw error
    } finally {
      window.clearTimeout(timeout)
    }
  }

  return {
    async health() {
      const [live, ready] = await Promise.all([
        request('/v1/health/live', false),
        request('/v1/health/ready', false),
      ])
      return { live: normalizeLive(live), ...normalizeReady(ready) }
    },
    async tasks() {
      return normalizeTasks(await request('/v1/tasks', true))
    },
    async sessions() {
      return normalizeSessions(await request('/v1/sessions', true))
    },
  }
}
