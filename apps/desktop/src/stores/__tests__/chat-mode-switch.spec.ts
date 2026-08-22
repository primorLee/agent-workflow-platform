/**
 * ADR-012 Phase 2 (T-A021): renderer-side mode_switch + local CC tests.
 *
 * These cover the Cloud-to-Desktop handoff path in `stores/chat.ts`:
 *   - A `mode_switch` SSE chunk closes the Cloud SSE and calls `cc_start`.
 *   - A failed `cc_start` surfaces as `streamErrorChunk`.
 *   - `cc:stream-event` payloads with the current session id flow into
 *     `_ingestChunk` (verified by observing `streamingReply` updates).
 *   - `cc:session-exit` firing before a `done:true` chunk sets an error.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// ---- Mocks BEFORE the store import ---------------------------------------

const streamCb: { onMessage: ((d: unknown) => void) | null; close: () => void } = {
  onMessage: null,
  close: vi.fn(),
}

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
  streamMessage: vi.fn((_model: string, _messages: unknown, onMessage: (d: unknown) => void) => {
    streamCb.onMessage = onMessage
    return { close: streamCb.close }
  }),
  deleteConversation: vi.fn(async (id: string) => ({ deleted: true, conversation_id: id })),
}))

vi.mock('@/stores/toast', () => ({
  useToastStore: () => ({ error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn(), show: vi.fn() }),
}))
vi.mock('@/i18n', () => {
  const messages: Record<string, string> = {
    'chat.defaultThreadTitle': '新对话',
    'chat.welcomeMessage': 'welcome',
    'chat.conversation': '对话',
    'chat.unknownError': '未知错误',
  }
  const tFn = (key: string, params?: Record<string, unknown>) => {
    let msg = messages[key] || key
    if (params) for (const [k, v] of Object.entries(params)) msg = msg.replace(`{${k}}`, String(v))
    return msg
  }
  return { default: { global: { t: tFn } } }
})

// ---- Fake electronAPI ----------------------------------------------------

interface CcEventCb {
  (payload: { sessionId: string; event: Record<string, unknown> }): void
}
interface CcExitCb {
  (payload: { sessionId: string; code: number | null; signal: string | null; error?: string }): void
}

function installElectronApi(overrides?: Partial<{
  cc_start: ReturnType<typeof vi.fn>
  cc_send_message: ReturnType<typeof vi.fn>
  cc_stop: ReturnType<typeof vi.fn>
}>) {
  const streamCallbacks: CcEventCb[] = []
  const exitCallbacks: CcExitCb[] = []
  const api = {
    cc_start: overrides?.cc_start ?? vi.fn(async ({ conversationId }: { conversationId: string }) => ({
      ok: true,
      sessionId: `sess-${conversationId || 'anon'}-${Math.floor(Math.random() * 1e6)}`,
    })),
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
  ;(window as unknown as { electronAPI: typeof api }).electronAPI = api
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
  try { delete (window as unknown as Record<string, unknown>).electronAPI } catch { /* noop */ }
}

// ---- Tests --------------------------------------------------------------

describe('chat store mode_switch / local CC', () => {
  beforeEach(() => {
    localStorage.clear()
    streamCb.onMessage = null
    ;(streamCb.close as ReturnType<typeof vi.fn>).mockClear?.()
    // Fresh pinia AFTER installing electronAPI so the store picks up the
    // event subscription wiring.
  })

  afterEach(() => {
    clearElectronApi()
  })

  it('mode_switch_chunk_closes_sse_and_starts_local_cc', async () => {
    const env = installElectronApi()
    setActivePinia(createPinia())
    const { useChatStore } = await import('../chat')
    const chat = useChatStore()

    chat.sendMessage('hi')
    expect(streamCb.onMessage).toBeTruthy()

    // Server tells us to pivot to local CC.
    streamCb.onMessage!({
      type: 'mode_switch',
      target: 'local_cc',
      conversation_id: 'conv-42',
    })

    // SSE should have been closed.
    expect(streamCb.close).toHaveBeenCalled()
    expect(chat.currentConversationId).toBe('conv-42')

    // cc_start scheduled as a microtask — flush.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(env.api.cc_start).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-42' }),
    )
    await Promise.resolve(); await Promise.resolve()
    expect(env.api.cc_send_message).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'hi' }),
    )
  })

  it('cc_start_failure_sets_stream_error', async () => {
    const failingStart = vi.fn(async () => ({ ok: false, error: 'spawn_failed' }))
    installElectronApi({ cc_start: failingStart })
    setActivePinia(createPinia())
    const { useChatStore } = await import('../chat')
    const chat = useChatStore()

    chat.sendMessage('hi')
    streamCb.onMessage!({ type: 'mode_switch', target: 'local_cc' })

    // Wait for the async cc_start promise to reject into our error path.
    await new Promise((r) => setTimeout(r, 10))

    expect(failingStart).toHaveBeenCalled()
    expect(chat.streamErrorChunk).not.toBeNull()
    expect(chat.streamErrorChunk!.message).toMatch(/cc_start_failed/)
    expect(chat.isStreaming).toBe(false)
  })

  it('cc_stream_event_routes_to_ingest_chunk_with_matching_session', async () => {
    const fixedSessionId = 'sess-fixed-1'
    const env = installElectronApi({
      cc_start: vi.fn(async () => ({ ok: true, sessionId: fixedSessionId })),
    })
    setActivePinia(createPinia())
    const { useChatStore } = await import('../chat')
    const chat = useChatStore()

    chat.sendMessage('hello')
    streamCb.onMessage!({ type: 'mode_switch', target: 'local_cc' })
    await new Promise((r) => setTimeout(r, 10))

    // Matching session → should reach the switchboard.
    env.emitStream({ sessionId: fixedSessionId, event: { delta: 'Hi there' } })
    expect(chat.streamingReply).toBe('Hi there')

    // Mismatched session → ignored.
    env.emitStream({ sessionId: 'other-sess', event: { delta: ' IGNORED' } })
    expect(chat.streamingReply).toBe('Hi there')
  })

  it('cc_session_exit_before_done_emits_error', async () => {
    const fixedSessionId = 'sess-dies-1'
    const env = installElectronApi({
      cc_start: vi.fn(async () => ({ ok: true, sessionId: fixedSessionId })),
    })
    setActivePinia(createPinia())
    const { useChatStore } = await import('../chat')
    const chat = useChatStore()

    chat.sendMessage('hello')
    streamCb.onMessage!({ type: 'mode_switch', target: 'local_cc' })
    await new Promise((r) => setTimeout(r, 10))

    // Subprocess dies with no prior `done:true` chunk.
    env.emitExit({ sessionId: fixedSessionId, code: 137, signal: null, error: 'SIGKILL' })

    expect(chat.streamErrorChunk).not.toBeNull()
    expect(chat.streamErrorChunk!.message).toMatch(/cc_session_exit_before_done/)
    expect(chat.isStreaming).toBe(false)
  })
})
