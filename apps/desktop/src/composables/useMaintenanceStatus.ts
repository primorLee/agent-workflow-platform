/**
 * useMaintenanceStatus — polls /v1/maintenance and exposes reactive state.
 *
 * Mounted once near the app root (App.vue). The MaintenanceBanner component
 * reads { enabled, message } and renders the top-of-app notice when on.
 *
 * Endpoint is public (no auth required server-side) — the api client will
 * still attach an Authorization header if one exists, but the server's
 * system router ignores it.
 *
 * Poll cadence:
 *   * 2s initial delay (don't block first paint)
 *   * 15s between successful polls
 *   * Exponential back-off on error (cap 120s) so an outage doesn't amplify
 *   * `silent: true` so transient errors don't pop user-facing toasts
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { api, ApiError } from '@/api/client'

export interface MaintenanceState {
  enabled: boolean
  message: string
  updated_at: string | null
}

interface ApiResponse {
  enabled?: boolean
  message?: string
  updated_at?: string | null
}

const DEFAULT_MESSAGE = 'Agent Workflow Platform 正在维护中，预计 10 分钟内恢复。感谢您的耐心等待。'
const POLL_OK_MS = 15_000
const POLL_BACKOFF_MAX_MS = 120_000

export function useMaintenanceStatus() {
  const enabled = ref(false)
  const message = ref(DEFAULT_MESSAGE)
  const updatedAt = ref<string | null>(null)
  const lastError = ref<string | null>(null)

  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let currentInterval = POLL_OK_MS

  async function pollOnce(): Promise<void> {
    try {
      const data = await api.get<ApiResponse>('/v1/maintenance', undefined, {
        timeout: 8_000,
        silent: true,
      })
      enabled.value = Boolean(data?.enabled)
      if (typeof data?.message === 'string' && data.message.length > 0) {
        message.value = data.message
      }
      updatedAt.value = typeof data?.updated_at === 'string' ? data.updated_at : null
      lastError.value = null
      currentInterval = POLL_OK_MS
    } catch (err) {
      const detail = err instanceof ApiError ? err.detail : String(err)
      lastError.value = detail
      currentInterval = Math.min(currentInterval * 2, POLL_BACKOFF_MAX_MS)
    }
  }

  function schedule(delayMs: number): void {
    if (stopped) return
    timer = setTimeout(async () => {
      await pollOnce()
      schedule(currentInterval)
    }, delayMs)
  }

  onMounted(() => {
    schedule(2_000)
  })

  onBeforeUnmount(() => {
    stopped = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  })

  return { enabled, message, updatedAt, lastError }
}
