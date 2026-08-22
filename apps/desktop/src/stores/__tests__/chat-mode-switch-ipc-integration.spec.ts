/**
 * ADR-012 Phase 2 (T-A074): full chat ↔ local-CC bridge integration test.
 *
 * GAP we're closing:
 *   - `chat-mode-switch.spec.ts` mocks `window.electronAPI.cc_start` /
 *     `cc_on_stream_event`, so it exercises the renderer-side switchboard
 *     in isolation — no real subprocess spawn, no real stdout parse, no
 *     real `translateEvent`.
 *   - `cc-wrapper-fake-cli-e2e.spec.ts` (T-A042) spawns the real
 *     `fake-agent-cli.js` and validates the main-process half — but stops at
 *     the `cc:stream-event` broadcast, never touches the renderer store.
 *
 *   Nothing tested the FULL path: renderer `mode_switch` → `cc_start` →
 *   real subprocess → stdout stream-json → `translateEvent` → renderer
 *   subscription → `_ingestChunk` → `streamingReply` / `isStreaming`
 *   state transitions. One misaligned contract on either side (missing
 *   event channel, wrong `sessionId` field, chunk shape drift) slips
 *   through both existing suites.
 *
 *   This spec bridges the two halves in-process. Instead of launching
 *   Electron (Playwright `electron.launch()` is heavy and requires the
 *   full login flow + a real BrowserWindow), we simulate the IPC layer:
 *   the renderer-side `window.electronAPI` stub forwards `cc_start` /
 *   `cc_send_message` / `cc_stop` directly into the real cc-wrapper's
 *   `startSession` / `sendMessage` / `stopSession`, and listens on the
 *   real `ccEvents` emitter to deliver `cc:stream-event` / `cc:session-exit`
 *   payloads into whatever callback `stores/chat.ts` registered via
 *   `cc_on_stream_event` / `cc_on_session_exit`.
 *
 *   What this DOES exercise end-to-end:
 *     - cc-wrapper `spawn(node fake-agent-cli.js, ...)` real subprocess
 *     - real stdout line-split + JSON.parse + `translateEvent`
 *     - `broadcast('cc:stream-event', ...)` event plumbing
 *     - renderer subscription guard (`sessionId === _ccSessionId.value`)
 *     - `_ingestChunk` switchboard → `streamingReply` / `isStreaming` state
 *     - `cc:session-exit` before `done:true` → `streamErrorChunk` path
 *
 *   What this does NOT exercise (explicit limits):
 *     - Actual `ipcMain.handle` ↔ `ipcRenderer.invoke` marshaling
 *       (that's Playwright Electron territory — T-A0xx-future)
 *     - `webContents.send` across processes (in-process ccEvents stands in)
 *     - preload.ts `contextBridge.exposeInMainWorld` wiring
 *
 * Gotchas learned while writing this:
 *   - Must `vi.mock('electron', ...)` BEFORE importing cc-wrapper, same as
 *     T-A042's e2e spec. Otherwise `BrowserWindow` / `ipcMain` references
 *     at module top blow up in node-only vitest.
 *   - happy-dom's `window` is writable; install `electronAPI` BEFORE
 *     calling `setActivePinia` so the store's `_wireCcSubscriptions()`
 *     (which runs at module init) sees the stub.
 *   - The CLI executable and argv are configured explicitly — the fixture path
 *     is passed as one argv element. Same contract as the adapter unit suite.
 *   - `__resetForTests()` clears cc-wrapper's session map AND
 *     `ccEvents.removeAllListeners()`, so re-wiring listeners after reset
 *     is necessary. We wire a fresh bridge in `beforeEach`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import * as path from 'node:path'

// Mock electron before the cc-wrapper import (same pattern as T-A042).
// BrowserWindow.getAllWindows() → [] means `broadcast()` falls back to
// the in-process ccEvents emitter, which is exactly what we want the
// simulated IPC bridge to listen on.
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { removeHandler: () => {}, handle: () => {} },
}))

// Mock the store's non-essential collaborators so importing `stores/chat`
// doesn't pull half the app into the test. Mirrors chat-mode-switch.spec.ts
// — we only diverge on `window.electronAPI`, where we install a real bridge
// instead of vi.fn() stubs.
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
  getConversation: vi.fn(async () => ({ messages: [], model: '', updated_at: null })),
  // 2026-06-10 fix: chat store now persists user/assistant turns via
  // appendMessage (fire-and-forget). vitest throws on missing mock exports,
  // which aborted the store's message-push helper before the local push —
  // all 3 round-trip cases then failed their "last message role" asserts.
  appendMessage: vi.fn(async () => ({ ok: true })),
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

// Import the REAL cc-wrapper. `../../electron/cc/cc-wrapper` — going up two
// levels from src/stores/__tests__/ lands in desktop/, then electron/cc/.
import {
  startSession,
  sendMessage,
  stopSession,
  ccEvents,
  __resetForTests,
} from '../../../electron/cc/cc-wrapper'

// Fake CLI fixture: desktop/e2e/fixtures/fake-agent-cli.js. __dirname at
// runtime = <repo>/desktop/src/stores/__tests__.
const FAKE_CLI = path.resolve(
  __dirname, '..', '..', '..', 'e2e', 'fixtures', 'fake-agent-cli.js',
)

// ---------------------------------------------------------------------------
// Simulated IPC bridge
// ---------------------------------------------------------------------------

interface CcEventPayload {
  sessionId: string
  event: Record<string, unknown>
}
interface CcExitPayload {
  sessionId: string
  code: number | null
  signal: string | null
  error?: string
}
type CcEventCb = (payload: CcEventPayload) => void
type CcExitCb = (payload: CcExitPayload) => void

interface StartOverride {
  (opts: { conversationId: string; model?: string }): Promise<{ ok: boolean; sessionId?: string; error?: string }>
}

/**
 * Install a `window.electronAPI` stub that forwards into the real cc-wrapper.
 * This is the "simulated IPC" — in the real app preload.ts wires these via
 * `ipcRenderer.invoke`/`.on`, but for the integration test we short-circuit
 * the IPC boundary while keeping every byte of the subprocess path real.
 */
function installElectronApiBridge(opts?: {
  startOverride?: StartOverride
}) {
  const streamCallbacks: CcEventCb[] = []
  const exitCallbacks: CcExitCb[] = []

  // Wire the real ccEvents emitter to all registered renderer callbacks.
  // Only one registration; multiplex internally.
  const onStream = (p: CcEventPayload) => {
    for (const cb of streamCallbacks) {
      try { cb(p) } catch { /* isolate cb errors */ }
    }
  }
  const onExit = (p: CcExitPayload) => {
    for (const cb of exitCallbacks) {
      try { cb(p) } catch { /* isolate cb errors */ }
    }
  }
  ccEvents.on('cc:stream-event', onStream)
  ccEvents.on('cc:session-exit', onExit)

  const api = {
    cc_start: vi.fn(async (o: { conversationId: string; model?: string }) => {
      if (opts?.startOverride) return opts.startOverride(o)
      return startSession({
        conversationId: o.conversationId,
        model: o.model,
      })
    }),
    cc_send_message: vi.fn(async (o: { sessionId: string; content: string }) => {
      return sendMessage({ sessionId: o.sessionId, content: o.content })
    }),
    cc_stop: vi.fn(async (o: { sessionId: string }) => stopSession(o)),
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

  const teardown = () => {
    ccEvents.off('cc:stream-event', onStream)
    ccEvents.off('cc:session-exit', onExit)
    streamCallbacks.length = 0
    exitCallbacks.length = 0
    try { delete (window as unknown as Record<string, unknown>).electronAPI } catch { /* noop */ }
  }
  return { api, teardown }
}

/** Poll `predicate` every 10ms up to `timeoutMs`, resolve when true. */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`waitUntil timeout: ${label} (after ${timeoutMs}ms)`)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chat mode_switch — full IPC round-trip (simulated)', () => {
  beforeEach(() => {
    localStorage.clear()
    streamCb.onMessage = null
    ;(streamCb.close as ReturnType<typeof vi.fn>).mockClear?.()
    // cc-wrapper state reset (sessions map + ccEvents listeners). The
    // store's own `_wireCcSubscriptions()` re-adds its listener when we
    // create a new pinia instance — but the cc-wrapper's own listeners
    // got removed too, so we must re-wire the bridge each test.
    __resetForTests()
    process.env.AWP_AGENT_CLI_EXECUTABLE = process.execPath
    process.env.AWP_AGENT_CLI_ARGS_JSON = JSON.stringify([FAKE_CLI])
    process.env.AWP_AGENT_CLI_ENV_JSON = '{}'
  })

  afterEach(() => {
    delete process.env.AWP_AGENT_CLI_EXECUTABLE
    delete process.env.AWP_AGENT_CLI_ARGS_JSON
    delete process.env.AWP_AGENT_CLI_ENV_JSON
    __resetForTests()
  })

  it('mode_switch → fake-cli streams → streamingReply populated → isStreaming=false on done', async () => {
    const { teardown } = installElectronApiBridge()
    setActivePinia(createPinia())
    const { useChatStore } = await import('../chat')
    const chat = useChatStore()

    try {
      // 1. Renderer sends user message — Cloud SSE opens.
      chat.sendMessage('hello from integration test')
      expect(streamCb.onMessage).toBeTruthy()
      expect(chat.isStreaming).toBe(true)

      // 2. Cloud emits mode_switch → store closes SSE + kicks off cc_start.
      streamCb.onMessage!({
        type: 'mode_switch',
        target: 'local_cc',
        conversation_id: 'conv-ipc-integration',
      })

      // Cloud SSE got closed.
      expect(streamCb.close).toHaveBeenCalled()
      expect(chat.currentConversationId).toBe('conv-ipc-integration')

      // 3. Wait for cc-wrapper to spawn + send + fake-cli to stream 'ok' +
      //    emit message_stop → store sets isStreaming=false.
      //    Fake CLI timing: 100ms startup + 50ms * 6 events ≈ 400ms;
      //    Windows spawn overhead pushes it to ~1-2s.
      await waitUntil(() => chat.isStreaming === false, 12_000, 'isStreaming → false')

      // The 'ok' delta from fake-cli landed in the committed assistant bubble.
      // streamingReply is cleared on done; the text is in currentMessages.
      const last = chat.currentMessages[chat.currentMessages.length - 1]
      expect(last).toBeDefined()
      expect(last!.role).toBe('assistant')
      expect(last!.content).toBe('ok')
      expect(chat.streamingReply).toBe('')
      expect(chat.streamErrorChunk).toBeNull()
    } finally {
      teardown()
    }
  }, 20_000)

  it('session exit before done (hang mode → forced stop) surfaces as streamErrorChunk', async () => {
    process.env.AWP_AGENT_CLI_ENV_JSON = JSON.stringify({ AWP_FAKE_AGENT_MODE: 'hang' })
    const { api, teardown } = installElectronApiBridge()
    setActivePinia(createPinia())
    const { useChatStore } = await import('../chat')
    const chat = useChatStore()

    try {
      chat.sendMessage('will be killed mid-stream')
      streamCb.onMessage!({
        type: 'mode_switch',
        target: 'local_cc',
        conversation_id: 'conv-hang-exit',
      })

      // Wait for cc_start to resolve with a real sessionId.
      await waitUntil(
        () => api.cc_start.mock.results.length > 0,
        5_000,
        'cc_start invoked',
      )
      const startRes = await api.cc_start.mock.results[0]!.value
      expect(startRes.ok).toBe(true)
      const sessionId = startRes.sessionId as string

      // Fake-cli hang mode never emits message_stop. Force-stop the session
      // BEFORE any done:true chunk — cc-wrapper will emit cc:session-exit,
      // the renderer subscription sees _gotCcDone === false, and surfaces
      // the streamErrorChunk.
      await stopSession({ sessionId })

      await waitUntil(
        () => chat.streamErrorChunk !== null,
        6_000,
        'streamErrorChunk set after exit-before-done',
      )
      expect(chat.streamErrorChunk!.message).toMatch(/cc_session_exit_before_done/)
      expect(chat.isStreaming).toBe(false)
    } finally {
      teardown()
    }
  }, 20_000)

  it('cc_start failure propagates as streamErrorChunk with cc_start_failed message', async () => {
    // Override start to simulate a spawn failure WITHOUT touching the real
    // subprocess. The renderer cares only about `{ok:false, error}`.
    const { teardown } = installElectronApiBridge({
      startOverride: async () => ({ ok: false, error: 'spawn_failed_enoent' }),
    })
    setActivePinia(createPinia())
    const { useChatStore } = await import('../chat')
    const chat = useChatStore()

    try {
      chat.sendMessage('this will fail to start CC')
      streamCb.onMessage!({
        type: 'mode_switch',
        target: 'local_cc',
        conversation_id: 'conv-start-fail',
      })

      await waitUntil(
        () => chat.streamErrorChunk !== null,
        3_000,
        'streamErrorChunk set on cc_start failure',
      )

      expect(chat.streamErrorChunk!.message).toMatch(/cc_start_failed/)
      expect(chat.streamErrorChunk!.message).toMatch(/spawn_failed_enoent/)
      expect(chat.isStreaming).toBe(false)
    } finally {
      teardown()
    }
  }, 10_000)

  it('stream events for mismatched sessionId are ignored by renderer subscription', async () => {
    // Regression guard: cc-wrapper broadcasts on a single ccEvents channel,
    // so if two sessions are ever alive (e.g. during a turn handoff) the
    // renderer MUST filter on sessionId. The switchboard only ingests
    // events whose sessionId matches `_ccSessionId.value`.
    const { api, teardown } = installElectronApiBridge()
    setActivePinia(createPinia())
    const { useChatStore } = await import('../chat')
    const chat = useChatStore()

    try {
      chat.sendMessage('match test')
      streamCb.onMessage!({
        type: 'mode_switch',
        target: 'local_cc',
        conversation_id: 'conv-match-session',
      })

      await waitUntil(
        () => api.cc_start.mock.results.length > 0,
        5_000,
        'cc_start invoked',
      )

      // Manually broadcast a phantom event under a DIFFERENT sessionId.
      // The renderer's `_wireCcSubscriptions` guard should drop it.
      ccEvents.emit('cc:stream-event', {
        sessionId: 'phantom-session-id-never-existed',
        event: { delta: ' PHANTOM SHOULD BE IGNORED ' },
      })

      // The fake-cli real session should still finish cleanly with 'ok'.
      await waitUntil(() => chat.isStreaming === false, 12_000, 'real session done')

      const last = chat.currentMessages[chat.currentMessages.length - 1]
      expect(last!.content).toBe('ok')
      // Phantom text MUST NOT have leaked into either the committed bubble
      // or any intermediate state.
      expect(last!.content).not.toMatch(/PHANTOM/)
    } finally {
      teardown()
    }
  }, 20_000)
})
