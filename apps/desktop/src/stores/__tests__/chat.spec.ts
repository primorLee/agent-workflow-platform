import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '../chat'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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
  streamMessage: vi.fn(() => ({ close: vi.fn() })),
  deleteConversation: vi.fn(async (id: string) => ({ deleted: true, conversation_id: id })),
}))

vi.mock('@/stores/toast', () => ({
  useToastStore: () => ({
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    show: vi.fn(),
  }),
}))

// Mock the shared i18n instance used by the chat store
vi.mock('@/i18n', () => {
  const messages: Record<string, string> = {
    'chat.defaultThreadTitle': '新对话',
    'chat.welcomeMessage': '你好！我是 Agent Workflow Platform，你的工作流助手。',
    'chat.conversation': '对话',
    'chat.unknownError': '未知错误',
    'chat.modelSonnet4': '均衡型：速度与智能兼顾',
    'chat.modelOpus4': '旗舰型：最强推理能力',
    'chat.modelHaiku35': '轻量型：快速响应',
  }
  const tFn = (key: string, params?: Record<string, unknown>) => {
    let msg = messages[key] || key
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        msg = msg.replace(`{${k}}`, String(v))
      }
    }
    return msg
  }
  return {
    default: { global: { t: tFn } },
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useChatStore', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  // ---------- 1. Initial state with default thread ----------

  it('initializes with one default thread', () => {
    const chat = useChatStore()
    expect(chat.threads.length).toBeGreaterThanOrEqual(1)
    expect(chat.threads[0]!.id).toMatch(/^thread-\d+$/)
    expect(chat.activeThreadId).toBe(chat.threads[0]!.id)
  })

  it('default thread has welcome message', () => {
    const chat = useChatStore()
    expect(chat.threads[0]!.messages.length).toBe(1)
    expect(chat.threads[0]!.messages[0]!.role).toBe('assistant')
    expect(chat.threads[0]!.messages[0]!.content).toContain('Agent Workflow Platform')
  })

  // ---------- 2. createThread ----------

  it('createThread returns new thread and prepends to threads', () => {
    const chat = useChatStore()
    const beforeCount = chat.threads.length
    chat.createThread()
    expect(chat.threads.length).toBe(beforeCount + 1)
    // Newest thread is at index 0 (unshift)
    expect(chat.threads[0]!.title).toBe('新对话')
    expect(chat.activeThreadId).toBe(chat.threads[0]!.id)
  })

  it('createThread assigns sequential thread IDs', () => {
    const chat = useChatStore()
    chat.createThread()
    chat.createThread()
    // All IDs should match thread-N pattern and be unique
    const ids = chat.threads.map(t => t.id)
    const unique = new Set(ids)
    expect(unique.size).toBe(ids.length)
    ids.forEach(id => expect(id).toMatch(/^thread-\d+$/))
  })

  // ---------- 3. deleteThread ----------

  it('deleteThread removes the specified thread', async () => {
    const chat = useChatStore()
    chat.createThread()
    const allIds = chat.threads.map(t => t.id)
    const toDelete = allIds[1]! // Delete the second thread
    await chat.deleteThread(toDelete)
    expect(chat.threads.find(t => t.id === toDelete)).toBeUndefined()
  })

  it('deleteThread switches to first remaining thread if active is deleted', async () => {
    const chat = useChatStore()
    chat.createThread()
    const activeId = chat.activeThreadId
    // Delete the active thread
    await chat.deleteThread(activeId)
    // Should auto-switch to another thread
    expect(chat.activeThreadId).not.toBe(activeId)
    expect(chat.threads.length).toBeGreaterThanOrEqual(1)
  })

  it('deleteThread creates new thread if all threads deleted', async () => {
    const chat = useChatStore()
    // Delete all threads one by one
    const ids = [...chat.threads.map(t => t.id)]
    for (const id of ids) {
      await chat.deleteThread(id)
    }
    // Should have auto-created a new thread
    expect(chat.threads.length).toBeGreaterThanOrEqual(1)
  })

  // ---------- 4. currentMessages getter ----------

  it('currentMessages reflects active thread messages', () => {
    const chat = useChatStore()
    // currentMessages should match the first thread's messages
    expect(chat.currentMessages.length).toBe(chat.threads[0]!.messages.length)
    expect(chat.currentMessages[0]!.content).toBe(chat.threads[0]!.messages[0]!.content)
  })

  // ---------- 5. sendMessage adds user message ----------

  it('sendMessage pushes user message to currentMessages', () => {
    const chat = useChatStore()
    const beforeCount = chat.currentMessages.length
    chat.sendMessage('inspect a failed deployment')
    expect(chat.currentMessages.length).toBe(beforeCount + 1)
    const lastMsg = chat.currentMessages[chat.currentMessages.length - 1]!
    expect(lastMsg.role).toBe('user')
    expect(lastMsg.content).toBe('inspect a failed deployment')
  })

  it('sendMessage updates thread title from first user message', () => {
    const chat = useChatStore()
    chat.sendMessage('review a failed workflow')
    const thread = chat.threads.find(t => t.id === chat.activeThreadId)!
    expect(thread.title).toBe('review a failed workflow')
  })

  // ---------- 6. Persistence to localStorage ----------

  it('threads persist to localStorage keyed by customer_id', () => {
    localStorage.setItem('awp_customer_id', 'test-cust-001')
    // Re-create pinia to trigger fresh store init with customer_id in localStorage
    setActivePinia(createPinia())
    const chat = useChatStore()
    chat.createThread()
    // Check that data was written to the correct key
    const key = 'awp_threads_test-cust-001'
    const raw = localStorage.getItem(key)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBe(chat.threads.length)
  })

  it('falls back to global key when no customer_id', () => {
    // No customer_id in localStorage
    setActivePinia(createPinia())
    const chat = useChatStore()
    chat.createThread()
    const raw = localStorage.getItem('awp_threads')
    expect(raw).not.toBeNull()
  })

  // ---------- 7. onUserChanged reloads threads ----------

  it('onUserChanged clears and reloads threads for new customer', () => {
    const chat = useChatStore()
    // Add some messages
    chat.sendMessage('hello')
    chat.sendMessage('world')
    expect(chat.currentMessages.length).toBeGreaterThan(1)

    // Switch user
    localStorage.setItem('awp_customer_id', 'new-cust-002')
    chat.onUserChanged()

    // Should reset to fresh threads for the new user
    expect(chat.threads.length).toBeGreaterThanOrEqual(1)
    expect(chat.activeThreadId).toBe(chat.threads[0]!.id)
    // Old messages should be gone (fresh thread has only welcome)
    expect(chat.currentMessages.length).toBe(1)
    expect(chat.currentMessages[0]!.role).toBe('assistant')
  })

  // ---------- 8. Message truncation to 100 per thread ----------

  it('persistence truncates to last 100 messages per thread', () => {
    localStorage.setItem('awp_customer_id', 'trunc-cust')
    setActivePinia(createPinia())
    const chat = useChatStore()
    // Pump 120 messages into the thread
    for (let i = 0; i < 120; i++) {
      chat.currentMessages.push({ role: 'user', content: `msg-${i}` })
    }
    // Force persist
    chat.createThread() // triggers _persistThreads via createThread

    const raw = localStorage.getItem('awp_threads_trunc-cust')!
    const parsed = JSON.parse(raw) as Array<{ messages: unknown[] }>
    // Find the old thread (now at index 1 because createThread unshifts)
    const oldThread = parsed.find(t => (t as any).messages.length > 1)
    if (oldThread) {
      expect(oldThread.messages.length).toBeLessThanOrEqual(100)
    }
  })

  // ---------- 9. messageCount computed ----------

  it('messageCount reflects currentMessages length', () => {
    const chat = useChatStore()
    expect(chat.messageCount).toBe(chat.currentMessages.length)
    chat.sendMessage('test message')
    expect(chat.messageCount).toBe(chat.currentMessages.length)
  })

  // ---------- 10. selectModel ----------

  it('selectModel updates selectedModel', () => {
    const chat = useChatStore()
    chat.selectModel('agent-model-v1')
    expect(chat.selectedModel).toBe('agent-model-v1')
  })

  // ---------- 11. newConversation resets state ----------

  it('newConversation resets messages to welcome', () => {
    const chat = useChatStore()
    chat.sendMessage('hello')
    chat.sendMessage('world')
    expect(chat.currentMessages.length).toBeGreaterThan(1)
    chat.newConversation()
    expect(chat.currentMessages.length).toBe(1)
    expect(chat.currentMessages[0]!.role).toBe('assistant')
    expect(chat.currentConversationId).toBeNull()
    expect(chat.streamingReply).toBe('')
    expect(chat.error).toBeNull()
  })

  // ---------- 12. isStreaming / stopStreaming ----------

  it('sendMessage sets isStreaming=true', () => {
    const chat = useChatStore()
    chat.sendMessage('test streaming')
    expect(chat.isStreaming).toBe(true)
  })

  it('stopStreaming resets isStreaming to false', () => {
    const chat = useChatStore()
    chat.sendMessage('test')
    expect(chat.isStreaming).toBe(true)
    chat.stopStreaming()
    expect(chat.isStreaming).toBe(false)
  })

  // ---------- 13. MAX_PERSISTED_THREADS limit ----------

  it('persists at most 50 threads', () => {
    localStorage.setItem('awp_customer_id', 'max-threads-cust')
    setActivePinia(createPinia())
    const chat = useChatStore()
    for (let i = 0; i < 55; i++) {
      chat.createThread()
    }
    const raw = localStorage.getItem('awp_threads_max-threads-cust')!
    const parsed = JSON.parse(raw) as unknown[]
    expect(parsed.length).toBeLessThanOrEqual(50)
  })

  // ---------- 15. thread loads from localStorage on init ----------

  it('restores threads from localStorage on store init', () => {
    const saved = [
      {
        id: 'thread-42',
        title: 'Saved conversation',
        messages: [{ role: 'user', content: 'hello from saved' }],
        model: 'agent-fixture',
        created_at: '2026-04-01T00:00:00Z',
        updated_at: '2026-04-01T00:00:00Z',
      },
    ]
    localStorage.setItem('awp_threads', JSON.stringify(saved))

    setActivePinia(createPinia())
    const chat = useChatStore()
    expect(chat.threads.length).toBe(1)
    expect(chat.threads[0]!.id).toBe('thread-42')
    expect(chat.threads[0]!.title).toBe('Saved conversation')
    expect(chat.currentMessages[0]!.content).toBe('hello from saved')
  })
})
