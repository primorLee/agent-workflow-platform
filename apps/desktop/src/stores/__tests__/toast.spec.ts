import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useToastStore } from '../toast'

// sanitizeErrorMessage is used by errorFromException; stub it so we control output.
vi.mock('@/utils/sanitize', () => ({
  sanitizeErrorMessage: (err: unknown, fallback?: string) => {
    if (typeof err === 'string') return err
    if (err instanceof Error) return err.message
    return fallback ?? 'unknown error'
  },
}))

describe('useToastStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('initial state: empty toasts array', () => {
    const toast = useToastStore()
    expect(toast.toasts).toEqual([])
  })

  it('show() adds an info toast with default 5s duration', () => {
    const toast = useToastStore()
    toast.show('hello')
    expect(toast.toasts).toHaveLength(1)
    expect(toast.toasts[0]).toMatchObject({ type: 'info', message: 'hello', duration: 5000 })
  })

  it('show() auto-dismisses non-zero duration toasts after duration', () => {
    const toast = useToastStore()
    toast.show('bye', 'info')
    expect(toast.toasts).toHaveLength(1)
    vi.advanceTimersByTime(5000)
    expect(toast.toasts).toHaveLength(0)
  })

  it('dedup: identical active toast is skipped', () => {
    const toast = useToastStore()
    toast.show('same', 'info')
    toast.show('same', 'info')
    expect(toast.toasts).toHaveLength(1)
  })

  it('error toasts default to 10s duration (not persistent)', () => {
    const toast = useToastStore()
    toast.error('oops')
    expect(toast.toasts[0]!.duration).toBe(10000)
    // custom duration override also works
    toast.error('oops2', 2000)
    expect(toast.toasts[1]!.duration).toBe(2000)
  })

  it('error throttle: identical error within 5s window is suppressed', () => {
    const toast = useToastStore()
    toast.error('network fail')
    expect(toast.toasts).toHaveLength(1)

    // Dismiss first so dedup does not apply — throttle alone must suppress.
    toast.dismiss(toast.toasts[0]!.id)
    expect(toast.toasts).toHaveLength(0)

    toast.error('network fail')
    // Throttled: should NOT be added even though dedup allows it.
    expect(toast.toasts).toHaveLength(0)
  })

  it('dismiss() removes a toast by id; unknown id is a no-op', () => {
    const toast = useToastStore()
    toast.show('a', 'info')
    toast.show('b', 'info')
    const firstId = toast.toasts[0]!.id
    toast.dismiss(firstId)
    expect(toast.toasts).toHaveLength(1)
    expect(toast.toasts[0]!.message).toBe('b')
    // unknown id: nothing changes, no throw
    toast.dismiss(9999)
    expect(toast.toasts).toHaveLength(1)
  })

  it('success/warning/info helpers produce correct types', () => {
    const toast = useToastStore()
    toast.success('s')
    toast.warning('w')
    toast.info('i')
    expect(toast.toasts.map(t => t.type)).toEqual(['success', 'warning', 'info'])
  })

  it('errorFromException pipes unknown err through sanitize', () => {
    const toast = useToastStore()
    toast.errorFromException(new Error('raw: /abs/path secret=abc'))
    expect(toast.toasts).toHaveLength(1)
    expect(toast.toasts[0]!.type).toBe('error')
    expect(toast.toasts[0]!.message).toBe('raw: /abs/path secret=abc')
  })
})
