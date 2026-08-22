import { onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useChatStore } from '@/stores/chat'

/** Navigation shortcuts: Ctrl+Number → route */
const NAV_SHORTCUTS: Record<string, string> = {
  '1': '/',
  '3': '/settings',
  '4': '/about',
}

export interface ShortcutHandler {
  /** Human-readable description */
  description: string
  /** The handler function */
  handler: (e: KeyboardEvent) => void
}

/**
 * Context-specific shortcut registries.
 * Editor views call `registerShortcuts(context, map)` on mount
 * and `unregisterShortcuts(context)` on unmount.
 */
const contextHandlers = new Map<string, Map<string, ShortcutHandler>>()

export function registerShortcuts(context: string, shortcuts: Map<string, ShortcutHandler>) {
  contextHandlers.set(context, shortcuts)
}

export function unregisterShortcuts(context: string) {
  contextHandlers.delete(context)
}

/**
 * Normalize a KeyboardEvent to a canonical key string.
 * Examples: "Ctrl+S", "Shift+R", "Delete", "+", "?"
 */
function eventToKey(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.shiftKey) parts.push('Shift')
  if (e.altKey) parts.push('Alt')

  let key = e.key
  // Normalize common variants
  if (key === ' ') key = 'Space'
  if (key === 'Escape') key = 'Escape'
  if (key.length === 1) key = key.toUpperCase()

  // Avoid duplicating modifier name in the key part
  if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
    parts.push(key)
  }

  return parts.join('+')
}

export function useKeyboardShortcuts() {
  const router = useRouter()
  const chatStore = useChatStore()

  function handleKeydown(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName
    const isEditable =
      tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
      (e.target as HTMLElement)?.isContentEditable

    // --- Navigation: Ctrl+Number (always active, even in inputs) ---
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      const path = NAV_SHORTCUTS[e.key]
      if (path) {
        e.preventDefault()
        router.push(path)
        return
      }
    }

    // --- Global: Ctrl+N / Cmd+N → new chat thread ---
    // Always active (including inputs) so the shortcut feels identical to
    // VS Code / Slack / Notion "New ___". Matches the `K` badge on the
    // sidebar "New Thread" button (v1.7 UI refresh).
    // Electron's renderer captures Ctrl+N before the browser-native
    // "new window" handler (there is no default application menu — see
    // `Menu.setApplicationMenu(null)` in `electron/main.ts`), so
    // preventDefault here is sufficient to suppress any fallback.
    if (
      (e.ctrlKey || e.metaKey) &&
      !e.shiftKey &&
      !e.altKey &&
      (e.key === 'n' || e.key === 'N')
    ) {
      e.preventDefault()
      chatStore.createThread()
      // Mirror the sidebar button: if the user fires Ctrl+N from Settings /
      // VM ops / Optimization views, navigate to chat so the new thread
      // becomes visible. Without this the thread is created silently and
      // the keybind appears broken (bug reported 2026-05-19).
      if (router.currentRoute.value.name !== 'chat') {
        void router.push({ name: 'chat' })
      }
      return
    }

    // Don't fire single-key shortcuts in editable fields
    if (isEditable) return

    // --- Context shortcuts ---
    const combo = eventToKey(e)
    for (const handlers of contextHandlers.values()) {
      const entry = handlers.get(combo)
      if (entry) {
        e.preventDefault()
        entry.handler(e)
        return
      }
    }
  }

  onMounted(() => {
    window.addEventListener('keydown', handleKeydown)
  })

  onUnmounted(() => {
    window.removeEventListener('keydown', handleKeydown)
  })
}
