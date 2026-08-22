/**
 * Chat artifacts store — tracks file artifacts produced by the cloud
 * sandbox (reports, patches, logs, images, and other deliverables.).
 *
 * Backend contract (parallel agent, 2026-04-20):
 *   GET  /v1/chat/artifacts?conversation_id=X  -> { artifacts: ChatArtifact[] }
 *   GET  /v1/chat/artifacts/{id}/download      -> streaming file body
 *
 * Live updates arrive through the activity SSE stream as events with
 * `kind === 'artifact_created'`.
 * We subscribe through `onActivityEvent` to avoid duplicating SSE wiring.
 *
 * NOTE: This store is deliberately separate from `stores/artifact.ts` —
 * that one owns preview-panel UI state, while this store remains generic.
 * panel, while this one is the generic "delivered files" list.
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '@/api/client'
import { onActivityEvent } from '@/stores/activity'
import type { ChatArtifact as UnifiedChatArtifact } from '@/types/artifact'

// A3 architecture-debt (2026-04-20): the artifact shape now lives in
// `types/artifact.ts` as part of the discriminated union. We keep the
// `ChatArtifact` name as a re-export so existing imports keep working.
export type ChatArtifact = UnifiedChatArtifact

/** Narrow a raw activity event to a ChatArtifact shape. Returns `null` if
 *  the event is not an artifact notification. */
function coerceArtifactEvent(evt: Record<string, unknown>): ChatArtifact | null {
  const kind = evt['kind']
  const phase = evt['phase']
  if (kind !== 'artifact_created' && phase !== 'artifact') return null

  const idRaw = evt['artifact_id'] ?? evt['id']
  if (!idRaw) return null
  const id = String(idRaw)

  const filename = (evt['filename'] as string | undefined)
    ?? (evt['title'] as string | undefined)
    ?? '未命名'

  const size = typeof evt['size'] === 'number' ? (evt['size'] as number) : undefined
  const sizeBytes = typeof evt['size_bytes'] === 'number' ? (evt['size_bytes'] as number) : undefined

  const art: ChatArtifact = {
    kind: 'chat',
    id,
    filename,
    sha256: typeof evt['sha256'] === 'string' ? (evt['sha256'] as string) : undefined,
    size,
    size_bytes: sizeBytes,
    content_type: typeof evt['content_type'] === 'string' ? (evt['content_type'] as string) : undefined,
    created_at: (evt['timestamp'] as string | undefined) ?? new Date().toISOString(),
    conversation_id: typeof evt['conversation_id'] === 'string' ? (evt['conversation_id'] as string) : undefined,
    task_id: (evt['task_id'] as string | number | undefined) ?? undefined,
  }
  return art
}

let _listenerInstalled = false

export const useChatArtifactsStore = defineStore('chat_artifacts', () => {
  const items = ref<ChatArtifact[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  /** Filter applied to server-side list + incoming SSE events. `null`
   *  = show all artifacts regardless of conversation. */
  const filterConversationId = ref<string | null>(null)

  const count = computed(() => items.value.length)

  async function load(conversationId?: string): Promise<void> {
    loading.value = true
    error.value = null
    filterConversationId.value = conversationId ?? null
    try {
      const params = conversationId ? { conversation_id: conversationId } : undefined
      // Server may omit the `kind` discriminator on REST payloads — stamp
      // it so downstream `isChatArtifact()` checks work uniformly.
      const res = await api.get<{ artifacts: Array<Omit<ChatArtifact, 'kind'> & { kind?: 'chat' }> }>(
        '/v1/chat/artifacts', params, { silent: true },
      )
      items.value = (res.artifacts ?? []).map(a => ({ ...a, kind: 'chat' as const }))
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }

  /** Push an artifact into the list if not already present (by id).
   *  Respects `filterConversationId` so a stream for conversation A
   *  doesn't clutter the panel while the user is viewing conversation B. */
  function ingest(art: ChatArtifact): void {
    if (filterConversationId.value
        && art.conversation_id
        && art.conversation_id !== filterConversationId.value) {
      return
    }
    if (items.value.some(x => x.id === art.id)) return
    items.value.unshift(art)
  }

  /** Download the artifact as a Blob (Bearer-auth aware) and trigger a
   *  browser save dialog. Falls back to the underlying URL only when
   *  the blob path errors — never exposes the token via query string. */
  async function downloadAndSave(artifact: ChatArtifact): Promise<void> {
    try {
      const blob = await api.getBlob(
        `/v1/chat/artifacts/${encodeURIComponent(artifact.id)}/download`,
        undefined,
        { accept: artifact.content_type || 'application/octet-stream' },
      )
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = (artifact.filename || 'artifact').split('/').pop() || 'artifact'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      // Release after the click has a chance to dispatch.
      setTimeout(() => URL.revokeObjectURL(url), 4000)
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      throw e
    }
  }

  function clear(): void {
    items.value = []
    error.value = null
  }

  // Install the SSE listener exactly once per app lifetime. `onActivityEvent`
  // is module-scoped, so a re-created store (HMR / tests) won't double up.
  if (!_listenerInstalled) {
    _listenerInstalled = true
    onActivityEvent((evt) => {
      const art = coerceArtifactEvent(evt as Record<string, unknown>)
      if (!art) return
      // `this` is not available at module scope — fetch the live store
      // instance on every event. Pinia caches instances per pinia root.
      try {
        const store = useChatArtifactsStore()
        store.ingest(art)
      } catch (err) {
        console.warn('[chat_artifacts] ingest failed:', err)
      }
    })
  }

  return {
    items,
    count,
    loading,
    error,
    filterConversationId,
    load,
    ingest,
    downloadAndSave,
    clear,
  }
})
