import { defineStore } from 'pinia'
import { ref } from 'vue'
import { sanitizeErrorMessage } from '@/utils/sanitize'

export type ToastType = 'success' | 'error' | 'warning' | 'info'

export interface Toast {
  id: number
  type: ToastType
  message: string
  duration: number
}

let nextId = 0

/** Throttle window: suppress duplicate error toasts within this period (ms). */
const _ERROR_THROTTLE_MS = 5000
/** Track last-shown time per (type + message) to suppress duplicates. */
const _lastShown = new Map<string, number>()

export const useToastStore = defineStore('toast', () => {
  const toasts = ref<Toast[]>([])

  function show(message: string, type: ToastType = 'info', duration?: number) {
    // --- Dedup: skip if an identical toast is already visible ---
    if (toasts.value.some(t => t.type === type && t.message === message)) return

    // --- Throttle: suppress rapid-fire identical errors ---
    if (type === 'error') {
      const key = `${type}:${message}`
      const now = Date.now()
      const last = _lastShown.get(key) ?? 0
      if (now - last < _ERROR_THROTTLE_MS) return
      _lastShown.set(key, now)
    }

    const id = nextId++
    // Default: 5 s for info/success/warning, persist (0) for errors
    // Errors auto-dismiss after 10s (was 0 = persist forever, causing toast pile-up)
    const dur = duration ?? (type === 'error' ? 10000 : 5000)
    toasts.value.push({ id, type, message, duration: dur })
    if (dur > 0) {
      setTimeout(() => dismiss(id), dur)
    }
  }

  function dismiss(id: number) {
    const idx = toasts.value.findIndex(t => t.id === id)
    if (idx !== -1) toasts.value.splice(idx, 1)
  }

  function success(message: string, duration?: number) { show(message, 'success', duration) }
  function error(message: string, duration?: number) { show(message, 'error', duration) }
  function warning(message: string, duration?: number) { show(message, 'warning', duration) }
  function info(message: string, duration?: number) { show(message, 'info', duration) }

  /**
   * Render an arbitrary error value (ApiError, Error, string, unknown) as a
   * sanitized error toast. Strips absolute paths / tokens / multi-line stacks
   * before display — use at every `catch(err)` boundary that surfaces an
   * error to the user.
   */
  function errorFromException(err: unknown, duration?: number) {
    show(sanitizeErrorMessage(err), 'error', duration)
  }

  return { toasts, show, dismiss, success, error, warning, info, errorFromException }
})
