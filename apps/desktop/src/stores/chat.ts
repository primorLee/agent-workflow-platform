import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import i18n from '@/i18n'
import * as chatApi from '@/api/endpoints/chat'
import type { UploadedFileRef } from '@/api/endpoints/chat'
import type { ChatMessage, ChatModel, Conversation, TokenUsage } from '@/api/types'
import { useToastStore } from '@/stores/toast'
import { useSettingsStore } from '@/stores/settings'

// ---------- Thread type for sidebar ----------
export interface Thread {
  id: string
  /**
   * STABLE per-conversation identity. The single
   * source of truth for THIS conversation: the runtime wrapper `byConv` key (one
   * agent process per conversation), the remote history id, and the anchor
   * the runtime-native resume id is pinned onto. Generated once at thread birth,
   * NEVER reused across threads, NEVER nulled. The old code let identity float
   * in the global `currentConversationId` (nulled on createThread, lazily
   * regenerated on send, never restored per-thread on selectThread) → a "new"
   * conversation's send could collide onto an existing `byConv` session or
   * resume a DIFFERENT conversation's agent session → the model saw both contexts
   * and said "切换过来" (串台). Now the global is just a projection of this.
   */
  conversationId?: string
  title: string
  messages: ChatMessage[]
  model: string
  created_at: string
  updated_at: string
  /**
   * Native session id captured from the configured Agent CLI event stream.
   * Persisted so a later turn can resume the same compatible runtime session,
   * keeping its prompt cache and private history intact across thread switches and full app restarts.
   *
   * Mirrored to remote adapter via `conversations.cc_session_id` on every change.
   */
  ccSessionId?: string | null
  /**
   * per-thread BACKGROUND streaming state, so the AI keeps
   * generating when you switch away (long-running Agent CLI behavior) instead of
   * being killed. `isStreaming` = this thread has a live agent session;
   * `bgStreamingReply` = the in-progress reply accumulated while this thread is
   * NOT the active view. On switch-back these restore into the singleton view
   * (`streamingReply`/`isStreaming`); on background `done`/exit the reply
   * commits to `messages`. The agent subprocess is already per-thread
   * (`ccSessionId`) — navigation no longer calls `cc_stop`.
   */
  isStreaming?: boolean
  bgStreamingReply?: string
  /**
   * WRAPPER session id (the cc_start handle, used to ROUTE agent
   * stream events to this thread while it streams in the background). Kept
   * STRICTLY SEPARATE from `ccSessionId` (the runtime-native `--resume` id):
   * conflating them let `_detachActiveStreamToThread` overwrite the
   * resume id with the wrapper id → next send resumed a non-existent session →
   * resume continuity was lost. Only this field is touched by
   * detach; `ccSessionId` is never overwritten by background bookkeeping.
   */
  bgSessionId?: string | null
  /** remote adapter conversation id captured at detach, so a turn that finishes while
   * you're switched away still persists to the RIGHT conversation. */
  bgConvId?: string | null
  /**
   * per-thread task-progress ("任务进度" 面板: 当前步
   * cc_status + 工具步骤列表). Global `ccStatus`/`ccTodoList` before → every
   * conversation's panel read the SAME list (open 3 sessions → all identical).
   * Parked on switch-away, restored on switch-back, accumulated for background
   * streams onto their own thread. View-only — never enters `messages`.
   */
  ccTodoList?: Array<{ label: string; done: boolean; tool?: string }>
  ccStatus?: string
  /**
   * the rest of the per-turn panel state the StreamStatus
   * panel reads: thinking-timer start and error bubble. Global before
   * → leaked across conversations (A's timer/error/sim card showed in B). Parked
   * + restored with the rest of the conversation state.
   */
  streamStartedAt?: number | null
  streamErrorChunk?: { code?: string; message: string } | null

}

/** Stable per-conversation id (uuid; fallback for ancient runtimes w/o crypto). */
function _genConvId(): string {
  return (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : `cc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** Access the global i18n translate function. Works outside Vue component setup. */
interface I18nGlobal {
  t: (key: string, params?: Record<string, unknown>) => string
}
function t(key: string, params?: Record<string, unknown>): string {
  const g = i18n.global as unknown as I18nGlobal
  return params ? g.t(key, params) : g.t(key)
}

export const useChatStore = defineStore('chat', () => {
  const models = ref<ChatModel[]>([])
  const selectedModel = ref('')
  const conversations = ref<Conversation[]>([])
  const currentConversationId = ref<string | null>(null)
  const currentMessages = ref<ChatMessage[]>([])
  const streamingReply = ref('')
  const isStreaming = ref(false)
  const loading = ref(false)
  const error = ref<string | null>(null)

  // agent real-time status & todo list
  //
  // `tool` is the Agent CLI tool name (Read / Edit / Write / Bash /
  // Grep / Glob / Agent / WebSearch / WebFetch / TodoWrite / ...). The
  // ToolIcon component maps this to a Lucide SVG icon. Older servers
  // that don't emit `tool` leave it undefined — the icon falls back to
  // a generic wrench so the UI degrades gracefully.
  const ccStatus = ref('')
  const ccTodoList = ref<Array<{ label: string; done: boolean; tool?: string }>>([])

  // Streaming wait-indicator state. `streamStartedAt` drives the
  // "AI thinking (Xs)" counter that renders BEFORE the first assistant
  // token arrives — without it the user sees dead air between pressing
  // send and the first byte of response (agent cold-start can take 30s+).
  // `streamErrorChunk` captures a terminal `{type:"error"}` SSE frame so
  // the UI can render a red error bubble instead of a plain toast.
  const streamStartedAt = ref<number | null>(null)
  const streamErrorChunk = ref<{ code?: string; message: string } | null>(null)

  function _addTodoItem(label: string, tool?: string) {
    // Mark previous item as done
    const list = ccTodoList.value
    if (list.length > 0 && !list[list.length - 1]!.done) {
      list[list.length - 1]!.done = true
    }
    // Add new item (avoid duplicates by label+tool identity)
    if (!list.some(t => t.label === label && t.tool === tool)) {
      list.push({ label, done: false, tool })
    }
  }

  function _resetTodo() {
    ccStatus.value = ''
    ccTodoList.value = []
  }

  /** Snapshot ALL of a conversation's live per-turn panel state onto its thread
   *  (任务进度 list + status + thinking-timer + error bubble), so each
   *  conversation keeps its own — they were store-globals that leaked across
   *  open sessions. Deep-copies so later mutations don't alias.  */
  function _parkConversationState(thread: Thread | undefined): void {
    if (!thread) return
    thread.ccTodoList = ccTodoList.value.map(it => ({ ...it }))
    thread.ccStatus = ccStatus.value
    thread.streamStartedAt = streamStartedAt.value
    thread.streamErrorChunk = streamErrorChunk.value ? { ...streamErrorChunk.value } : null
  }

  /** Detect an error-shaped SSE chunk.
   *
   * remote adapter doesn't emit a single canonical shape today — we accept both
   *   1) `{ type: "error", code?, message? }` (future-proof explicit form)
   *   2) any chunk carrying an `error` field (legacy handlers in
   *      legacy remote adapters)
   *   3) a delta text starting with literal `E-XXXXXXXX` error code
   *      (whatever form Agent CLI eventually surfaces crash dumps as)
   * Returns null when the chunk is NOT an error. */
  function _extractErrorChunk(chunk: Record<string, unknown>): { code?: string; message: string } | null {
    if (chunk.type === 'error') {
      return {
        code: typeof chunk.code === 'string' ? chunk.code : undefined,
        message: typeof chunk.message === 'string' ? chunk.message
          : typeof chunk.error === 'string' ? chunk.error
          : 'Unknown error',
      }
    }
    if (typeof chunk.error === 'string' && chunk.error) {
      return { message: chunk.error as string }
    }
    const delta = typeof chunk.delta === 'string' ? chunk.delta : ''
    // Matches "E-" followed by 6–12 hex/alnum chars at start-of-delta.
    const m = delta.match(/^\s*(E-[A-Z0-9]{4,12})\b\s*:?\s*(.*)/i)
    if (m) {
      return { code: m[1], message: m[2] || delta }
    }
    return null
  }
  // 上下文用量追踪（基于运行时上下文建议）
  const contextUsage = ref({
    messageCount: 0,
    estimatedTokens: 0,
    maxTokens: 200_000,  // 初始估计值，后续可由模型元数据覆盖
    warningThreshold: 0.8,
  })

  // Chat attachments staged by the user before sending. Each entry is the
  // metadata we got back from `POST /v1/chat/upload` — the file bytes already
  // live in the per-conversation sandbox, so `sendMessage` only forwards the
  // refs as `uploaded_files` in the completions body. Cleared after a
  // successful send.
  const pendingAttachments = ref<UploadedFileRef[]>([])

  function attachUpload(f: UploadedFileRef) {
    pendingAttachments.value.push(f)
  }

  function removeAttachment(idx: number) {
    if (idx >= 0 && idx < pendingAttachments.value.length) {
      pendingAttachments.value.splice(idx, 1)
    }
  }

  function clearAttachments() {
    pendingAttachments.value.length = 0
  }

  let sseHandle: { close: () => void } | null = null

  // ---- local agent subprocess bridge ----
  // `_ccSessionId` is the current Desktop-local agent session receiving stream
  // events from the main-process runtime wrapper. Null when we're on the remote adapter
  // SSE path. `_gotCcDone` tracks whether we saw a `done:true` chunk before
  // the agent process exited — exit-before-done is surfaced as an error bubble
  // so the user doesn't stare at a frozen spinner.
  // `_lastSentUserContent` / `_lastSentAttachments` are captured at the top
  // of `sendMessage` so that when remote adapter answers with `mode_switch`, we can
  // replay the same payload into the local agent subprocess.
  const _ccSessionId = ref<string | null>(null)
  let _gotCcDone = false
  let _lastSentUserContent = ''
  let _lastSentAttachments: UploadedFileRef[] | undefined = undefined

  // ---- feature-flag-gated local agent path ----
  // `_ccFallbackInFlight` prevents double-sending when a local agent subprocess
  // crashes mid-turn and we auto-retry via the remote adapter HTTP path. Only one
  // crash-triggered retry is permitted per user message; a second crash
  // surfaces as a plain error bubble (the remote adapter path is the last resort,
  // re-trying it on every crash would pile up duplicate replies).
  // `_lastSentContentSig` is the dedup key that lets `stopStreaming`/retry
  // logic distinguish between a fresh user turn and a follow-up HTTP replay.
  let _ccFallbackUsed = false
  let _lastSentContentSig: string | null = null

  // ---------- Welcome message for new conversations ----------
  function _makeWelcome(): ChatMessage {
    return {
      role: 'assistant',
      content: t('chat.welcomeMessage'),
    }
  }

  /** Marker to identify welcome messages when filtering for API calls */
  function _isWelcomeMessage(msg: ChatMessage): boolean {
    return msg.role === 'assistant' && msg.content === t('chat.welcomeMessage')
  }

  function _injectWelcome(): ChatMessage[] {
    return [_makeWelcome()]
  }

  // ---------- Thread management + persistence ----------
  const THREADS_KEY_PREFIX = 'awp_threads'
  const MAX_PERSISTED_THREADS = 50

  /** Get user-scoped localStorage key. Falls back to global key if no user logged in. */
  function _threadsKey(): string {
    try {
      const cid = localStorage.getItem('awp_customer_id')
      if (cid) return `${THREADS_KEY_PREFIX}_${cid}`
    } catch { /* */ }
    return THREADS_KEY_PREFIX
  }

  function _loadPersistedThreads(): { threads: Thread[]; counter: number } {
    try {
      const key = _threadsKey()
      let raw = localStorage.getItem(key)
      // Migrate: if user-scoped key empty but global key has data, use global
      if (!raw && key !== THREADS_KEY_PREFIX) {
        raw = localStorage.getItem(THREADS_KEY_PREFIX)
      }
      if (raw) {
        const saved = JSON.parse(raw) as Thread[]
        if (Array.isArray(saved) && saved.length > 0) {
          // Compute next counter from saved thread IDs
          let maxId = 1
          for (const t of saved) {
            const m = t.id.match(/thread-(\d+)/)
            if (m) maxId = Math.max(maxId, parseInt(m[1]!, 10))
            // Migrate legacy threads: give each a STABLE conversationId so
            // identity stops floating in a global. Keep ccSessionId intact so
            // resume continuity survives the migration.
            if (!t.conversationId) t.conversationId = _genConvId()
          }
          return { threads: saved, counter: maxId + 1 }
        }
      }
    } catch { /* localStorage unavailable */ }

    const first: Thread = {
      id: 'thread-1',
      conversationId: _genConvId(),
      title: t('chat.defaultThreadTitle'),
      messages: _injectWelcome(),
      model: '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    return { threads: [first], counter: 2 }
  }

  function _persistThreads() {
    try {
      // Only persist most recent threads, truncate messages to save space
      const toSave = threads.value.slice(0, MAX_PERSISTED_THREADS).map(t => ({
        ...t,
        messages: t.messages.slice(-100),  // Keep last 100 messages per thread
      }))
      localStorage.setItem(_threadsKey(), JSON.stringify(toSave))
    } catch { /* localStorage full or unavailable */ }
  }

  /** Reload threads from localStorage after user login/logout/switch. */
  function onUserChanged() {
    stopStreaming()
    // Stop any local agent subprocess tied to the previous
    // user, and tear down the main-process event subscriptions so no
    // listeners leak across user sessions. We immediately re-wire fresh
    // subscriptions so the next logged-in user gets a clean bridge.
    // Order matters: cc_stop must run BEFORE clearing `_ccSessionId`, else
    // the id is lost.
    if (_ccSessionId.value) {
      try {
        const api = typeof window !== 'undefined' ? window.electronAPI : undefined
        if (api && typeof api.cc_stop === 'function') {
          void api.cc_stop({ sessionId: _ccSessionId.value })
        }
      } catch { /* noop */ }
      _ccSessionId.value = null
    }
    _teardownCcSubscriptions()
    _wireCcSubscriptions()
    _gotCcDone = false
    const fresh = _loadPersistedThreads()
    threads.value = fresh.threads
    threadCounter = fresh.counter
    activeThreadId.value = fresh.threads[0]?.id || 'thread-1'
    currentConversationId.value = null
    currentMessages.value = [...(fresh.threads[0]?.messages || [])]
    streamingReply.value = ''
    error.value = null
  }

  const _init = _loadPersistedThreads()
  const threads = ref<Thread[]>(_init.threads)
  const activeThreadId = ref<string>(_init.threads[0]?.id || 'thread-1')
  let threadCounter = _init.counter

  // Restore messages from the active thread
  currentMessages.value = [...(threads.value[0]?.messages || [])]

  /** Guarantee a thread has a stable conversationId (migrates legacy threads). */
  function _ensureConvId(thread: Thread): string {
    if (!thread.conversationId) {
      thread.conversationId = _genConvId()
      _persistThreads()
    }
    return thread.conversationId
  }

  function createThread() {
    // Keep any active compatible-agent stream running in the background;
    // The new thread opens with a clean, non-streaming view without stopping it.
    _detachActiveStreamToThread()
    // Park the outgoing conversation's task-progress before the new thread
    // resets the panel — else switching back shows an empty 任务进度.
    _parkConversationState(threads.value.find(t => t.id === activeThreadId.value))
    // Save current thread messages before switching
    _syncThreadMessages()
    const id = `thread-${threadCounter++}`
    const welcome = _injectWelcome()
    const thread: Thread = {
      id,
      // Stable identity from birth — never null, never lazily regenerated.
      // This is what keeps a brand-new conversation from colliding onto an
      // existing agent session.
      conversationId: _genConvId(),
      title: t('chat.defaultThreadTitle'),
      messages: [...welcome],
      model: selectedModel.value,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    threads.value.unshift(thread)
    activeThreadId.value = id
    // Project the new thread's stable id into the active-view global (was
    // `null` here → forced a lazy regen on send that could desync from resume).
    currentConversationId.value = thread.conversationId ?? null
    currentMessages.value = [...welcome]
    streamingReply.value = ''
    isStreaming.value = false
    _ccSessionId.value = null
    ccTodoList.value = []
    ccStatus.value = ''
    streamStartedAt.value = null
    streamErrorChunk.value = null
    error.value = null
    _persistThreads()
  }

  async function selectThread(id: string) {
    if (activeThreadId.value === id) return
    // Keep the current compatible-agent stream running in the background;
    // Restore it below if we switch back while it is still streaming.
    _detachActiveStreamToThread()
    // Save current messages to current thread
    const currentThread = threads.value.find(t => t.id === activeThreadId.value)
    if (currentThread) {
      currentThread.messages = [...currentMessages.value]
      _parkConversationState(currentThread)
    }
    // Switch
    activeThreadId.value = id
    const target = threads.value.find(t => t.id === id)
    // Project the selected thread's STABLE conversation id into the active-view
    // global immediately, so the next send uses THIS conversation's identity +
    // resume id — not a stale leftover from the thread we just left (串台).
    if (target) currentConversationId.value = _ensureConvId(target)
    // Restore THIS conversation's task-progress panel — was global, so every
    // conversation showed the previously-active one's steps (open 3 sessions →
    // all identical). Each thread now owns its 任务进度.
    ccTodoList.value = (target?.ccTodoList ?? []).map(it => ({ ...it }))
    ccStatus.value = target?.ccStatus ?? ''
    streamStartedAt.value = target?.streamStartedAt ?? null
    streamErrorChunk.value = target?.streamErrorChunk ? { ...target.streamErrorChunk } : null
    // Try fetching from remote adapter for last-write-wins comparison
    let cloudMessages: ChatMessage[] | null = null
    let cloudUpdatedAt: string | null = null
    let cloudCcSessionId: string | null = null
    try {
      const conv = await chatApi.getConversation(id)
      if (conv.messages && conv.messages.length > 0) {
        cloudMessages = conv.messages
        cloudUpdatedAt = conv.updated_at || null
      }
      // Pull cc_session_id from the remote adapter so a fresh
      // install on a second machine resumes the same agent session (warm cache
      // continues even after a localStorage wipe).
      if (typeof conv.cc_session_id === 'string' && conv.cc_session_id) {
        cloudCcSessionId = conv.cc_session_id
      }
    } catch { /* offline — remote adapter unavailable */ }

    const localUpdatedAt = target?.updated_at || null
    const localHasMessages = target && target.messages.length > 0

    if (localHasMessages && cloudMessages) {
      // Both exist — last-write-wins by updated_at
      const useCloud = cloudUpdatedAt && localUpdatedAt
        ? cloudUpdatedAt > localUpdatedAt
        : !!cloudUpdatedAt  // cloud wins if local has no timestamp
      if (useCloud) {
        currentMessages.value = cloudMessages
        if (target) {
          target.messages = [...cloudMessages]
          if (cloudUpdatedAt) target.updated_at = cloudUpdatedAt
        }
      } else {
        currentMessages.value = [...target!.messages]
      }
    } else if (cloudMessages) {
      // Only remote adapter has data
      currentMessages.value = cloudMessages
      if (target) {
        target.messages = [...cloudMessages]
        if (cloudUpdatedAt) target.updated_at = cloudUpdatedAt
      }
    } else if (localHasMessages) {
      // Only local has data
      currentMessages.value = [...target!.messages]
    } else {
      currentMessages.value = []
    }

    if (target) {
      selectedModel.value = target.model || selectedModel.value
      // ccSessionId merge: remote adapter wins if it has a value and local
      // doesn't, OR if remote adapter's updated_at is newer (the same last-write-wins
      // rule we use for messages above). Avoids clobbering a freshly captured
      // local id with a stale remote adapter copy from before we wired the PATCH.
      if (cloudCcSessionId) {
        const localId = target.ccSessionId || null
        const cloudWins = !localId
          || (cloudUpdatedAt && (!target.updated_at || cloudUpdatedAt > target.updated_at))
        if (cloudWins && localId !== cloudCcSessionId) {
          target.ccSessionId = cloudCcSessionId
          _persistThreads()
        }
      }
    }
    // restore this thread's in-progress BACKGROUND stream into the
    // view if it's still generating; otherwise a clean, non-streaming view. The
    // session (if live) becomes active again → its events route to the view.
    if (target?.isStreaming) {
      streamingReply.value = target.bgStreamingReply ?? ''
      isStreaming.value = true
      // Re-activate via the WRAPPER routing id so the still-running stream's
      // events hit the active view again; ccSessionId stays the runtime-native
      // --resume id (never touched by background bookkeeping).
      _ccSessionId.value = target.bgSessionId ?? null
      if (target.bgConvId) currentConversationId.value = target.bgConvId
      target.bgStreamingReply = '' // moved into the active view
      target.bgSessionId = null
      target.bgConvId = null
    } else {
      streamingReply.value = ''
      isStreaming.value = false
      _ccSessionId.value = null
    }
    error.value = null
  }

  // --- Computed ---

  const hasModels = computed(() => models.value.length > 0)
  const messageCount = computed(() => currentMessages.value.length)

  const contextPercent = computed(() => {
    if (!contextUsage.value.maxTokens) return 0
    return Math.min(100, Math.round(
      (contextUsage.value.estimatedTokens / contextUsage.value.maxTokens) * 100
    ))
  })

  const contextWarning = computed(() => contextPercent.value > 80)

  function updateContextUsage() {
    // 粗略估算: 1 token ≈ 3 字符（中文约 2 字符/token，英文约 4，取中间值）
    let totalChars = 0
    for (const msg of currentMessages.value) {
      totalChars += (msg.content || '').length
    }
    if (streamingReply.value) {
      totalChars += streamingReply.value.length
    }
    contextUsage.value.messageCount = currentMessages.value.length
    contextUsage.value.estimatedTokens = Math.round(totalChars / 3)
  }

  // --- Actions ---

  async function fetchModels() {
    try {
      models.value = await chatApi.getModels()
      if (!selectedModel.value && models.value.length > 0) {
        selectedModel.value = models.value[0]!.id
      }
    } catch (err) {
      error.value = (err as Error).message
    }
  }

  async function fetchHistory(limit = 50, offset = 0) {
    loading.value = true
    try {
      const convs = await chatApi.getHistory(limit, offset)
      conversations.value = convs
      // Sync remote adapter conversations to local threads for sidebar display
      if (convs && convs.length > 0) {
        for (const conv of convs) {
          // 后端可能返回额外字段（id / updated_at）— 用窄接口兼容旧 Conversation
          const convExt = conv as Conversation & { id?: string; updated_at?: string }
          const convId = convExt.id || conv.conversation_id
          const cloudUpdatedAt = convExt.updated_at || conv.created_at || new Date().toISOString()
          const existing = threads.value.find(t => t.id === convId)
          if (!existing) {
            // New thread from remote adapter — add it
            threads.value.push({
              id: convId,
              title: conv.title || t('chat.conversation'),
              messages: [],
              model: '',
              created_at: conv.created_at || new Date().toISOString(),
              updated_at: cloudUpdatedAt,
            })
          } else {
            // Thread exists locally — last-write-wins on metadata
            const localUpdatedAt = existing.updated_at || ''
            if (cloudUpdatedAt > localUpdatedAt) {
              existing.title = conv.title || existing.title
              existing.updated_at = cloudUpdatedAt
              // Note: messages are not fetched in getHistory (only metadata).
              // Full message sync happens in selectThread when the user opens it.
            }
          }
        }
        // Sort by updated_at desc
        threads.value.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
        _persistThreads()
      }
    } catch {
      // offline — use thread list as fallback
    } finally {
      loading.value = false
    }
  }

  async function loadConversation(id: string) {
    loading.value = true
    error.value = null
    try {
      const conv = await chatApi.getConversation(id)
      currentConversationId.value = id
      currentMessages.value = conv.messages
      selectedModel.value = conv.model
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      loading.value = false
    }
  }

  /** Refresh the currently-open thread from the server.
   *  Used by the sim→chat feedback loop: after the server inserts a
   *  `sim_result` message into the DB, we pull the full history and
   *  merge (so the new bubble with `metadata.kind === 'sim_result'`
   *  shows up in the UI).
   *
   *  Locally streaming content is preserved — if a stream is in
   *  progress we skip the refresh to avoid clobbering partial replies. */
  async function refreshCurrentConversation(): Promise<void> {
    const convId = currentConversationId.value
    if (!convId) return
    if (isStreaming.value) return  // avoid clobbering partial stream
    try {
      const conv = await chatApi.getConversation(convId)
      if (conv.messages && conv.messages.length > 0) {
        currentMessages.value = conv.messages
        _syncThreadMessages()
        updateContextUsage()
      }
    } catch (e) {
      console.warn('[chat] refreshCurrentConversation failed:', e)
    }
  }

  function newConversation() {
    stopStreaming()
    currentConversationId.value = null
    currentMessages.value = _injectWelcome()
    streamingReply.value = ''
    error.value = null
  }

  /**
   * Shape of a single SSE chunk the chat stream consumes. Kept loose because
   * both the remote adapter path and the local-agent path feed the same switchboard
   * (see `_ingestChunk`) and not every server/build emits every field.
   */
  type ChatStreamChunk = {
    delta?: string
    done?: boolean
    conversation_id?: string
    usage?: { input_tokens: number; output_tokens: number }
    choices?: Array<{ finish_reason?: string }>
    type?: string
    label?: string
    tool?: string
    // Remote-adapter-to-desktop handoff signal.
    target?: string
    // Agent-native session id captured from the local
    // runtime-wrapper translation of `system/init`. Emitted on the first
    // `message_start` of every spawn; renderer mirrors it onto the active
    // thread so the NEXT cc_start can pass `--resume <id>`.
    cc_session_id?: string
  }

  /**
   * Central chunk switchboard — shared by remote adapter SSE and local agent events.
   *
   * Extracted from the inline `streamMessage` callback so the local agent path
   * (the main process emits events over `cc:stream-event`) can reuse
   * the exact same state transitions. Behaviour is intentionally unchanged
   * from the pre-refactor inline handler.
   */
  /**
   * persist ONE assistant bubble to the remote adapter `messages` table.
   * Agentic turns commit several bubbles (one per tool round, flushed at the
   * cc_status step) and may finish with EMPTY final text, so the old single
   * persist — gated on a non-empty final `streamingReply` — silently dropped
   * every agentic reply (conversations looked empty on reload / second device).
   * We now persist at EACH local commit point. Fresh UUID per bubble; the
   * server's `messages.id` PRIMARY KEY + INSERT OR IGNORE dedupes, so this is
   * safe to call liberally. Best-effort — never blocks the stream.
   */
  function _persistAssistantBubble(convId: string | null | undefined, content: string): void {
    if (!convId || !content || !content.trim()) return
    const mid = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : `m-a-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    try {
      void chatApi.appendMessage(convId, {
        message_id: mid,
        role: 'assistant',
        content,
        model: selectedModel.value,
      }).catch((e: unknown) =>
        console.debug('[chat] appendMessage(assistant) failed (ignored):', e),
      )
    } catch (e) { console.debug('[chat] assistant-msg push threw:', e) }
  }

  /**
   * origin of a stream chunk, so `_ingestChunk` can ROUTE it to
   * the conversation that PRODUCED it instead of blindly dumping into the
   * active view's singleton `streamingReply` (the cross-talk failure mode).
   *
   * `sessionId` is the runtime-wrapper routing id — the ONLY identifier present on
   * EVERY `cc:stream-event` envelope (delta chunks don't carry conversation_id;
   * only message_start/result do — see electron/cc/cc-wrapper.ts::translateEvent).
   * So session-id matching is the primary, reliable router. `convId` (when the
   * chunk happens to carry one, or the remote adapter SSE path) is the secondary signal.
   *
   * Absent (remote adapter SSE path, or legacy callers) → treated as the ACTIVE stream:
   * the remote adapter path has no background-conversation concept and only ever drives
   * the active view, preserving the established behavior.
   */
  interface ChunkSource { sessionId?: string | null; convId?: string | null }

  /**
   * Resolve which Thread a chunk belongs to, and whether that thread is the
   * ACTIVE view or a BACKGROUND (still-generating-while-you-look-elsewhere)
   * conversation. Returns `{ thread: null, isActive: true }` for the remote adapter
   * path / a just-started active stream that hasn't linked a conversation_id
   * yet — the caller then keeps today's active-view behaviour.
   */
  function _resolveChunkTarget(
    chunk: ChatStreamChunk,
    source?: ChunkSource,
  ): { thread: Thread | null; isActive: boolean; orphan: boolean } {
    const srcSession = source?.sessionId ?? null
    const srcConv = source?.convId ?? chunk.conversation_id ?? null

    // 1) Session-id match — the reliable per-chunk router for the local-agent path.
    if (srcSession) {
      // Active session id (the one feeding the live view).
      if (srcSession === _ccSessionId.value) {
        const active = threads.value.find(t => t.id === activeThreadId.value) ?? null
        return { thread: active, isActive: true, orphan: false }
      }
      // A backgrounded thread parked its wrapper id on bgSessionId on switch-away.
      const bg = threads.value.find(t => t.bgSessionId === srcSession && t.isStreaming)
      if (bg) return { thread: bg, isActive: false, orphan: false }
      // The chunk came from a SPECIFIC wrapper session that is neither the
      // active one nor any live background thread. It may still carry a
      // conversation_id that lets us place it (race before the link is set);
      // try that next. If THAT also fails it's a genuine orphan — we must NOT
      // dump it into the active view (that would be 串台 from a stale stream).
      if (!srcConv) return { thread: null, isActive: false, orphan: true }
    }

    // 2) conversation_id match — used by the remote adapter SSE path and as a fallback.
    if (srcConv) {
      if (srcConv === currentConversationId.value) {
        const active = threads.value.find(t => t.id === activeThreadId.value) ?? null
        return { thread: active, isActive: true, orphan: false }
      }
      // A background thread is identified by its own conversation id. Threads
      // synced from remote adapter use their conversation id AS the thread id; a parked
      // local-agent stream stashes it on bgConvId.
      const bg = threads.value.find(
        t => (t.bgConvId === srcConv || t.id === srcConv) && t.id !== activeThreadId.value,
      )
      if (bg) return { thread: bg, isActive: false, orphan: false }
      // A conversation_id we can't place. If it arrived tagged with a wrapper
      // session id (local-agent), it's an orphan (drop). If it came WITHOUT a
      // session id (remote adapter SSE — single active stream by construction), treat it
      // as the active stream just linking its id (Phase-1 behaviour preserved).
      if (srcSession) return { thread: null, isActive: false, orphan: true }
      return { thread: null, isActive: true, orphan: false }
    }

    // 3) No usable source identity at all → active just-started stream (remote adapter
    //    path, or the first chunk of the active local-agent turn before its ids
    //    land — the active session id is captured the moment cc_start returns,
    //    so in practice local-agent chunks always carry a session id here).
    return { thread: null, isActive: true, orphan: false }
  }

  function _ingestChunk(chunk: ChatStreamChunk, source?: ChunkSource): void {
    // ROUTE FIRST. If this chunk was produced by a conversation
    // that is NOT the active view (a second stream still generating in the
    // background), it must never touch the active singletons (streamingReply /
    // ccStatus / todo / streamErrorChunk) — otherwise the two streams' tokens
    // interleave in the active view. Delegate to the per-thread ingester
    // and return. The active-view path below is unchanged.
    const target = _resolveChunkTarget(chunk, source)
    if (!target.isActive && target.thread) {
      _ingestBackgroundChunk(chunk, target.thread)
      return
    }
    if (target.orphan) {
      // A chunk from a wrapper session / conversation we can no longer place
      // (subprocess outlived its thread, or a stale event after switch). Drop
      // it — never let it bleed into the active view. Safe by construction:
      // a finishing orphan stream already committed via its background path.
      console.debug('[chat] dropping orphan stream chunk (no matching thread)', {
        sessionId: source?.sessionId, convId: source?.convId ?? chunk.conversation_id,
      })
      return
    }

    // Handle terminal error chunk before anything else so we can
    // short-circuit into the red-bubble UI without letting a stray
    // `delta` on the same frame get appended as normal text.
    const errInfo = _extractErrorChunk(chunk as unknown as Record<string, unknown>)
    if (errInfo) {
      streamErrorChunk.value = errInfo
      error.value = errInfo.code ? `[${errInfo.code}] ${errInfo.message}` : errInfo.message
      isStreaming.value = false
      streamStartedAt.value = null
      if (streamingReply.value) {
        currentMessages.value.push({ role: 'assistant', content: streamingReply.value })
        _persistAssistantBubble(currentConversationId.value, streamingReply.value)
        streamingReply.value = ''
      }
      sseHandle = null
      return
    }

    // Handle agent status updates (real-time tool progress).
    //
    // Backend emits `{type:'cc_status', tool:'Read', label:'读取文件: foo.py'}`.
    // We pass `tool` to _addTodoItem so ToolIcon can render the
    // matching Lucide SVG. `tool` may be absent on older servers —
    // ToolIcon falls back to the wrench icon in that case.
    if (chunk.type === 'cc_status' && chunk.label) {
      // Flush the text turn that PRECEDED this tool call into its own bubble
      // before showing the step. Without this, every assistant text turn across
      // all tool round-trips accumulates into one streamingReply → one giant
      // merged bubble. This restores the per-turn sequence: the conversation
      // reads [text] · [step] · [text] · [step] instead of one merged blob.
      // Preserve this error-path boundary so tool turns cannot merge into one bubble.
      if (streamingReply.value.trim()) {
        currentMessages.value.push({ role: 'assistant', content: streamingReply.value })
        // Persist this tool-round's text bubble to remote adapter NOW — a later empty
        // final chunk would otherwise skip the gated final persist and lose it.
        _persistAssistantBubble(currentConversationId.value, streamingReply.value)
        streamingReply.value = ''
      }
      ccStatus.value = chunk.label as string
      const toolName = typeof chunk.tool === 'string' ? chunk.tool : undefined
      _addTodoItem(chunk.label as string, toolName)
      return
    }

    if (chunk.delta) {
      streamingReply.value += chunk.delta
    }
    // Choices-style SSE adapters expose delta content in the first choice.
    if (chunk.choices?.[0]) {
      const choice = chunk.choices[0] as { delta?: { content?: string }; finish_reason?: string }
      if (choice.delta?.content) {
        streamingReply.value += choice.delta.content
      }
    }
    if (chunk.conversation_id && !currentConversationId.value) {
      currentConversationId.value = chunk.conversation_id
    }
    // Capture the agent-native resume id from the first stream event and pin the
    // session to the source thread, not the currently visible thread. This branch
    // handles the active source; background streams use `_ingestBackgroundChunk`.
    // Subsequent cc_start calls use `--resume <id>` to preserve runtime continuity;
    // localStorage and the remote adapter keep the value across restarts.
    if (chunk.type === 'message_start' && typeof chunk.cc_session_id === 'string') {
      const newId = chunk.cc_session_id
      // Pin the runtime-native resume id onto the thread that OWNS this session,
      // identified by the conversation id the wrapper echoes back (== the
      // stable thread.conversationId we passed to cc_start). NOT activeThreadId
      // — if the user switched away mid-spawn, the old code pinned THIS
      // session's resume id onto the now-active OTHER thread, so that thread's
      // next send resumed the wrong conversation.
      const ownerThread =
        (chunk.conversation_id ? threads.value.find(t => t.conversationId === chunk.conversation_id) : undefined)
        ?? target.thread
        ?? threads.value.find(t => t.id === activeThreadId.value)
      if (ownerThread && ownerThread.ccSessionId !== newId) {
        ownerThread.ccSessionId = newId
        _persistThreads()
        // Best-effort remote adapter mirror — never block stream on this. Uses the
        // PATCH endpoint added in remote adapter endpoint
        // 404 / 401 / offline → swallowed; localStorage is the source of
        // truth for resume, remote adapter is just multi-device sync. Patch the OWNER
        // conversation, not the active-view global (they differ mid-switch).
        const convId = ownerThread.conversationId ?? chunk.conversation_id ?? currentConversationId.value
        if (convId) {
          void chatApi.patchConversation(convId, { cc_session_id: newId })
            .catch((e: unknown) => console.debug('[chat] patchConversation cc_session_id failed (ignored):', e))
        }
      }
    }
    // Detect stream end: either an explicit done flag or a choices-style finish marker.
    const isFinished = chunk.done ||
      chunk.choices?.[0]?.finish_reason === 'stop'
    if (isFinished) {
      _gotCcDone = true
    }
    if (isFinished && streamingReply.value.trim()) {
      const msg: ChatMessage = { role: 'assistant', content: streamingReply.value }
      // Preserve provider-neutral token counts without hosted pricing.
      if (chunk.usage) {
        msg.token_usage = {
          input_tokens: chunk.usage.input_tokens,
          output_tokens: chunk.usage.output_tokens,
          total_tokens: chunk.usage.input_tokens + chunk.usage.output_tokens,
        } as TokenUsage
      }
      currentMessages.value.push(msg)
      streamingReply.value = ''
      isStreaming.value = false
      streamStartedAt.value = null
      sseHandle = null
      updateContextUsage()
      // Mark all todos complete
      ccTodoList.value.forEach(t => t.done = true)
      ccStatus.value = ''
      _syncThreadMessages()
      _persistAssistantBubble(currentConversationId.value, msg.content)

    } else if (isFinished) {
      // Empty finish — just reset streaming state
      isStreaming.value = false
      streamingReply.value = ''
      streamStartedAt.value = null
      sseHandle = null
    }
  }

  /**
   * Pivot the current turn from remote-adapter SSE to the local agent
   * subprocess (electron/cc/cc-wrapper.ts).
   *
   * Called when remote adapter emits `{type:"mode_switch", target:"local_cc"}` as its
   * final chunk. We're already past the intent gate at this point — the
   * server decided this turn should run locally instead of going through the
   * remote agent adapter (for latency, privacy, or quota reasons).
   *
   * Implementation notes:
   * - remote adapter has already closed its SSE by the time the mode_switch chunk
   *   lands. The caller closes `sseHandle` just before calling us.
   * - `_startLocalCcTurn` is async because `cc_start` spawns a subprocess;
   *   callers fire-and-forget with `void`.
   * - On failure we surface via `streamErrorChunk` so the UI shows a red
   *   bubble instead of a silent dead stream.
   */
  async function _startLocalCcTurn(opts: {
    conversationId: string
    userContent: string
    attachments?: UploadedFileRef[]
    model: string
  }): Promise<void> {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined
    if (!api || typeof api.cc_start !== 'function') {
      streamErrorChunk.value = { message: 'cc_local_not_available: Desktop CC runtime unavailable' }
      error.value = streamErrorChunk.value.message
      isStreaming.value = false
      streamStartedAt.value = null
      return
    }
    try {
      _gotCcDone = false
      // Same resume contract as `_sendViaLocalCc` — the mode_switch path
      // also runs against a known thread, so we pass its ccSessionId if
      // we have one to keep the prompt cache warm.
      // Resume id must come from the thread that OWNS opts.conversationId, NOT
      // whatever thread is visually active (they differ during concurrent
      // streams). Match by the stable conversationId; fall back to the
      // active thread only when this conversation has no thread yet.
      const ownerThread = threads.value.find(t => t.conversationId === opts.conversationId)
        ?? threads.value.find(t => t.id === activeThreadId.value)
      const r = await api.cc_start({
        conversationId: opts.conversationId,
        model: opts.model,
        ccSessionId: ownerThread?.ccSessionId || undefined,
      })
      if (!r?.ok || !r.sessionId) {
        streamErrorChunk.value = { message: `cc_start_failed: ${r?.error ?? 'unknown'}` }
        error.value = streamErrorChunk.value.message
        isStreaming.value = false
        streamStartedAt.value = null
        return
      }
      _ccSessionId.value = r.sessionId
      await api.cc_send_message({
        sessionId: r.sessionId,
        content: opts.userContent,
        attachments: opts.attachments,
      })
    } catch (e) {
      streamErrorChunk.value = {
        message: `cc_start_failed: ${(e as Error)?.message ?? String(e)}`,
      }
      error.value = streamErrorChunk.value.message
      isStreaming.value = false
      streamStartedAt.value = null
    }
  }

  /**
   * decide whether this turn should route through the
   * local Agent CLI subprocess instead of the remote adapter SSE path.
   *
   * Three preconditions, all required:
   *   1. A compatible Agent CLI runtime is explicitly configured and available.
   *   2. `window.electronAPI.cc_start` is exposed by the Electron desktop build.
   *   3. The renderer runtime-availability flag reflects `cc_runtime_status`.
   * A stale executable is handled by cc_start returning `{ok:false}` and the
   * transport fallback path.
   *
   * Returns false for any condition not met — the caller stays on HTTP.
   * Defensive: any exception from the probe is treated as "not available"
   * so an electron-store hiccup or a store-init race can never block chat.
   */
  function _shouldRouteLocalCc(): boolean {
    // The compatible Agent CLI is the canonical local transport when available.
    // Runtime status is authoritative; stale persisted toggles are ignored. The gates are:
    //   1. Electron exposes the cc_start IPC method.
    //   2. Runtime status reports an explicitly configured external or managed executable.
    //   3. A chat-adapter URL is configured for history and HTTP fallback.
    // If any gate fails, the turn stays on the HTTP adapter.
    try {
      const w = typeof window !== 'undefined'
        ? (window as unknown as {
            electronAPI?: { cc_start?: unknown }
            __CC_LOCAL_RUNTIME_AVAILABLE?: boolean
            __AWP_LAB_MODE?: boolean
          })
        : undefined
      if (!w) return false
      if (!w.electronAPI || typeof w.electronAPI.cc_start !== 'function') return false
      // Lab mode uses its explicitly configured transport, so the standard
      // runtime-availability and chat-adapter checks do not apply.
      if (w.__AWP_LAB_MODE === true) return true

      const settings = useSettingsStore()
      if (!settings.serverUrl || typeof settings.serverUrl !== 'string') return false
      return w.__CC_LOCAL_RUNTIME_AVAILABLE === true
    } catch (e) {
      console.warn('[chat] _shouldRouteLocalCc probe failed, staying on HTTP:', e)
      return false
    }
  }

  async function sendMessage(content: string, _taskId?: string) {
    // In-flight guard: during startup, streamingReply can still be empty while
    // isStreaming=true，此时重复 send 会另起一条流，旧流的事件因 session 不匹配
    // 被当作 orphan 丢弃。重复调用一律 no-op。
    if (isStreaming.value) return

    // Capture the request for a possible remote-adapter-to-local-agent handoff.
    _lastSentUserContent = content
    _ccFallbackUsed = false
    _lastSentContentSig = content

    // Add user message
    currentMessages.value.push({ role: 'user', content })
    streamingReply.value = ''
    isStreaming.value = true
    error.value = null
    streamErrorChunk.value = null
    streamStartedAt.value = Date.now()
    _resetTodo()
    updateContextUsage()

    // Update thread title from first user message
    const thread = threads.value.find(t => t.id === activeThreadId.value)
    if (thread && thread.title === t('chat.defaultThreadTitle') && content.length > 0) {
      thread.title = content.slice(0, 30) + (content.length > 30 ? '...' : '')
    }
    if (thread) {
      thread.updated_at = new Date().toISOString()
    }

    // Close any existing stream
    sseHandle?.close()

    // Snapshot + clear pending attachments atomically: the request body
    // carries them once, and the UI chips vanish the instant the user hits
    // send. If the stream errors out we do NOT re-attach — the files are
    // still in the sandbox, so a retry can reference them via path, and
    // auto-reattaching would be surprising UX.
    //
    // JSON-roundtrip strips Vue 3 reactivity (Proxy) so Electron
    // contextBridge structured-clone doesn't choke on
    // ``An object could not be cloned``. pendingAttachments.value is a
    // ref<UploadedFileRef[]>, and a spread keeps each entry as a Proxy.
    // UploadedFileRef is all strings/numbers, so JSON loses nothing.
    const attachmentsToSend = pendingAttachments.value.length > 0
      ? (JSON.parse(JSON.stringify(pendingAttachments.value)) as UploadedFileRef[])
      : undefined
    if (attachmentsToSend) clearAttachments()
    _lastSentAttachments = attachmentsToSend

    // route dispatch.
    //
    // Flag OFF or runtime unavailable → HTTP path (byte-for-byte
    // unchanged). Flag ON + runtime installed → direct local agent subprocess,
    // bypassing remote adapter SSE. Local path has a crash-fallback that replays the
    // same user message over HTTP on subprocess death — see
    // `_sendViaLocalCc`.
    if (_shouldRouteLocalCc()) {
      void _sendViaLocalCc(content, attachmentsToSend)
      return
    }
    _sendViaHttp(content, attachmentsToSend)
  }

  /**
   * Remote-adapter SSE chat path.
   * Extracted from `sendMessage` so `_sendViaLocalCc` can call back into it
   * on mid-flow agent crash. Nothing here has moved byte-for-byte from the
   * previous inline implementation — preserving the regression
   * surface is an explicit requirement.
   *
   * `content` is only used for logging; message content is already pushed
   * onto `currentMessages.value` by the caller. `attachmentsToSend` is the
   * snapshot captured in `sendMessage` before clearing `pendingAttachments`.
   */
  function _sendViaHttp(content: string, attachmentsToSend: UploadedFileRef[] | undefined): void {
    void content  // signature includes it for the fallback path logger.
    // Delta mode: if we already have a conversation_id, only send the last
    // user message instead of the full history (backend loads the rest from DB).
    // For the FIRST message (no conversation_id yet), send full array.
    // Always strip the welcome message — it's a frontend-only UX element.
    const withoutWelcome = currentMessages.value.filter(
      m => !_isWelcomeMessage(m)
    )
    const messagesToSend = currentConversationId.value
      ? [withoutWelcome[withoutWelcome.length - 1]!]
      : withoutWelcome

    // Start SSE streaming (POST with messages in body)
    sseHandle = chatApi.streamMessage(
      selectedModel.value,
      messagesToSend,
      (data) => {
        const chunk = data as ChatStreamChunk

        // The remote adapter requested a local-agent handoff; pivot this turn to
        // the local agent subprocess. Must be checked BEFORE the error
        // extraction path so a normal handoff isn't misread as a crash.
        if (chunk.type === 'mode_switch' && chunk.target === 'local_cc') {
          // Close the remote adapter SSE — it's done; the server won't send a
          // `done` chunk. Resolve conversation id eagerly if present.
          if (sseHandle) { sseHandle.close(); sseHandle = null }
          if (chunk.conversation_id && !currentConversationId.value) {
            currentConversationId.value = chunk.conversation_id
          }
          void _startLocalCcTurn({
            conversationId: currentConversationId.value ?? '',
            userContent: _lastSentUserContent,
            attachments: _lastSentAttachments,
            model: selectedModel.value,
          })
          return
        }

        _ingestChunk(chunk)
      },
      (err) => {
        error.value = err.message
        streamErrorChunk.value = { message: err.message }
        isStreaming.value = false
        streamStartedAt.value = null
        // Preserve partial response if any
        if (streamingReply.value) {
          currentMessages.value.push({ role: 'assistant', content: streamingReply.value })
          streamingReply.value = ''
        }
        sseHandle = null
      },
      currentConversationId.value || undefined,
      (headers: Headers) => {
        // Capture conversation_id from server for subsequent messages in this thread
        const convId = headers.get('X-Conversation-Id')
        if (convId && !currentConversationId.value) {
          currentConversationId.value = convId
        }
      },
      attachmentsToSend,
    )
  }

  /**
   * Route this turn through the local Agent CLI
   * subprocess. Entered when `_shouldRouteLocalCc` passes.
   *
   * Path: `cc_start` → `cc_send_message` → subprocess streams events via
   * `cc:stream-event` (already wired in `_wireCcSubscriptions`) → same
   * `_ingestChunk` switchboard as remote adapter SSE.
   *
   * Crash handling: `_wireCcSubscriptions` listens on `cc:session-exit` and
   * sets `streamErrorChunk` if the subprocess died before `done:true`. Here
   * we also attach a one-shot follow-up: on crash we invoke
   * `_retryViaHttpAfterCcCrash` which replays the user's last message over
   * the HTTP path. The `_ccFallbackUsed` guard permits at most one
   * HTTP-fallback per turn to avoid spinlock if remote adapter is also failing.
   */
  async function _sendViaLocalCc(
    content: string,
    attachmentsToSend: UploadedFileRef[] | undefined,
  ): Promise<void> {
    const electronAPI = typeof window !== 'undefined' ? window.electronAPI : undefined
    // Lab mode: HTTP fallback to remote adapter is pointless — lab APP has no
    // Agent Workflow Platform account / serverUrl / auth token, so _sendViaHttp would 401 and
    // surface a confusing toast. Surface the agent spawn failure directly via
    // the error bubble instead.
    const inLab = (window as unknown as { __AWP_LAB_MODE?: boolean })?.__AWP_LAB_MODE === true
    if (!electronAPI || typeof electronAPI.cc_start !== 'function') {
      if (inLab) {
        streamErrorChunk.value = { message: 'lab mode: electronAPI.cc_start unavailable — Lab APP requires the desktop electron build' }
        error.value = streamErrorChunk.value.message
        // End the in-flight state so the send guard cannot leave the UI stuck.
        isStreaming.value = false
        streamStartedAt.value = null
        return
      }
      // Guard shouldn't fire (we checked before dispatching) but belt-and-
      // braces for race conditions: fall straight through to HTTP.
      _sendViaHttp(content, attachmentsToSend)
      return
    }
    _gotCcDone = false
    // A fresh chat session has currentConversationId = null. We were passing '' to
    // cc_start, which the wrapper guard at cc-wrapper.ts:525 rejects with
    // "invalid_conversation_id" → silent HTTP fallback. Generate a UUID
    // up-front so the local agent turn can actually spawn. The id is assigned
    // back so subsequent turns + history persistence carry it.
    // derive BOTH the conversation id AND the runtime-native
    // resume id from the SAME active thread object, so they can never desync.
    // Previously conversationId came from the floating `currentConversationId`
    // global (nulled on createThread, lazily regenerated here) while resumeId
    // came from `activeThreadId`'s thread — when those two identity sources
    // disagreed (concurrent streams / fast switch), a "new" conversation's
    // cc_start either collided onto an existing `byConv` session OR resumed a
    // different conversation's agent session. One thread therefore owns one stable conversation
    // id = one agent process = one resume id.
    const activeThread = threads.value.find(t => t.id === activeThreadId.value)
    if (!activeThread) {
      console.warn('[chat] _sendViaLocalCc: no active thread; falling back to HTTP')
      if (inLab) {
        streamErrorChunk.value = { message: 'lab mode: no active thread for cc_start' }
        error.value = streamErrorChunk.value.message
        isStreaming.value = false
        streamStartedAt.value = null
        return
      }
      _ccFallbackUsed = true
      _sendViaHttp(content, attachmentsToSend)
      return
    }
    const convId = _ensureConvId(activeThread)
    currentConversationId.value = convId
    const resumeId = activeThread.ccSessionId || undefined
    try {
      const r = await electronAPI.cc_start({
        conversationId: convId,
        model: selectedModel.value,
        ccSessionId: resumeId,
      })
      if (!r?.ok || !r.sessionId) {
        // cc_start itself refused — don't burn the user's turn. Fall back
        // to HTTP immediately; the user never sees the failure (just the
        // normal remote adapter reply arrives a moment later).
        console.warn('[chat] cc_start failed, falling back to HTTP:', r?.error)
        if (inLab) {
          streamErrorChunk.value = { message: `lab cc_start failed: ${r?.error ?? 'unknown'}` }
          error.value = streamErrorChunk.value.message
          isStreaming.value = false
          streamStartedAt.value = null
          return
        }
        _ccFallbackUsed = true
        _sendViaHttp(content, attachmentsToSend)
        return
      }
      _ccSessionId.value = r.sessionId
      // Persist the user message to the remote adapter before handing off to the agent. It
      // is the authoritative cross-device history; the local-agent path
      // otherwise writes only to the configured CLI's private history on
      // the local machine. We push from here (not from `sendMessage`)
      // because only local-agent turns need to push — HTTP adapter turns
      // already trigger the same write server-side via _save_message.
      // Best-effort: failure is logged but never blocks chat.
      try {
        const convId = currentConversationId.value
        if (convId) {
          const mid =
            typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
              ? crypto.randomUUID()
              : `m-u-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
          void chatApi.appendMessage(convId, {
            message_id: mid,
            role: 'user',
            content,
            title_hint: content.slice(0, 80),
          }).catch((e: unknown) =>
            console.debug('[chat] appendMessage(user) failed (ignored):', e),
          )
        }
      } catch (e) { console.debug('[chat] user-msg push threw:', e) }
      await electronAPI.cc_send_message({
        sessionId: r.sessionId,
        content,
        attachments: attachmentsToSend,
      })
    } catch (e) {
      console.warn('[chat] local CC dispatch threw, falling back to HTTP:', e)
      if (inLab) {
        streamErrorChunk.value = { message: `lab cc dispatch threw: ${e instanceof Error ? e.message : String(e)}` }
        error.value = streamErrorChunk.value.message
        isStreaming.value = false
        streamStartedAt.value = null
        return
      }
      _ccFallbackUsed = true
      _sendViaHttp(content, attachmentsToSend)
    }
  }

  /**
   * crash-fallback from local agent → remote adapter HTTP.
   *
   * Called from the `cc:session-exit` handler when the subprocess died
   * before emitting a `done:true` chunk. We only do this ONCE per user
   * message (tracked via `_ccFallbackUsed`) because if remote adapter is also
   * broken, retrying on every crash would pile up duplicate replies.
   *
   * UX contract: the user never loses their typed message. Either the
   * local agent produces a response, or we silently fall over to remote adapter and
   * show a one-line transport-fallback notice to explain the
   * latency blip. The original user bubble stays in place — only the
   * (partial, if any) assistant reply is dropped.
   */
  function _retryViaHttpAfterCcCrash(): void {
    if (_ccFallbackUsed) {
      // Already retried once this turn — give up, let the error bubble
      // stand. Second crash means HTTP path is probably also dying.
      return
    }
    if (!_lastSentContentSig) {
      // No user content captured — nothing to replay.
      return
    }
    _ccFallbackUsed = true
    try {
      const toast = useToastStore()
      toast.warning(t('chat.ccFellBackToAdapter'))
    } catch { /* toast store unavailable — log only */ }
    // Reset the stream state so `_sendViaHttp` starts clean. streamError is
    // cleared too — the HTTP reply overwrites it on success.
    streamErrorChunk.value = null
    error.value = null
    isStreaming.value = true
    streamingReply.value = ''
    streamStartedAt.value = Date.now()
    _sendViaHttp(_lastSentContentSig, _lastSentAttachments)
  }

  // ---- subscribe to local-agent subprocess events ----
  // The main-process runtime wrapper broadcasts `cc:stream-event` with
  // `{sessionId, event}` — we forward only events for the current
  // `_ccSessionId` into the shared `_ingestChunk` switchboard so the UI
  // state transitions are identical to the remote adapter path. `cc:session-exit`
  // surfaces an error bubble if the subprocess died before emitting
  // `done:true`.
  //
  // Subscriptions are wired at store initialization and re-wired on every
  // `onUserChanged` so a logout tears down the listener bound to the old
  // user's session state (prevents leaks) while re-login restores the
  // bridge. Tests assert the unsub is invoked on logout.
  //
  // Feature-detect: pywebview / browser builds have no electronAPI, so we
  // silently skip wiring in those environments.
  let _ccEventUnsub: (() => void) | null = null
  let _ccExitUnsub: (() => void) | null = null

  // minimal ingest for a thread streaming in the BACKGROUND (not
  // the active view). Accumulates text into the thread's own buffer + commits
  // to its messages on done. Skips view-only concerns (cc_status branded steps,
  // inline plots) — switching back shows the combined reply. The active view
  // keeps using the full _ingestChunk.
  function _ingestBackgroundChunk(chunk: ChatStreamChunk, thread: Thread): void {
    if (chunk.type === 'cc_status') {
      // Accumulate the BACKGROUND conversation's task-progress onto ITS thread —
      // NEVER the active global panel (see
      // test_background_stream_chunk_never_touches_active_status_or_todo) — so
      // switching to it shows its real progress, not a frozen snapshot. Mirrors
      // `_addTodoItem`'s mark-prev-done + dedup. View-only; never enters messages.
      const label = typeof chunk.label === 'string' ? chunk.label : ''
      if (label) {
        thread.ccStatus = label
        const list = thread.ccTodoList ? thread.ccTodoList.map(it => ({ ...it })) : []
        if (list.length > 0 && !list[list.length - 1]!.done) list[list.length - 1]!.done = true
        const toolName = typeof chunk.tool === 'string' ? chunk.tool : undefined
        if (!list.some(t => t.label === label && t.tool === toolName)) {
          list.push({ label, done: false, tool: toolName })
        }
        thread.ccTodoList = list
      }
      return // branded step bubbles are view-only
    }
    // capture the runtime-native resume id from THIS background stream's
    // message_start and pin it onto the SOURCE thread's ccSessionId (NOT the
    // active thread — that was the activeThreadId-only bug that the active path
    // had). A turn that started while you were elsewhere still gets a resumable
    // session for its next send. ccSessionId is the --resume id; bgSessionId
    // (the wrapper routing id) is untouched here (set at detach), so we never
    // lose resume continuity again.
    if (chunk.type === 'message_start' && typeof chunk.cc_session_id === 'string') {
      const newId = chunk.cc_session_id
      if (thread.ccSessionId !== newId) {
        thread.ccSessionId = newId
        _persistThreads()
        const convId = thread.bgConvId
        if (convId) {
          void chatApi.patchConversation(convId, { cc_session_id: newId })
            .catch((e: unknown) => console.debug('[chat] bg patchConversation cc_session_id failed (ignored):', e))
        }
      }
      return
    }
    // a terminal error on a background stream: commit whatever text
    // it produced to ITS messages and clear ITS bg flags. NEVER touch the active
    // streamErrorChunk/error — the red bubble belongs to the active view only.
    const bgErr = _extractErrorChunk(chunk as unknown as Record<string, unknown>)
    if (bgErr) {
      const txt = (thread.bgStreamingReply ?? '').trim()
      if (txt) {
        thread.messages = [...thread.messages, { role: 'assistant', content: txt }]
        _persistAssistantBubble(thread.bgConvId, txt)
      }
      thread.bgStreamingReply = ''
      thread.isStreaming = false
      thread.bgSessionId = null
      thread.bgConvId = null
      thread.updated_at = new Date().toISOString()
      _persistThreads()
      return
    }
    if (typeof chunk.delta === 'string') {
      thread.bgStreamingReply = (thread.bgStreamingReply ?? '') + chunk.delta
    } else {
      const choice = chunk.choices?.[0] as { delta?: { content?: string } } | undefined
      if (typeof choice?.delta?.content === 'string') {
        thread.bgStreamingReply = (thread.bgStreamingReply ?? '') + choice.delta.content
      }
    }
    const finished = chunk.done || chunk.choices?.[0]?.finish_reason === 'stop'
    if (finished) {
      const txt = (thread.bgStreamingReply ?? '').trim()
      if (txt) {
        thread.messages = [...thread.messages, { role: 'assistant', content: txt }]
        _persistAssistantBubble(thread.bgConvId, txt)
      }
      thread.bgStreamingReply = ''
      thread.isStreaming = false
      thread.bgSessionId = null
      thread.bgConvId = null
      thread.updated_at = new Date().toISOString()
      _persistThreads()
    }
  }

  // when navigating away from a streaming thread, DON'T cc_stop;
  // freeze the active view's in-progress state onto the thread so its session
  // keeps running in the background (events route to it via _ingestBackgroundChunk)
  // and it's restored on switch-back.
  function _detachActiveStreamToThread(): void {
    if (!isStreaming.value) return
    const cur = threads.value.find(t => t.id === activeThreadId.value)
    if (!cur) return
    cur.isStreaming = true
    cur.bgStreamingReply = streamingReply.value
    // Pin the WRAPPER session id onto bgSessionId so background events route to
    // this thread — NOT onto ccSessionId. ccSessionId is the runtime-native --resume
    // id; overwriting it with the wrapper id loses the conversation on the next
    // send. bgConvId lets a background-finishing turn
    // persist to the right remote adapter conversation.
    if (_ccSessionId.value) cur.bgSessionId = _ccSessionId.value
    cur.bgConvId = currentConversationId.value
  }

  function _wireCcSubscriptions() {
    const electronAPI = typeof window !== 'undefined' ? window.electronAPI : undefined
    if (!electronAPI) return
    if (typeof electronAPI.cc_on_stream_event === 'function') {
      _ccEventUnsub = electronAPI.cc_on_stream_event((payload) => {
        if (!payload) return
        // SINGLE routing chokepoint. Always hand the chunk to
        // `_ingestChunk` WITH its source wrapper session id; `_ingestChunk` ->
        // `_resolveChunkTarget` decides active-view vs background-thread vs
        // orphan. This is the only place agent stream events enter the store, so
        // routing can never diverge between two hand-rolled branches (which is
        // a split handler could otherwise route a background chunk into the active view
        // but `_ingestChunk` itself still wrote the active singletons).
        _ingestChunk(payload.event as ChatStreamChunk, { sessionId: payload.sessionId })
      })
    }
    if (typeof electronAPI.cc_on_session_exit === 'function') {
      _ccExitUnsub = electronAPI.cc_on_session_exit((payload) => {
        if (!payload) return
        if (payload.sessionId !== _ccSessionId.value) {
          // exit for a BACKGROUND thread's session: flush its
          // accumulated reply into its messages so it's there on switch-back,
          // then drop. (mirrors the stream-event background routing above.)
          const bg = threads.value.find(t => t.bgSessionId === payload.sessionId && t.isStreaming)
          if (bg) {
            const txt = (bg.bgStreamingReply ?? '').trim()
            if (txt) {
              bg.messages = [...bg.messages, { role: 'assistant', content: txt }]
              _persistAssistantBubble(bg.bgConvId, txt)
            }
            bg.bgStreamingReply = ''
            bg.isStreaming = false
            bg.bgSessionId = null
            bg.bgConvId = null
            bg.updated_at = new Date().toISOString()
            _persistThreads()
            return
          }
          console.debug('[chat] cc:session-exit for unknown session — ignoring', {
            got: payload.sessionId, expected: _ccSessionId.value,
          })
          return
        }
        const exitedBeforeDone = !_gotCcDone
        if (exitedBeforeDone) {
          const suffix = payload.error ? ` error=${payload.error}` : ''
          streamErrorChunk.value = {
            message: `cc_session_exit_before_done: code=${payload.code}${suffix}`,
          }
          error.value = streamErrorChunk.value.message
        }
        _ccSessionId.value = null
        _gotCcDone = false
        isStreaming.value = false
        streamStartedAt.value = null
        // crash-fallback. Only fires when the
        // local agent path was chosen via the client-side feature flag (we
        // track this via `_lastSentContentSig`) AND the subprocess died
        // before emitting `done:true`. Never on graceful exit.
        if (exitedBeforeDone && _shouldRouteLocalCc() && _lastSentContentSig) {
          _retryViaHttpAfterCcCrash()
        }
      })
    }
  }

  function _teardownCcSubscriptions() {
    if (_ccEventUnsub) {
      try { _ccEventUnsub() } catch { /* noop */ }
      _ccEventUnsub = null
    }
    if (_ccExitUnsub) {
      try { _ccExitUnsub() } catch { /* noop */ }
      _ccExitUnsub = null
    }
  }

  _wireCcSubscriptions()

  /** Sync current messages back to the active thread and persist */
  function _syncThreadMessages() {
    const thread = threads.value.find(t => t.id === activeThreadId.value)
    if (thread) {
      thread.messages = [...currentMessages.value]
      thread.updated_at = new Date().toISOString()
    }
    _persistThreads()
  }

  /** Regenerate last assistant response */
  function regenerateLastResponse() {
    // : 流式进行中不允许重生成 —— 必须在改动消息数组之前拦截，否则下面
    // pop/splice 之后 sendMessage 的 in-flight 守卫 no-op，消息就丢了。
    if (isStreaming.value) return
    // Remove last assistant message
    const msgs = currentMessages.value
    if (msgs.length > 0 && msgs[msgs.length - 1]!.role === 'assistant') {
      msgs.pop()
    }
    // Find last user message to re-send
    const lastUser = [...msgs].reverse().find(m => m.role === 'user')
    if (lastUser) {
      // Remove the user message too since sendMessage will re-add it
      const userIdx = msgs.lastIndexOf(lastUser)
      if (userIdx >= 0) msgs.splice(userIdx, 1)
      sendMessage(lastUser.content)
    }
  }

  function stopStreaming() {
    sseHandle?.close()
    sseHandle = null
    // Also stop the local agent subprocess if one is streaming.
    // We don't rip out the event subscriptions themselves — the bridge stays
    // alive for the next turn — only the session is torn down.
    if (_ccSessionId.value) {
      try {
        const api = typeof window !== 'undefined' ? window.electronAPI : undefined
        if (api && typeof api.cc_stop === 'function') {
          void api.cc_stop({ sessionId: _ccSessionId.value })
        }
      } catch { /* noop */ }
      _ccSessionId.value = null
    }
    _gotCcDone = false
    isStreaming.value = false
    streamStartedAt.value = null
    if (streamingReply.value) {
      currentMessages.value.push({ role: 'assistant', content: streamingReply.value })
      streamingReply.value = ''
    }
  }

  /** Clear the red error bubble (called from UI "dismiss" button). */
  function dismissStreamError() {
    streamErrorChunk.value = null
  }

  async function deleteThread(id: string) {
    const idx = threads.value.findIndex(t => t.id === id)
    if (idx === -1) return
    // Server-side delete first; local-only threads (never synced) tolerate 404.
    try {
      await chatApi.deleteConversation(id)
    } catch (err) {
      const msg = (err as Error)?.message || ''
      if (!/404|not\s*found/i.test(msg)) throw err
    }
    threads.value.splice(idx, 1)
    if (activeThreadId.value === id) {
      if (threads.value.length === 0) {
        createThread()
      } else {
        await selectThread(threads.value[0]!.id)
      }
    }
    _persistThreads()
  }

  function selectModel(modelId: string) {
    selectedModel.value = modelId
  }

  return {
    // State
    models,
    selectedModel,
    conversations,
    currentConversationId,
    currentMessages,
    streamingReply,
    isStreaming,
    loading,
    error,
    ccStatus,
    ccTodoList,
    streamStartedAt,
    streamErrorChunk,
    pendingAttachments,
    // Thread state
    threads,
    activeThreadId,
    // Context usage
    contextUsage,
    contextPercent,
    contextWarning,
    // Computed
    hasModels,
    messageCount,
    // Actions
    fetchModels,
    fetchHistory,
    loadConversation,
    refreshCurrentConversation,
    newConversation,
    sendMessage,
    stopStreaming,
    dismissStreamError,
    selectModel,
    // Thread actions
    createThread,
    selectThread,
    deleteThread,
    regenerateLastResponse,
    // User scoping
    onUserChanged,
    // Chat attachments (uploaded via POST /v1/chat/upload)
    attachUpload,
    removeAttachment,
    clearAttachments,
  }
})
