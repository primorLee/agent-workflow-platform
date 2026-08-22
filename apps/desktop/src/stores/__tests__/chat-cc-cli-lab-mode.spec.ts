/**
 * ADR-014a Phase 1-4 Lab APP — chat store lab-mode behaviors.
 *
 * Covers the two lab-mode short-circuits added on top of the default
 * `_shouldRouteLocalCc` / `_sendViaLocalCc` paths:
 *
 *   1. `_shouldRouteLocalCc` returns true when `window.__AWP_LAB_MODE`
 *      `__CC_LOCAL_RUNTIME_AVAILABLE` (lab APP has no setup wizard / runtime
 *      installer / runtime toggle).
 *   2. `_sendViaLocalCc` does NOT fall back to HTTP in lab mode when cc_start
 *      refuses or the dispatch throws — there is no cloud auth in lab, so an
 *      HTTP fallback would just 401 and surface a confusing "logged out"
 *      toast. Surface a `streamErrorChunk` directly instead.
 *
 * Companion to `chat-cc-cli-feature-flag.spec.ts` (default runtime path).
 *
 * Mocks mirror the shape of that companion spec so future maintenance only
 * touches one set of stubs when chat store internals shift.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// ---- Shared mocks (mirrored from chat-cc-cli-feature-flag.spec.ts) -------

const streamCb: { onMessage: ((d: unknown) => void) | null; close: () => void } = {
  onMessage: null,
  close: vi.fn(),
}
const streamMessageCalls: Array<{
  model: string
  messages: unknown
  onMessage: (d: unknown) => void
}> = []

vi.mock('@/api/client', () => ({
  api: {
    getBaseUrl: vi.fn(() => 'https://api.example.com'),
    getToken: vi.fn(() => 'test-token'),
    post: vi.fn(),
  },
}))

vi.mock('@/api/endpoints/chat', () => ({
  getModels: vi.fn(async () => []),
  getHistory: vi.fn(async () => []),
  getConversation: vi.fn(async () => ({ messages: [], model: 'agent-fixture', updated_at: null })),
  streamMessage: vi.fn((
    model: string,
    messages: unknown,
    onMessage: (d: unknown) => void,
  ) => {
    streamCb.onMessage = onMessage
    streamMessageCalls.push({ model, messages, onMessage })
    return { close: streamCb.close }
  }),
  deleteConversation: vi.fn(async (id: string) => ({ deleted: true, conversation_id: id })),
}))

const toastCalls = {
  warning: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  show: vi.fn(),
}
vi.mock('@/stores/toast', () => ({
  useToastStore: () => toastCalls,
}))

const settingsState = {
  serverUrl: '',            // lab mode does NOT require this
}
vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => settingsState,
}))

vi.mock('@/i18n', () => {
  const tFn = (key: string) => key
  return { default: { global: { t: tFn } } }
})

// ---- Window helpers ------------------------------------------------------

interface CcEventCb {
  (payload: { sessionId: string; event: Record<string, unknown> }): void
}
interface CcExitCb {
  (payload: { sessionId: string; code: number | null; signal: string | null; error?: string }): void
}

function installElectronApi(overrides?: {
  cc_start?: ReturnType<typeof vi.fn>
  cc_send_message?: ReturnType<typeof vi.fn>
  omitCcStart?: boolean
}) {
  const streamCallbacks: CcEventCb[] = []
  const exitCallbacks: CcExitCb[] = []
  const api: Record<string, unknown> = {
    cc_send_message: overrides?.cc_send_message ?? vi.fn(async () => ({ ok: true })),
    cc_stop: vi.fn(async () => ({ ok: true })),
    cc_on_stream_event: vi.fn((cb: CcEventCb) => {
      streamCallbacks.push(cb)
      return () => {
        const i = streamCallbacks.indexOf(cb)
        if (i >= 0) streamCallbacks.splice(i, 1)
      }
    }),
    cc_on_session_exit: vi.fn((cb: CcExitCb) => {
      exitCallbacks.push(cb)
      return () => {
        const i = exitCallbacks.indexOf(cb)
        if (i >= 0) exitCallbacks.splice(i, 1)
      }
    }),
  }
  if (!overrides?.omitCcStart) {
    api.cc_start = overrides?.cc_start ?? vi.fn(async ({ conversationId }: { conversationId: string }) => ({
      ok: true,
      sessionId: `lab-sess-${conversationId || 'anon'}-${Math.floor(Math.random() * 1e6)}`,
    }))
  }
  ;(window as unknown as { electronAPI: typeof api }).electronAPI = api
  return { api }
}

function setLabMode(on: boolean): void {
  ;(window as unknown as { __AWP_LAB_MODE?: boolean }).__AWP_LAB_MODE = on
}

function clearWindow(): void {
  try { delete (window as unknown as Record<string, unknown>).electronAPI } catch { /* */ }
  try { delete (window as unknown as Record<string, unknown>).__AWP_LAB_MODE } catch { /* */ }
  try { delete (window as unknown as Record<string, unknown>).__CC_LOCAL_RUNTIME_AVAILABLE } catch { /* */ }
}

// ---- Tests ---------------------------------------------------------------

describe('chat store ADR-014a lab mode (AWP_LAB_MODE)', () => {
  beforeEach(() => {
    localStorage.clear()
    streamCb.onMessage = null
    streamMessageCalls.length = 0
    ;(streamCb.close as ReturnType<typeof vi.fn>).mockClear?.()
    toastCalls.warning.mockClear()
    toastCalls.error.mockClear()
    settingsState.serverUrl = ''   // lab default — no cloud server configured
  })

  afterEach(() => {
    clearWindow()
    vi.resetModules()
  })

  describe('_shouldRouteLocalCc lab short-circuit', () => {
    it('lab=true + electronAPI.cc_start exists → routes via local CC even when serverUrl is empty and runtime availability is not cached', async () => {
      const env = installElectronApi()
      setLabMode(true)
      // Default-path preconditions deliberately ALL false to prove they don't matter
      settingsState.serverUrl = ''
      ;(window as unknown as { __CC_LOCAL_RUNTIME_AVAILABLE?: boolean }).__CC_LOCAL_RUNTIME_AVAILABLE = false

      setActivePinia(createPinia())
      const { useChatStore } = await import('../chat')
      const chat = useChatStore()

      chat.sendMessage('lab hello')
      await new Promise(r => setTimeout(r, 10))

      expect(env.api.cc_start).toHaveBeenCalledTimes(1)
      expect(env.api.cc_send_message).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'lab hello' }),
      )
      // HTTP path must NOT be touched in lab mode
      expect(streamMessageCalls.length).toBe(0)
    })

    it('lab=true + electronAPI.cc_start MISSING → does not route to local (and does not crash)', async () => {
      installElectronApi({ omitCcStart: true })
      setLabMode(true)
      settingsState.serverUrl = ''

      setActivePinia(createPinia())
      const { useChatStore } = await import('../chat')
      const chat = useChatStore()

      // Should not throw — guard returns false when cc_start missing
      expect(() => chat.sendMessage('lab hello')).not.toThrow()
    })

    it('lab=false + runtime unavailable → HTTP path (default-path regression unchanged)', async () => {
      const env = installElectronApi()
      setLabMode(false)
      settingsState.serverUrl = 'https://api.example.com'

      setActivePinia(createPinia())
      const { useChatStore } = await import('../chat')
      const chat = useChatStore()

      chat.sendMessage('cloud hello')
      await new Promise(r => setTimeout(r, 10))

      expect(env.api.cc_start).not.toHaveBeenCalled()
      expect(streamMessageCalls.length).toBe(1)
    })
  })

  describe('_sendViaLocalCc lab no-fallback', () => {
    it('lab=true + cc_start returns ok:false → streamErrorChunk set, NO HTTP fallback', async () => {
      const env = installElectronApi({
        cc_start: vi.fn(async () => ({ ok: false, error: 'remote ssh down' })),
      })
      setLabMode(true)
      settingsState.serverUrl = ''  // no cloud configured

      setActivePinia(createPinia())
      const { useChatStore } = await import('../chat')
      const chat = useChatStore()

      chat.sendMessage('msg into broken ssh')
      await new Promise(r => setTimeout(r, 20))

      expect(env.api.cc_start).toHaveBeenCalledTimes(1)
      // Critically: HTTP path NOT entered (no streamMessage call queued)
      expect(streamMessageCalls.length).toBe(0)
      // streamErrorChunk should carry the lab-specific message
      expect(chat.error).toMatch(/lab cc_start failed/)
    })

    it('lab=true + cc_start throws → streamErrorChunk set, NO HTTP fallback', async () => {
      const env = installElectronApi({
        cc_start: vi.fn(async () => { throw new Error('ENOENT ssh.exe') }),
      })
      setLabMode(true)
      settingsState.serverUrl = ''

      setActivePinia(createPinia())
      const { useChatStore } = await import('../chat')
      const chat = useChatStore()

      chat.sendMessage('msg via missing ssh')
      await new Promise(r => setTimeout(r, 20))

      expect(env.api.cc_start).toHaveBeenCalledTimes(1)
      expect(streamMessageCalls.length).toBe(0)
      expect(chat.error).toMatch(/lab cc dispatch threw/)
    })

    it('lab=false + cc_start returns ok:false → falls back to HTTP (default-path behavior unchanged)', async () => {
      const env = installElectronApi({
        cc_start: vi.fn(async () => ({ ok: false, error: 'cc-runtime missing' })),
      })
      setLabMode(false)
      settingsState.serverUrl = 'https://api.example.com'
      ;(window as unknown as { __CC_LOCAL_RUNTIME_AVAILABLE?: boolean }).__CC_LOCAL_RUNTIME_AVAILABLE = true

      setActivePinia(createPinia())
      const { useChatStore } = await import('../chat')
      const chat = useChatStore()

      chat.sendMessage('cloud fallback hello')
      await new Promise(r => setTimeout(r, 20))

      expect(env.api.cc_start).toHaveBeenCalledTimes(1)
      // Default path: HTTP fallback DID fire
      expect(streamMessageCalls.length).toBe(1)
    })

    it('lab=true + cc_start ok → cc_send_message called, no HTTP, no error', async () => {
      const env = installElectronApi()
      setLabMode(true)

      setActivePinia(createPinia())
      const { useChatStore } = await import('../chat')
      const chat = useChatStore()

      chat.sendMessage('happy path')
      await new Promise(r => setTimeout(r, 10))

      expect(env.api.cc_start).toHaveBeenCalledTimes(1)
      expect(env.api.cc_send_message).toHaveBeenCalledTimes(1)
      expect(streamMessageCalls.length).toBe(0)
      expect(chat.error).toBeNull()
    })
  })
})
