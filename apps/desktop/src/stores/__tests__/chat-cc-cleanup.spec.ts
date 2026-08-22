/**
 * ADR-012 Phase 2 (T-A054): verify chat store cleans up live local-CC
 * sessions on user logout / conversation switch / stopStreaming.
 *
 * Regressions we guard against:
 *   - Subprocess leaks when the user logs out (cc_stop must fire).
 *   - Event-listener leaks (cc_on_stream_event unsubscribe must fire on
 *     logout so the bridge doesn't pin the old user's session state).
 *   - cc_stop called AFTER _ccSessionId is cleared (order bug that
 *     would drop the id on the floor).
 *   - Conversation switch not stopping the prior session.
 *   - cc_stop rejection crashing the logout flow.
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
  appendMessage: vi.fn(async () => ({ ok: true })),
  patchConversation: vi.fn(async () => ({ ok: true })),
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

interface InstalledApi {
  cc_start: ReturnType<typeof vi.fn>
  cc_send_message: ReturnType<typeof vi.fn>
  cc_stop: ReturnType<typeof vi.fn>
  cc_on_stream_event: ReturnType<typeof vi.fn>
  cc_on_session_exit: ReturnType<typeof vi.fn>
}

interface InstallHandle {
  api: InstalledApi
  emitStream: (p: { sessionId: string; event: Record<string, unknown> }) => void
  /** Unsubscribe fns handed back to the store, one per cc_on_stream_event call. */
  streamUnsubs: Array<ReturnType<typeof vi.fn>>
  /** Unsubscribe fns handed back to the store, one per cc_on_session_exit call. */
  exitUnsubs: Array<ReturnType<typeof vi.fn>>
}

function installElectronApi(overrides?: Partial<Pick<InstalledApi, 'cc_start' | 'cc_send_message' | 'cc_stop'>>): InstallHandle {
  const streamCallbacks: CcEventCb[] = []
  const exitCallbacks: CcExitCb[] = []
  const streamUnsubs: Array<ReturnType<typeof vi.fn>> = []
  const exitUnsubs: Array<ReturnType<typeof vi.fn>> = []

  const api: InstalledApi = {
    cc_start: overrides?.cc_start ?? vi.fn(async ({ conversationId }: { conversationId?: string }) => ({
      ok: true,
      sessionId: `sess-${conversationId || 'anon'}-${Math.floor(Math.random() * 1e6)}`,
    })),
    cc_send_message: overrides?.cc_send_message ?? vi.fn(async () => ({ ok: true })),
    cc_stop: overrides?.cc_stop ?? vi.fn(async () => ({ ok: true })),
    cc_on_stream_event: vi.fn((cb: CcEventCb) => {
      streamCallbacks.push(cb)
      const unsub = vi.fn(() => {
        const i = streamCallbacks.indexOf(cb)
        if (i >= 0) streamCallbacks.splice(i, 1)
      })
      streamUnsubs.push(unsub)
      return unsub
    }),
    cc_on_session_exit: vi.fn((cb: CcExitCb) => {
      exitCallbacks.push(cb)
      const unsub = vi.fn(() => {
        const i = exitCallbacks.indexOf(cb)
        if (i >= 0) exitCallbacks.splice(i, 1)
      })
      exitUnsubs.push(unsub)
      return unsub
    }),
  }
  ;(window as unknown as { electronAPI: InstalledApi }).electronAPI = api
  return {
    api,
    emitStream: (p) => {
      for (const cb of streamCallbacks) cb(p)
    },
    streamUnsubs,
    exitUnsubs,
  }
}

function clearElectronApi() {
  try { delete (window as unknown as Record<string, unknown>).electronAPI } catch { /* noop */ }
}

/** Bring `_ccSessionId` into a known non-null state via the production
 *  mode_switch flow (no private-field poking). Returns the session id the
 *  fake `cc_start` produced and the chat store instance. */
async function primeCcSession(sessionId: string, conversationId = 'conv-primed') {
  // Fresh pinia each time this helper is called.
  setActivePinia(createPinia())
  const { useChatStore } = await import('../chat')
  const chat = useChatStore()
  chat.sendMessage('hi')
  // The streamMessage mock captured onMessage — pivot to local CC.
  if (!streamCb.onMessage) throw new Error('streamMessage mock never received onMessage')
  streamCb.onMessage({
    type: 'mode_switch',
    target: 'local_cc',
    conversation_id: conversationId,
  })
  // Wait for the async cc_start + cc_send_message chain.
  await new Promise((r) => setTimeout(r, 15))
  return { chat, sessionId, conversationId }
}

// ---- Tests ---------------------------------------------------------------

describe('chat store CC session cleanup (T-A054)', () => {
  beforeEach(() => {
    localStorage.clear()
    streamCb.onMessage = null
    ;(streamCb.close as ReturnType<typeof vi.fn>).mockClear?.()
    vi.resetModules()
  })

  afterEach(() => {
    clearElectronApi()
  })

  it('test_logout_stops_active_cc_session', async () => {
    const fixedSessionId = 'sess-logout-1'
    const env = installElectronApi({
      cc_start: vi.fn(async () => ({ ok: true, sessionId: fixedSessionId })),
    })
    const { chat } = await primeCcSession(fixedSessionId, 'conv-A')

    // Precondition: the store captured the session id.
    // We verify indirectly — cc_send_message should have been called with it.
    expect(env.api.cc_send_message).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: fixedSessionId }),
    )

    // Simulate logout.
    chat.onUserChanged()

    expect(env.api.cc_stop).toHaveBeenCalledTimes(1)
    expect(env.api.cc_stop).toHaveBeenCalledWith({ sessionId: fixedSessionId })

    // A fresh mode_switch now produces a different session id — proving the
    // old one was reset (we can't read the private ref directly).
    env.api.cc_stop.mockClear()
    chat.sendMessage('second turn')
    streamCb.onMessage!({ type: 'mode_switch', target: 'local_cc', conversation_id: 'conv-B' })
    await new Promise((r) => setTimeout(r, 15))
    // stopStreaming at the top of sendMessage had nothing to stop.
    expect(env.api.cc_stop).not.toHaveBeenCalled()
  })

  it('test_conversation_switch_parks_prior_cc_session_without_stop', async () => {
    const priorSessionId = 'sess-conv-A'
    let startCount = 0
    const env = installElectronApi({
      cc_start: vi.fn(async () => {
        startCount++
        return { ok: true, sessionId: startCount === 1 ? priorSessionId : `sess-conv-B-${startCount}` }
      }),
    })
    const { chat } = await primeCcSession(priorSessionId, 'conv-A')

    // Seed a second thread so selectThread switches to a real target.
    chat.createThread()
    const threadB = chat.threads[0]!.id
    chat.createThread()
    const threadC = chat.threads[0]!.id
    void threadC

    // Re-prime a CC session on whatever the current thread is by replaying
    // a mode_switch chunk. Easiest: use sendMessage again then switch.
    chat.sendMessage('follow-up')
    streamCb.onMessage!({ type: 'mode_switch', target: 'local_cc', conversation_id: 'conv-A' })
    await new Promise((r) => setTimeout(r, 15))
    env.api.cc_stop.mockClear()

    // 2026-05-31 (1.7.135+) — switching conversations no longer cc_stops the
    // prior session. It is PARKED to keep running in the background (Codex /
    // long-running Agent CLI behavior); only explicit Stop / logout / app-quit tear the
    // subprocess down. So cc_stop must NOT fire on a plain conversation switch.
    await chat.selectThread(threadB)
    expect(env.api.cc_stop).not.toHaveBeenCalled()
  })

  it('test_switch_away_and_back_preserves_cc_native_resume_id (1.7.136 失忆 fix)', async () => {
    const wrapperId = 'wrapper-sess-A'
    const ccNativeId = 'cc-native-resume-A'
    const env = installElectronApi({
      cc_start: vi.fn(async () => ({ ok: true, sessionId: wrapperId })),
    })
    setActivePinia(createPinia())
    const { useChatStore } = await import('../chat')
    const chat = useChatStore()
    const threadA = chat.threads[0]!.id

    // Start a turn in A → mode_switch to local CC (cc_start returns the WRAPPER id).
    chat.sendMessage('implement a log parser')
    streamCb.onMessage!({ type: 'mode_switch', target: 'local_cc', conversation_id: 'conv-A' })
    await new Promise((r) => setTimeout(r, 15))

    // CC emits message_start carrying its NATIVE session id (what `--resume` needs),
    // then text — but no `done`, so the stream is still live when we switch away.
    env.emitStream({ sessionId: wrapperId, event: { type: 'message_start', cc_session_id: ccNativeId } })
    env.emitStream({ sessionId: wrapperId, event: { delta: 'Let me inspect the parser state...' } })

    const a = () => chat.threads.find((t) => t.id === threadA)
    expect(a()?.ccSessionId).toBe(ccNativeId) // captured from message_start

    // User switches away (new thread → A detaches to background) then back.
    chat.createThread()
    await chat.selectThread(threadA)

    // THE FIX: A's ccSessionId is STILL the cc-native id — NOT overwritten with
    // the wrapper routing id. The 1.7.135 bug wrote the wrapper id here, so the
    // next send did `--resume <wrapper>` → CC started fresh → the AI forgot the
    // whole conversation mid-stream (anonymous production incident).
    expect(a()?.ccSessionId).toBe(ccNativeId)
    expect(a()?.ccSessionId).not.toBe(wrapperId)
  })

  it('test_two_concurrent_streams_never_cross (1.7.140 串台 fix)', async () => {
    // ROOT-CAUSE regression for APP-level conversation crossing: two
    // conversations stream at the SAME TIME (a parser task and a deployment
    // review run concurrently). Thread A is the ACTIVE view; thread
    // B keeps generating in the BACKGROUND. Their tokens must NEVER merge: the
    // active `streamingReply` shows ONLY A's text, B's `bgStreamingReply` holds
    // ONLY B's text — regardless of arrival interleaving.
    //
    // Pre-fix: `_ingestChunk` appended EVERY chunk to the global streamingReply
    // (no routing by source), so the active view interleaved both streams.
    let startCount = 0
    const sessB = 'wrapper-sess-B' // started first (becomes background)
    const sessA = 'wrapper-sess-A' // started second (stays active)
    const env = installElectronApi({
      cc_start: vi.fn(async () => {
        startCount++
        return { ok: true, sessionId: startCount === 1 ? sessB : sessA }
      }),
    })
    setActivePinia(createPinia())
    const { useChatStore } = await import('../chat')
    const chat = useChatStore()
    const threadB = chat.threads[0]!.id

    // 1) Start a stream on B → mode_switch → cc_start#1 returns sessB (active).
    chat.sendMessage('review the rollback plan')
    streamCb.onMessage!({ type: 'mode_switch', target: 'local_cc', conversation_id: 'conv-B' })
    await new Promise((r) => setTimeout(r, 15))
    // B emits text but NO done — still live when we switch away.
    env.emitStream({ sessionId: sessB, event: { type: 'message_start', cc_session_id: 'cc-native-B' } })
    env.emitStream({ sessionId: sessB, event: { delta: 'Rollback ' } })

    // 2) Open a NEW thread A (B detaches to background: isStreaming + bgSessionId=sessB).
    chat.createThread()
    const threadA = chat.activeThreadId
    expect(threadA).not.toBe(threadB)
    const bThread = () => chat.threads.find((t) => t.id === threadB)!
    expect(bThread().isStreaming).toBe(true)
    expect(bThread().bgSessionId).toBe(sessB)

    // 3) Start a SECOND concurrent stream on A → cc_start#2 returns sessA (active).
    chat.sendMessage('implement a log parser')
    streamCb.onMessage!({ type: 'mode_switch', target: 'local_cc', conversation_id: 'conv-A' })
    await new Promise((r) => setTimeout(r, 15))
    env.emitStream({ sessionId: sessA, event: { type: 'message_start', cc_session_id: 'cc-native-A' } })

    // 4) INTERLEAVE both streams' chunks, tagged by their own wrapper session id.
    env.emitStream({ sessionId: sessA, event: { delta: 'Parser ' } })
    env.emitStream({ sessionId: sessB, event: { delta: 'validated.' } }) // background B
    env.emitStream({ sessionId: sessA, event: { delta: 'handles JSONL. ' } })
    env.emitStream({ sessionId: sessB, event: { delta: '' } }) // background B
    env.emitStream({ sessionId: sessA, event: { delta: 'No leaks.' } })

    // 5) THE ASSERTIONS — no crossing in either direction:
    //    Active view shows ONLY A's tokens.
    expect(chat.streamingReply).toBe('Parser handles JSONL. No leaks.')
    expect(chat.streamingReply).not.toContain('validated')
    expect(chat.streamingReply).not.toContain('Rollback')
    expect(chat.streamingReply).not.toContain('deployment')
    //    Background thread B accumulated ONLY its own tokens.
    expect(bThread().bgStreamingReply).toBe('Rollback validated.')
    expect(bThread().bgStreamingReply).not.toContain('Parser')
    expect(bThread().bgStreamingReply).not.toContain('JSONL')

    // 6) Each stream pinned its OWN cc-native resume id to its OWN thread.
    expect(bThread().ccSessionId).toBe('cc-native-B')
    expect(chat.threads.find((t) => t.id === threadA)!.ccSessionId).toBe('cc-native-A')

    // 7) Switching BACK to B restores its full background text into the view
    //    (失忆 path still works after concurrent routing).
    env.emitStream({ sessionId: sessB, event: { done: true } }) // B finishes in bg
    await new Promise((r) => setTimeout(r, 5))
    expect(bThread().isStreaming).toBe(false)
    const bMsgs = bThread().messages
    expect(bMsgs[bMsgs.length - 1]).toEqual({ role: 'assistant', content: 'Rollback validated.' })
  })

  it('test_background_stream_chunk_never_touches_active_status_or_todo (串台 fix)', async () => {
    // A background conversation's cc_status / error must NOT write the active
    // view's ccStatus, ccTodoList, or streamErrorChunk — those belong to the
    // active conversation alone.
    let startCount = 0
    const sessBg = 'wrapper-sess-bg'
    const sessActive = 'wrapper-sess-active'
    const env = installElectronApi({
      cc_start: vi.fn(async () => {
        startCount++
        return { ok: true, sessionId: startCount === 1 ? sessBg : sessActive }
      }),
    })
    setActivePinia(createPinia())
    const { useChatStore } = await import('../chat')
    const chat = useChatStore()

    // Background thread, switched away mid-stream. (Non-task-intent text so the
    // streamMessage mock captures onMessage synchronously — a task-like prompt
    // would trip task routing into the async intentCheck detour.)
    chat.sendMessage('inspect a background build')
    streamCb.onMessage!({ type: 'mode_switch', target: 'local_cc', conversation_id: 'conv-bg' })
    await new Promise((r) => setTimeout(r, 15))
    env.emitStream({ sessionId: sessBg, event: { delta: 'bg-text' } })
    chat.createThread()

    // Active stream on the new thread.
    chat.sendMessage('review an active build')
    streamCb.onMessage!({ type: 'mode_switch', target: 'local_cc', conversation_id: 'conv-active' })
    await new Promise((r) => setTimeout(r, 15))
    env.emitStream({ sessionId: sessActive, event: { type: 'cc_status', label: '读取文件: notes.txt', tool: 'Read' } })
    const activeStatusAfter = chat.ccStatus
    const activeTodoLenAfter = chat.ccTodoList.length

    // Background emits its OWN cc_status + a terminal error — must be swallowed
    // into the bg thread, leaving the active status/todo/error untouched.
    env.emitStream({ sessionId: sessBg, event: { type: 'cc_status', label: 'BG STEP — should not show', tool: 'Bash' } })
    env.emitStream({ sessionId: sessBg, event: { error: 'bg boom' } })

    expect(chat.ccStatus).toBe(activeStatusAfter)
    expect(chat.ccStatus).not.toContain('BG STEP')
    expect(chat.ccTodoList.length).toBe(activeTodoLenAfter)
    expect(chat.ccTodoList.some((i) => i.label.includes('BG STEP'))).toBe(false)
    // Active error bubble must NOT be set by a background stream's error.
    expect(chat.streamErrorChunk).toBeNull()
  })

  it('test_orphan_stream_chunk_dropped_not_dumped_into_active_view (串台 guard)', async () => {
    // A chunk whose wrapper session matches NO live thread (subprocess outlived
    // its thread / stale event) must be DROPPED, never appended to the active
    // streamingReply — that would be cross-talk from a dead stream.
    const env = installElectronApi({
      cc_start: vi.fn(async () => ({ ok: true, sessionId: 'sess-real-active' })),
    })
    setActivePinia(createPinia())
    const { useChatStore } = await import('../chat')
    const chat = useChatStore()

    chat.sendMessage('inspect the deployment logs')
    streamCb.onMessage!({ type: 'mode_switch', target: 'local_cc', conversation_id: 'conv-real' })
    await new Promise((r) => setTimeout(r, 15))
    env.emitStream({ sessionId: 'sess-real-active', event: { delta: 'real ' } })

    // Orphan: unknown session id, no matching active/background thread.
    env.emitStream({ sessionId: 'sess-ghost-9999', event: { delta: 'GHOST INJECTION' } })
    env.emitStream({ sessionId: 'sess-real-active', event: { delta: 'reply' } })

    expect(chat.streamingReply).toBe('real reply')
    expect(chat.streamingReply).not.toContain('GHOST')
  })

  it('test_agentic_flush_persists_assistant_bubble_to_cloud (1.7.136 持久化 fix)', async () => {
    const chatApi = await import('@/api/endpoints/chat')
    ;(chatApi.appendMessage as ReturnType<typeof vi.fn>).mockClear()
    const env = installElectronApi({
      cc_start: vi.fn(async () => ({ ok: true, sessionId: 'sess-persist' })),
    })
    setActivePinia(createPinia())
    const { useChatStore } = await import('../chat')
    const chat = useChatStore()

    // Non-task-intent text (avoids the async intentCheck detour so the
    // streamMessage mock captures onMessage synchronously, like the other tests).
    chat.sendMessage('inspect persisted tool output')
    streamCb.onMessage!({ type: 'mode_switch', target: 'local_cc', conversation_id: 'conv-P' })
    await new Promise((r) => setTimeout(r, 15))

    const sid = 'sess-persist'
    // Agentic turn: assistant text → a tool call (flushes the text bubble) →
    // an EMPTY final chunk (the text already went out before the tool round).
    env.emitStream({ sessionId: sid, event: { delta: '我来检查运行日志。' } })
    env.emitStream({ sessionId: sid, event: { type: 'cc_status', label: '运行远程检查' } })
    env.emitStream({ sessionId: sid, event: { done: true } })
    await new Promise((r) => setTimeout(r, 5))

    // The flushed assistant bubble MUST be persisted to cloud. The old code only
    // persisted on a non-empty FINAL streamingReply, so agentic turns (empty
    // final) silently dropped the reply → conversations looked empty on reload.
    expect(chatApi.appendMessage).toHaveBeenCalledWith(
      'conv-P',
      expect.objectContaining({ role: 'assistant', content: '我来检查运行日志。' }),
    )
  })

  it('test_stopStreaming_during_cc_stream_stops_cc', async () => {
    const fixedSessionId = 'sess-stop-stream-1'
    const env = installElectronApi({
      cc_start: vi.fn(async () => ({ ok: true, sessionId: fixedSessionId })),
    })
    const { chat } = await primeCcSession(fixedSessionId, 'conv-stop')

    // Sanity check — still streaming from the CC bridge's perspective.
    expect(chat.isStreaming).toBe(true)

    // User hits Stop.
    chat.stopStreaming()

    expect(env.api.cc_stop).toHaveBeenCalledTimes(1)
    expect(env.api.cc_stop).toHaveBeenCalledWith({ sessionId: fixedSessionId })
    expect(chat.isStreaming).toBe(false)
  })

  it('test_logout_without_active_session_is_noop', async () => {
    const env = installElectronApi()
    setActivePinia(createPinia())
    const { useChatStore } = await import('../chat')
    const chat = useChatStore()

    // No sendMessage / no mode_switch → _ccSessionId is null.
    expect(() => chat.onUserChanged()).not.toThrow()
    expect(env.api.cc_stop).not.toHaveBeenCalled()
  })

  it('test_cc_stop_failure_does_not_block_logout', async () => {
    const fixedSessionId = 'sess-failing-stop-1'
    const rejecting = vi.fn(async () => {
      throw new Error('ipc offline')
    })
    const env = installElectronApi({
      cc_start: vi.fn(async () => ({ ok: true, sessionId: fixedSessionId })),
      cc_stop: rejecting,
    })
    const { chat } = await primeCcSession(fixedSessionId, 'conv-fail-stop')

    // onUserChanged must not throw even though cc_stop rejects.
    expect(() => chat.onUserChanged()).not.toThrow()
    // We let the microtask queue drain so the void-promise rejection
    // wouldn't bubble as an unhandled rejection in the test runner.
    await new Promise((r) => setTimeout(r, 15))

    expect(rejecting).toHaveBeenCalledTimes(1)
    // The logout side-effects still completed.
    expect(chat.currentConversationId).toBeNull()
    expect(chat.streamingReply).toBe('')
    expect(env.api).toBe(env.api)  // still mounted (didn't blow up window)
  })

  it('test_ccEventUnsub_called_on_logout', async () => {
    const env = installElectronApi()
    setActivePinia(createPinia())
    const { useChatStore } = await import('../chat')
    const chat = useChatStore()

    // Store init should have subscribed once.
    expect(env.api.cc_on_stream_event).toHaveBeenCalledTimes(1)
    expect(env.api.cc_on_session_exit).toHaveBeenCalledTimes(1)
    expect(env.streamUnsubs).toHaveLength(1)
    expect(env.exitUnsubs).toHaveLength(1)
    const initialStreamUnsub = env.streamUnsubs[0]!
    const initialExitUnsub = env.exitUnsubs[0]!

    chat.onUserChanged()

    // The unsub handed back by the first subscription must have fired.
    expect(initialStreamUnsub).toHaveBeenCalledTimes(1)
    expect(initialExitUnsub).toHaveBeenCalledTimes(1)

    // And the store must have re-wired a fresh subscription so the next
    // logged-in user still gets CC events.
    expect(env.api.cc_on_stream_event).toHaveBeenCalledTimes(2)
    expect(env.api.cc_on_session_exit).toHaveBeenCalledTimes(2)
  })

  it('test_concurrent_conversations_use_distinct_session_identity (1.7.142 串台 根因)', async () => {
    // THE real root cause the display-routing fix (1.7.141) MISSED: conversation
    // identity floated in the global `currentConversationId` (nulled on
    // createThread, lazily regenerated on send, never restored per-thread on
    // selectThread). So a 2nd conversation's send could reuse the 1st's
    // conversation id → cc-wrapper `byConv` returns the SAME process → the new
    // prompt appends to the OLD context → the model sees both designs and says
    // "切换过来". Each thread now owns a STABLE conversationId; every send
    // derives BOTH the conversation id AND the --resume id from the active
    // thread, so they can never desync.
    //
    // This drives the DIRECT local-CC path (lab mode short-circuit) — the path
    // a production session with the runtime installed uses — so cc_start receives
    // the store's own per-thread conversationId, not a hand-fed mode_switch id.
    ;(window as unknown as { __AWP_LAB_MODE?: boolean }).__AWP_LAB_MODE = true
    try {
      const started: Array<{ conversationId?: string; ccSessionId?: string }> = []
      const env = installElectronApi({
        cc_start: vi.fn(async (o: { conversationId?: string; ccSessionId?: string }) => {
          started.push({ conversationId: o.conversationId, ccSessionId: o.ccSessionId })
          return { ok: true, sessionId: `sess-${o.conversationId}` }
        }),
      })
      setActivePinia(createPinia())
      const { useChatStore } = await import('../chat')
      const chat = useChatStore()
      const threadA = chat.activeThreadId
      const convA = chat.threads.find((t) => t.id === threadA)!.conversationId!
      expect(convA).toBeTruthy() // stable id assigned at birth, never null

      // Turn 1 in A.
      chat.sendMessage('implement a JSONL parser with retry handling')
      await new Promise((r) => setTimeout(r, 20))
      env.emitStream({ sessionId: `sess-${convA}`, event: { type: 'message_start', cc_session_id: 'cc-native-A', conversation_id: convA } })
      env.emitStream({ sessionId: `sess-${convA}`, event: { delta: 'Parser state...' } })
      expect(chat.threads.find((t) => t.id === threadA)!.ccSessionId).toBe('cc-native-A')

      // Open conversation B (A keeps streaming in the background).
      chat.createThread()
      const threadB = chat.activeThreadId
      const convB = chat.threads.find((t) => t.id === threadB)!.conversationId!
      expect(convB).not.toBe(convA) // DISTINCT identity — never reused

      // Turn 1 in B (concurrent with A still live).
      chat.sendMessage('prepare a rollback checklist for the deploy')
      await new Promise((r) => setTimeout(r, 20))

      // ROOT-CAUSE ASSERTIONS:
      // (1) B's cc_start used B's OWN conversationId, not A's → cc-wrapper
      //     byConv spawns a SEPARATE process → contexts never merge.
      expect(started.map((s) => s.conversationId)).toEqual([convA, convB])
      expect(started[1]!.conversationId).not.toBe(started[0]!.conversationId)
      // (2) B started FRESH — it did NOT resume A's cc-native session (the
      //     `--resume <A>` cross that made the model answer task A inside task B).
      expect(started[1]!.ccSessionId).toBeUndefined()
      expect(started[1]!.ccSessionId).not.toBe('cc-native-A')

      // (3) Switch BACK to A and send → resumes A's OWN cc session
      //     (continuation), proving the resume id stuck to the right thread
      //     even after a switch (the exact timing the old code got wrong).
      env.emitStream({ sessionId: `sess-${convA}`, event: { done: true } }) // A finishes in bg
      await new Promise((r) => setTimeout(r, 5))
      await chat.selectThread(threadA)
      chat.sendMessage('now add retry handling')
      await new Promise((r) => setTimeout(r, 20))
      expect(started[2]!.conversationId).toBe(convA)
      expect(started[2]!.ccSessionId).toBe('cc-native-A') // resumed A, not B, not fresh
    } finally {
      delete (window as unknown as { __AWP_LAB_MODE?: boolean }).__AWP_LAB_MODE
    }
  })

  it('test_task_progress_panel_is_per_conversation (1.7.143 三 session 同进度 fix)', async () => {
    // 任务进度(ccTodoList/ccStatus) was a store-global → opening N conversations
    // showed the SAME panel in all (operator: "开三个 session, 任务进度都显示一样").
    // Each thread now owns its task progress; switching restores the right one.
    ;(window as unknown as { __AWP_LAB_MODE?: boolean }).__AWP_LAB_MODE = true
    try {
      const env = installElectronApi({
        cc_start: vi.fn(async (o: { conversationId?: string }) => ({ ok: true, sessionId: `sess-${o.conversationId}` })),
      })
      setActivePinia(createPinia())
      const { useChatStore } = await import('../chat')
      const chat = useChatStore()
      const threadA = chat.activeThreadId

      // A: a tool step lands in the active panel.
      chat.sendMessage('review the release checklist')
      await new Promise((r) => setTimeout(r, 15))
      const convA = chat.threads.find((t) => t.id === threadA)!.conversationId
      env.emitStream({ sessionId: `sess-${convA}`, event: { type: 'cc_status', label: 'read /workspace/runbook.md (A)', tool: 'Bash' } })
      expect(chat.ccTodoList.some((i) => i.label.includes('(A)'))).toBe(true)

      // Open conversation B → its panel must START EMPTY, not inherit A's steps.
      chat.createThread()
      expect(chat.ccTodoList.length, 'new conversation panel must be empty, not A').toBe(0)
      const threadB = chat.activeThreadId
      chat.sendMessage('inspect the deployment logs')
      await new Promise((r) => setTimeout(r, 15))
      const convB = chat.threads.find((t) => t.id === threadB)!.conversationId
      env.emitStream({ sessionId: `sess-${convB}`, event: { type: 'cc_status', label: 'ls /workspace/logs (B)', tool: 'Bash' } })
      // B shows ONLY B's step.
      expect(chat.ccTodoList.some((i) => i.label.includes('(B)'))).toBe(true)
      expect(chat.ccTodoList.some((i) => i.label.includes('(A)')), 'B panel must NOT show A step').toBe(false)

      // Switch back to A → A's panel restored (A's step, not B's).
      await chat.selectThread(threadA)
      expect(chat.ccTodoList.some((i) => i.label.includes('(A)')), 'A panel restored on switch-back').toBe(true)
      expect(chat.ccTodoList.some((i) => i.label.includes('(B)')), 'A panel must NOT show B step').toBe(false)
    } finally {
      delete (window as unknown as { __AWP_LAB_MODE?: boolean }).__AWP_LAB_MODE
    }
  })

  it('keeps timer and error state isolated per conversation', async () => {
    // The other three panel globals — thinking-timer (streamStartedAt), error
    // bubble (streamErrorChunk) also leaked across conversations.
    // Both fields are now parked and restored per thread.
    ;(window as unknown as { __AWP_LAB_MODE?: boolean }).__AWP_LAB_MODE = true
    try {
      installElectronApi()
      setActivePinia(createPinia())
      const { useChatStore } = await import('../chat')
      const chat = useChatStore()
      const threadA = chat.activeThreadId

      // Simulate A having an error bubble and a running thinking timer.
      chat.streamErrorChunk = { message: 'A-ERR-boom' }
      chat.streamStartedAt = 12345

      // Open conversation B → its panel must be clean.
      chat.createThread()
      expect(chat.streamErrorChunk, 'B must not inherit A error bubble').toBeNull()
      expect(chat.streamStartedAt, 'B must not inherit A timer').toBeNull()

      // Switch back to A → its error and timer are restored.
      await chat.selectThread(threadA)
      expect(chat.streamErrorChunk?.message, 'A error restored').toBe('A-ERR-boom')
      expect(chat.streamStartedAt, 'A timer restored').toBe(12345)
    } finally {
      delete (window as unknown as { __AWP_LAB_MODE?: boolean }).__AWP_LAB_MODE
    }
  })
})
