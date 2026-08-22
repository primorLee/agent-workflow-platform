import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '@/api/client'
import { createSSEStream } from '@/api/sse'
import type { ActivityEvent, ActivityPhase } from '@/types/activity'

// --- Module-level event listeners (cross-store subscription without
//     circular imports; any consumer can subscribe to raw activity events). ---
type RawActivityEvent = ActivityEvent & Record<string, unknown>
const _listeners = new Set<(evt: RawActivityEvent) => void>()

/** Subscribe to raw activity events (called after each `_processEvent`).
 *  Returns an unsubscribe function. */
export function onActivityEvent(cb: (evt: RawActivityEvent) => void): () => void {
  _listeners.add(cb)
  return () => { _listeners.delete(cb) }
}

export const useActivityStore = defineStore('activity', () => {
  // --- State ---
  const events = ref<ActivityEvent[]>([])
  const connected = ref(false)
  const error = ref<string | null>(null)
  let sseHandle: { close: () => void } | null = null

  // --- Computed ---

  /** Currently running activities */
  const activeEvents = computed(() =>
    events.value.filter(e => e.status === 'running')
  )

  /** Current phase (most recent running event) */
  const currentPhase = computed<ActivityPhase | null>(() => {
    const running = activeEvents.value
    return running.length > 0 ? running[running.length - 1]!.phase : null
  })

  /** Current phase description */
  const currentDescription = computed(() => {
    const running = activeEvents.value
    return running.length > 0 ? running[running.length - 1]!.description : null
  })

  /** Most recent event with diagnostics */
  const latestDiagnostics = computed(() => {
    const withDiag = events.value.filter(e => e.diagnostics)
    return withDiag.length > 0 ? withDiag[withDiag.length - 1] : null
  })

  /** Overall progress percentage (estimated) */
  const overallProgress = computed(() => {
    const running = activeEvents.value
    if (running.length === 0) return 0
    const latest = running[running.length - 1]!
    if (latest.progress != null) return latest.progress
    // Estimate from phase
    const phaseOrder: ActivityPhase[] = ['analyzing', 'planning', 'executing', 'tool', 'waiting', 'validating', 'publishing', 'completed']
    const idx = phaseOrder.indexOf(latest.phase)
    return idx >= 0 ? Math.round((idx / phaseOrder.length) * 100) : 0
  })

  // --- Actions ---

  /** Connect to the activity SSE stream */
  function connect(taskId?: string) {
    disconnect()

    const params = new URLSearchParams()
    if (taskId) params.set('task_id', taskId)
    const qs = params.toString()
    const relativePath = `/v1/activity/stream${qs ? '?' + qs : ''}`

    sseHandle = createSSEStream(
      api.getBaseUrl(),
      relativePath,
      api.getToken(),
      (data) => {
        const evt = data as Record<string, unknown>
        if (evt.type === 'connected' || evt.type === 'keepalive') {
          connected.value = true
          return
        }
        // It's an activity event
        const activity = evt as unknown as ActivityEvent
        _processEvent(activity)
      },
      (err) => {
        error.value = err.message
        connected.value = false
        // Auto-reconnect after 5s
        setTimeout(() => {
          if (!sseHandle) connect(taskId)
        }, 5000)
      },
    )

    connected.value = true
    error.value = null
  }

  /** Disconnect from SSE stream */
  function disconnect() {
    sseHandle?.close()
    sseHandle = null
    connected.value = false
  }

  /** Process an incoming activity event */
  function _processEvent(evt: ActivityEvent) {
    // Update existing event or add new one
    const idx = events.value.findIndex(e => e.id === evt.id)
    if (idx >= 0) {
      events.value[idx] = evt
    } else {
      events.value.push(evt)
    }

    // When a phase completes, auto-mark previous running events of same phase
    if (evt.status === 'completed' || evt.status === 'failed') {
      events.value.forEach((e, i) => {
        if (e.id !== evt.id && e.phase === evt.phase && e.status === 'running') {
          events.value[i] = { ...e, status: 'completed' }
        }
      })
    }

    // Fan out to generic cross-store listeners such as artifact delivery.
    const raw = evt as RawActivityEvent
    _listeners.forEach((cb) => {
      try { cb(raw) } catch (err) { console.warn('[activity] listener error:', err) }
    })
  }

  /** Add a local activity event (for optimistic UI before server confirms) */
  function addLocalEvent(evt: ActivityEvent) {
    _processEvent(evt)
  }

  /** Fetch historical events from REST API */
  async function fetchHistory(taskId?: string, limit = 50) {
    try {
      const params: Record<string, string> = { limit: String(limit) }
      if (taskId) params.task_id = taskId
      const res = await api.get<{ events: ActivityEvent[] }>('/v1/activity/events', params)
      // Prepend historical events (they come in desc order, reverse to chronological)
      const historical = res.events.reverse()
      const existingIds = new Set(events.value.map(e => e.id))
      const newEvents = historical.filter(e => !existingIds.has(e.id))
      events.value = [...newEvents, ...events.value]
    } catch (err) {
      error.value = (err as Error).message
    }
  }

  /** Clear all events */
  function clear() {
    events.value = []
  }

  /** Reset store (disconnect + clear) */
  function reset() {
    disconnect()
    clear()
    error.value = null
  }

  return {
    // State
    events,
    connected,
    error,
    // Computed
    activeEvents,
    currentPhase,
    currentDescription,
    latestDiagnostics,
    overallProgress,
    // Actions
    connect,
    disconnect,
    addLocalEvent,
    fetchHistory,
    clear,
    reset,
  }
})
