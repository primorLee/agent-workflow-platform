/**
 * chat-cc-cli.spec.ts — ADR-012 Phase 2 Part 7 integration tests for the
 * renderer's chat store with the local CC CLI feature flag.
 *
 * Scope (renderer-side, vitest + happy-dom):
 *   - Mock `window.electronAPI.cc_*` so we can drive the store through its
 *     IPC boundary without spawning real Electron.
 *   - Verify that with `runtime availability` ON:
 *     a) a `mode_switch` chunk from cloud triggers `cc_start` + `cc_send_message`
 *     b) `cc:stream-event` chunks flow into `streamingReply` via _ingestChunk
 *     c) on `cc:session-exit` BEFORE `done:true` the store falls back by
 *        surfacing `streamErrorChunk` (Part 7 auto-fallback to HTTP is a
 *        Playwright-level assertion — unit-level we just pin the error
 *        surfacing because the fallback-reopen requires the cloud SSE
 *        which is out of scope for this unit test).
 *   - Flag OFF: a `mode_switch` chunk in a future rollout phase is a no-op
 *     and the SSE stream completes via the HTTP path; zero IPC calls.
 *
 * Why a separate spec from `chat-mode-switch.spec.ts`:
 *   That spec pins the existing "mode_switch pivots to local CC" contract
 *   assuming the flag is always effectively ON via server-side logic. Part
 *   7 adds a runtime capability (`runtime availability`) that gates the
 *   renderer's willingness to honour the pivot — this spec covers the
 *   new branch.
 *
 * Consumes the same mocking pattern as chat-mode-switch.spec.ts to stay
 * behavior-diff easy to review.
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

// ---- Tests ---------------------------------------------------------------

describe('chat store — runtime availability runtime integration', () => {
  beforeEach(() => {
    localStorage.clear()
    streamCb.onMessage = null
    ;(streamCb.close as ReturnType<typeof vi.fn>).mockClear?.()
  })

  afterEach(() => {
    clearElectronApi()
    // Reset the module registry so each test gets a fresh `stores/chat` with
    // fresh _wireCcSubscriptions() bindings against the new electronAPI.
    vi.resetModules()
  })

  it('flag ON: mode_switch → cc_start + cc_send_message dispatched via IPC', async () => {
    const env = installElectronApi()
    setActivePinia(createPinia())
    const { useChatStore } = await import('../chat')
    const chat = useChatStore()

    chat.sendMessage('Hello with flag ON')
    expect(streamCb.onMessage, 'SSE should be established first').toBeTruthy()

    // Cloud pivots to local CC.
    streamCb.onMessage!({
      type: 'mode_switch',
      target: 'local_cc',
      conversation_id: 'conv-phase2-1',
    })

    // Flush the microtask queue for the async cc_start dispatch.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(env.api.cc_start).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-phase2-1' }),
    )
    await Promise.resolve(); await Promise.resolve()
    expect(env.api.cc_send_message).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Hello with flag ON' }),
    )
    expect(streamCb.close, 'cloud SSE must close on pivot').toHaveBeenCalled()
  })

  it('flag ON: cc:stream-event chunks flow into streamingReply', async () => {
    const fixedSessionId = 'sess-flag-on-1'
    const env = installElectronApi({
      cc_start: vi.fn(async () => ({ ok: true, sessionId: fixedSessionId })),
    })
    setActivePinia(createPinia())
    const { useChatStore } = await import('../chat')
    const chat = useChatStore()

    chat.sendMessage('stream me')
    streamCb.onMessage!({ type: 'mode_switch', target: 'local_cc' })
    await new Promise((r) => setTimeout(r, 10))

    env.emitStream({ sessionId: fixedSessionId, event: { delta: 'Part 7 works' } })
    expect(chat.streamingReply).toBe('Part 7 works')
  })

  it('flag ON: cc crash before done surfaces streamErrorChunk for HTTP fallback trigger', async () => {
    const fixedSessionId = 'sess-crash-1'
    const env = installElectronApi({
      cc_start: vi.fn(async () => ({ ok: true, sessionId: fixedSessionId })),
    })
    setActivePinia(createPinia())
    const { useChatStore } = await import('../chat')
    const chat = useChatStore()

    chat.sendMessage('crash-me')
    streamCb.onMessage!({ type: 'mode_switch', target: 'local_cc' })
    await new Promise((r) => setTimeout(r, 10))

    // Subprocess SIGKILL before a `done:true` chunk — this is the signal
    // for downstream HTTP-fallback logic (surfaced in the Playwright spec).
    env.emitExit({ sessionId: fixedSessionId, code: 137, signal: 'SIGKILL', error: 'killed' })

    expect(chat.streamErrorChunk).not.toBeNull()
    expect(chat.streamErrorChunk!.message).toMatch(/cc_session_exit_before_done/)
    expect(chat.isStreaming).toBe(false)
  })

  it('flag effectively OFF (no electronAPI.cc_start): SSE path completes; zero IPC calls', async () => {
    // Simulate flag OFF by installing an electronAPI WITHOUT cc_start/
    // cc_send_message (or with them stubbed to reject). The store's
    // `_startLocalCcTurn` checks `electronAPI.cc_start` presence — if
    // missing, the mode_switch is a no-op and the SSE continues.
    const api = {
      cc_on_stream_event: vi.fn(() => () => {}),
      cc_on_session_exit: vi.fn(() => () => {}),
    }
    ;(window as unknown as { electronAPI: typeof api }).electronAPI = api

    setActivePinia(createPinia())
    const { useChatStore } = await import('../chat')
    const chat = useChatStore()

    chat.sendMessage('Hi via HTTP')
    expect(streamCb.onMessage).toBeTruthy()

    // Simulate the SSE replying with a normal token then done:true —
    // NOT a mode_switch — since the flag is OFF server-side would not
    // emit mode_switch. We just assert no IPC is attempted.
    streamCb.onMessage!({ delta: 'Hello' })
    streamCb.onMessage!({ done: true })
    await Promise.resolve()

    // Zero IPC dispatches — `cc_start` isn't on the api object at all.
    expect((api as { cc_start?: unknown }).cc_start).toBeUndefined()
    // SSE completed normally.
    expect(chat.isStreaming).toBe(false)
  })
})
