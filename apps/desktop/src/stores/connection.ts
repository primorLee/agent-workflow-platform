import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '@/api/client'
import type { HealthStatus } from '@/api/types'
import i18n from '@/i18n'

interface I18nGlobal {
  t: (key: string, params?: Record<string, unknown>) => string
}
function t(key: string): string {
  return (i18n.global as unknown as I18nGlobal).t(key)
}

export const useConnectionStore = defineStore('connection', () => {
  const connected = ref(false)
  const online = ref(typeof navigator !== 'undefined' ? navigator.onLine : true)
  const serverVersion = ref('')
  const checking = ref(false)
  const lastCheckTime = ref<string | null>(null)
  const consecutiveFailures = ref(0)
  const error = ref<string | null>(null)
  const wasConnected = ref(false)
  const lastConnectedAt = ref<string | null>(null)
  let pollTimer: ReturnType<typeof setTimeout> | null = null

  // Reconnect callback registry
  const reconnectCallbacks: Array<() => void> = []

  function onReconnect(cb: () => void) {
    reconnectCallbacks.push(cb)
    // Return unsubscribe function
    return () => {
      const idx = reconnectCallbacks.indexOf(cb)
      if (idx !== -1) reconnectCallbacks.splice(idx, 1)
    }
  }

  // --- Computed ---

  const statusText = computed(() => {
    if (!online.value) return 'offline'
    if (checking.value) return 'checking'
    return connected.value ? 'connected' : 'disconnected'
  })

  // --- Browser online/offline events ---

  let _browserListenersAttached = false

  function attachBrowserListeners(): void {
    if (_browserListenersAttached || typeof window === 'undefined') return
    _browserListenersAttached = true

    window.addEventListener('online', () => {
      online.value = true
      // Browser went online — immediately probe the server
      testConnection()
    })

    window.addEventListener('offline', () => {
      online.value = false
      connected.value = false
    })
  }

  // --- Actions ---

  async function testConnection(): Promise<boolean> {
    // If browser says offline, skip the network call
    if (!online.value) {
      connected.value = false
      error.value = t('connection.browserOffline')
      return false
    }

    checking.value = true
    error.value = null
    try {
      const health = await api.get<HealthStatus>('/api/health', undefined, { silent: true, timeout: 10_000 })
      const isHealthy = health.status === 'ok' || health.status === 'degraded'
      const wasPreviouslyDisconnected = !connected.value

      connected.value = isHealthy
      serverVersion.value = health.version ?? ''
      lastCheckTime.value = new Date().toISOString()
      consecutiveFailures.value = 0

      if (isHealthy) {
        lastConnectedAt.value = new Date().toISOString()

        // Detect reconnection: was connected before, went offline, now back
        if (wasPreviouslyDisconnected && wasConnected.value) {
          reconnectCallbacks.forEach(cb => {
            try { cb() } catch { /* ignore callback errors */ }
          })
        }
        wasConnected.value = true
      }

      return connected.value
    } catch (err) {
      connected.value = false
      serverVersion.value = ''
      consecutiveFailures.value++
      error.value = (err as Error).message
      return false
    } finally {
      checking.value = false
    }
  }

  function startHealthPolling(intervalMs = 30_000) {
    attachBrowserListeners()
    stopHealthPolling()
    testConnection()

    let currentInterval = intervalMs

    function scheduleNext() {
      pollTimer = setTimeout(async () => {
        const ok = await testConnection()

        // Adjust polling frequency based on connection state
        let newInterval = intervalMs
        if (!ok) {
          if (consecutiveFailures.value >= 10) {
            newInterval = 60_000
          } else if (consecutiveFailures.value >= 3) {
            newInterval = 10_000
          }
        }

        currentInterval = newInterval
        scheduleNext()
      }, currentInterval)
    }

    scheduleNext()
  }

  function stopHealthPolling() {
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
  }

  return {
    // State
    connected,
    online,
    serverVersion,
    checking,
    lastCheckTime,
    consecutiveFailures,
    error,
    wasConnected,
    lastConnectedAt,
    // Computed
    statusText,
    // Actions
    testConnection,
    startHealthPolling,
    stopHealthPolling,
    onReconnect,
    attachBrowserListeners,
  }
})
