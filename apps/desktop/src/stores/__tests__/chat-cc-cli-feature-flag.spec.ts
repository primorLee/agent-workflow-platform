/**
 * ADR-012 Phase 2 Part 5: feature-flag-gated local CC routing.
 *
 * These tests cover the runtime-availability path `runtime availability` that
 * routes `sendMessage` directly through `window.electronAPI.cc_start` +
 * `cc_send_message` instead of the Cloud `/v1/chat/completions` SSE path.
 *
 * Complements `chat-mode-switch.spec.ts` (server-directed handoff) and
 * `chat-mode-switch-ipc-integration.spec.ts` (real subprocess end-to-end).
 *
 * Matrix covered:
 *   - Flag OFF (default)                    → HTTP path (Phase 1 regression)
 *   - Flag ON  + runtime available          → IPC path, onChunk flows
 *   - Flag ON  + runtime missing            → HTTP path fallback
 *   - Flag ON  + IPC path crashes mid-turn  → auto-retry via HTTP
 *   - Flag ON  + cc_start refuses (ok:false)→ immediate HTTP fallback
 *   - Stale cc:stream-event for unknown session → logged & dropped (no throw)
 *
 * Note: we stub `window.electronAPI` the same way `chat-mode-switch.spec.ts`
 * does — the IPC boundary itself is covered by the dedicated integration
 * spec. The feature-flag gate is a pure renderer-store decision.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// ---- Shared mocks (mirrors chat-mode-switch.spec.ts) --------------------

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
  getConversation: vi.fn(async () => ({ messages: [], model: '', updated_at: null })),
  // 2026-06-10 fix: chat store persists turns via appendMessage now; vitest
  // throws on missing mock exports (see chat-mode-switch spec).
  appendMessage: vi.fn(async () => ({ ok: true })),
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

// The feature flag lives in the settings store; mock it so tests can flip
const settingsState = {
  serverUrl: 'https://api.example.com',
}
vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => settingsState,
}))

vi.mock('@/i18n', () => {
  const messages: Record<string, string> = {
    'chat.defaultThreadTitle': '新对话',
    'chat.welcomeMessage': 'welcome',
    'chat.conversation': '对话',
    'chat.unknownError': '未知错误',
    'chat.ccFellBackToAdapter': '本地引擎异常，已切换到聊天适配器',
  }
  const tFn = (key: string, params?: Record<string, unknown>) => {
    let msg = messages[key] || key
    if (params) for (const [k, v] of Object.entries(params)) msg = msg.replace(`{${k}}`, String(v))
    return msg
  }
  return { default: { global: { t: tFn } } }
})

// ---- Fake electronAPI installer ----------------------------------------

interface CcEventCb {
  (payload: { sessionId: string; event: Record<string, unknown> }): void
}
interface CcExitCb {
  (payload: { sessionId: string; code: number | null; signal: string | null; error?: string }): void
}

function installElectronApi(overrides?: {
  cc_start?: ReturnType<typeof vi.fn>
  cc_send_message?: ReturnType<typeof vi.fn>
  cc_stop?: ReturnType<typeof vi.fn>
  runtimeAvailable?: boolean
  omitCcStart?: boolean
}) {
  const streamCallbacks: CcEventCb[] = []
  const exitCallbacks: CcExitCb[] = []
  const api: Record<string, unknown> = {
    cc_send_message: overrides?.cc_send_message ?? vi.fn(async () => ({ ok: true })),
    cc_stop: overrides?.cc_stop ?? vi.fn(async () => ({ ok: true })),
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
      sessionId: `sess-${conversationId || 'anon'}-${Math.floor(Math.random() * 1e6)}`,
    }))
  }
  ;(window as unknown as { electronAPI: typeof api }).electronAPI = api
  ;(window as unknown as { __CC_LOCAL_RUNTIME_AVAILABLE?: boolean })
    .__CC_LOCAL_RUNTIME_AVAILABLE = overrides?.runtimeAvailable ?? true
  return {
    api,
    emitStream: (p: { sessionId: string; event: Record<string, unknown> }) => {
      for (const cb of streamCallbacks) cb(p)
    },
    emitExit: (p: Parameters<CcExitCb>[0]) => {
      for (const cb of exitCallbacks) cb(p)
    },
  }
}

function clearElectronApi() {
  try { delete (window as unknown as Record<string, unknown>).electronAPI } catch { /* */ }
  try { delete (window as unknown as Record<string, unknown>).__CC_LOCAL_RUNTIME_AVAILABLE } catch { /* */ }
}

// ---- Tests --------------------------------------------------------------

describe('chat store Agent CLI runtime routing (ADR-012 Phase 2 Part 5)', () => {
  beforeEach(() => {
    localStorage.clear()
    streamCb.onMessage = null
    streamMessageCalls.length = 0
    ;(streamCb.close as ReturnType<typeof vi.fn>).mockClear?.()
    toastCalls.warning.mockClear()
    // Reset shared settings state between tests.
    settingsState.serverUrl = 'https://api.example.com'
  })

  afterEach(() => {
    clearElectronApi()
    vi.resetModules()
  })

  // 2026-06-10 fix: this test originally pinned "flag OFF → HTTP" — behavior
  // users upgrading from 1.7.1 had a persisted `false` that silently kept
  // them on the cloud-sandbox path (300 MB/chat). Local CC is now the
  // canonical transport whenever the IPC surface + runtime exist. The
  // valuable inverse lock: a stale persisted `false` must NOT force HTTP.
  it('runtime availability routes to the local Agent CLI → local CC path still used (ADR-016)', async () => {
    const env = installElectronApi()
    setActivePinia(createPinia())
    const { useChatStore } = await import('../chat')
    const chat = useChatStore()

    chat.sendMessage('hello via local cc')
    // Allow the async _sendViaLocalCc chain to run.
    await new Promise(r => setTimeout(r, 10))

    expect(streamMessageCalls.length).toBe(0)
    expect(env.api.cc_start).toHaveBeenCalled()
    expect(chat.isStreaming).toBe(true)
  })

  it('flag ON + runtime available → IPC path, cc_start + cc_send_message invoked', async () => {
    const env = installElectronApi({ runtimeAvailable: true })
    setActivePinia(createPinia())
    const { useChatStore } = await import('../chat')
    const chat = useChatStore()

    chat.sendMessage('hello local')
    // Allow the async _sendViaLocalCc chain to run.
    await new Promise(r => setTimeout(r, 10))

    expect(env.api.cc_start).toHaveBeenCalledWith(
      expect.objectContaining({ model: '' }),
    )
    expect(env.api.cc_send_message).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'hello local' }),
    )
    // HTTP path must NOT have been touched.
    expect(streamMessageCalls.length).toBe(0)
  })

  it('flag ON + IPC chunks arrive → streamingReply populated (same switchboard)', async () => {
    const fixedSessionId = 'sess-flag-on-1'
    const env = installElectronApi({
      runtimeAvailable: true,
      cc_start: vi.fn(async () => ({ ok: true, sessionId: fixedSessionId })),
    })
    setActivePinia(createPinia())
    const { useChatStore } = await import('../chat')
    const chat = useChatStore()

    chat.sendMessage('stream me')
    await new Promise(r => setTimeout(r, 10))

    env.emitStream({ sessionId: fixedSessionId, event: { delta: 'Hi via IPC' } })
    expect(chat.streamingReply).toBe('Hi via IPC')

    // done:true commits the assistant bubble.
    env.emitStream({ sessionId: fixedSessionId, event: { done: true } })
    const last = chat.currentMessages[chat.currentMessages.length - 1]
    expect(last!.role).toBe('assistant')
    expect(last!.content).toBe('Hi via IPC')
    expect(chat.isStreaming).toBe(false)
  })

  it('flag ON + runtime UNAVAILABLE → HTTP path fallback, never touches IPC', async () => {
    const env = installElectronApi({ runtimeAvailable: false })
    setActivePinia(createPinia())
    const { useChatStore } = await import('../chat')
    const chat = useChatStore()

    chat.sendMessage('runtime missing, cloud please')

    expect(streamMessageCalls.length).toBe(1)
    expect(env.api.cc_start).not.toHaveBeenCalled()
    expect(chat.isStreaming).toBe(true)
  })

  it('flag ON + electronAPI missing → HTTP path fallback (browser/pywebview build)', async () => {
    // No electronAPI installed at all — mimics pywebview / browser build.
    setActivePinia(createPinia())
    const { useChatStore } = await import('../chat')
    const chat = useChatStore()

    chat.sendMessage('no bridge')

    expect(streamMessageCalls.length).toBe(1)
    expect(chat.isStreaming).toBe(true)
  })

  it('flag ON + cc_start refuses → immediate HTTP fallback, user never notices', async () => {
    const env = installElectronApi({
      runtimeAvailable: true,
      cc_start: vi.fn(async () => ({ ok: false, error: 'enoent' })),
    })
    setActivePinia(createPinia())
    const { useChatStore } = await import('../chat')
    const chat = useChatStore()

    chat.sendMessage('cc_start will refuse')
    await new Promise(r => setTimeout(r, 10))

    expect(env.api.cc_start).toHaveBeenCalledTimes(1)
    // cc_send_message must NOT be called when cc_start refuses.
    expect(env.api.cc_send_message).not.toHaveBeenCalled()
    // HTTP fallback took over the turn.
    expect(streamMessageCalls.length).toBe(1)
    expect(chat.isStreaming).toBe(true)
    // No error bubble for this case — user just sees cloud reply a moment later.
    expect(chat.streamErrorChunk).toBeNull()
  })

  it('flag ON + CC CLI crashes mid-stream → auto-retry via HTTP, warning toast', async () => {
    const fixedSessionId = 'sess-crash-1'
    const env = installElectronApi({
      runtimeAvailable: true,
      cc_start: vi.fn(async () => ({ ok: true, sessionId: fixedSessionId })),
    })
    setActivePinia(createPinia())
    const { useChatStore } = await import('../chat')
    const chat = useChatStore()

    chat.sendMessage('this will crash')
    await new Promise(r => setTimeout(r, 10))
    expect(env.api.cc_start).toHaveBeenCalled()

    // Subprocess dies mid-turn, no prior done:true.
    env.emitExit({ sessionId: fixedSessionId, code: 137, signal: null, error: 'SIGKILL' })

    // HTTP fallback must kick in exactly once.
    expect(streamMessageCalls.length).toBe(1)
    expect(toastCalls.warning).toHaveBeenCalledWith('本地引擎异常，已切换到聊天适配器')
    expect(chat.isStreaming).toBe(true)  // HTTP stream now in flight

    // Cloud then streams a normal reply.
    streamMessageCalls[0]!.onMessage({ delta: 'Cloud-side reply' })
    streamMessageCalls[0]!.onMessage({ done: true })

    expect(chat.isStreaming).toBe(false)
    const last = chat.currentMessages[chat.currentMessages.length - 1]
    expect(last!.content).toContain('Cloud-side reply')
    // User message should appear only ONCE (idempotency).
    const userMsgs = chat.currentMessages.filter(m => m.role === 'user')
    expect(userMsgs.length).toBe(1)
    expect(userMsgs[0]!.content).toBe('this will crash')
  })

  it('flag ON + two crashes in one turn → only one retry (prevents infinite loop)', async () => {
    const fixedSessionId = 'sess-crash-2'
    const env = installElectronApi({
      runtimeAvailable: true,
      cc_start: vi.fn(async () => ({ ok: true, sessionId: fixedSessionId })),
    })
    setActivePinia(createPinia())
    const { useChatStore } = await import('../chat')
    const chat = useChatStore()

    chat.sendMessage('double crash test')
    await new Promise(r => setTimeout(r, 10))

    // First crash — HTTP fallback kicks in.
    env.emitExit({ sessionId: fixedSessionId, code: 137, signal: null })
    expect(streamMessageCalls.length).toBe(1)
    expect(toastCalls.warning).toHaveBeenCalledTimes(1)

    // A stale second exit event (shouldn't happen in practice but tests
    // the guard) — must NOT trigger a second HTTP call.
    env.emitExit({ sessionId: fixedSessionId, code: 1, signal: null })
    // streamMessageCalls.length is still 1 because _ccSessionId is already
    // cleared, so the second exit is dropped at the session-mismatch guard.
    expect(streamMessageCalls.length).toBe(1)
  })

  it('stale cc:stream-event for unknown session → logged & dropped, no crash', async () => {
    const env = installElectronApi({ runtimeAvailable: true })
    setActivePinia(createPinia())
    const { useChatStore } = await import('../chat')
    const chat = useChatStore()

    // No active session — still, a stale IPC event should be dropped,
    // not throw.
    expect(() => {
      env.emitStream({ sessionId: 'phantom-1', event: { delta: 'ghost' } })
    }).not.toThrow()
    expect(chat.streamingReply).toBe('')
  })
})
