import { api } from '../client'
import { createSSEStream } from '../sse'
import type { ChatMessage, ChatModel, Conversation } from '../types'

export async function getModels(): Promise<ChatModel[]> {
  return api.get<ChatModel[]>('/api/chat/models')
}

// All history endpoints use the /v1/ handler stack (cloud/routes/chat.py) —
// legacy /api/chat/history/* on server.py is preserved server-side for old
// clients but reads/writes/deletes MUST hit the same route module to keep
// auth middleware + customer_id scoping consistent.
export async function getHistory(limit?: number, offset?: number): Promise<Conversation[]> {
  const params: Record<string, string> = {}
  if (limit !== undefined) params.limit = String(limit)
  if (offset !== undefined) params.offset = String(offset)
  return api.get<Conversation[]>('/v1/chat/history', params)
}

export async function getConversation(id: string): Promise<{
  messages: ChatMessage[]
  model: string
  updated_at?: string
  // ADR-016 — CC native session id mirrored from desktop; null if this
  // conversation has never been touched by a local-CC turn.
  cc_session_id?: string | null
}> {
  return api.get<{
    messages: ChatMessage[]
    model: string
    updated_at?: string
    cc_session_id?: string | null
  }>(`/v1/chat/history/${id}`)
}

export async function deleteConversation(id: string): Promise<{ deleted: boolean; conversation_id: string }> {
  return api.delete<{ deleted: boolean; conversation_id: string }>(`/v1/chat/history/${id}`)
}

// ADR-016 (2026-05-19) — partial-update a conversation row. Currently the only
// field the renderer mirrors is `cc_session_id` (the CC native session id
// captured from the first message_start of a local-CC turn). Cloud stores it
// in the `conversations.cc_session_id` column so multi-device sync can
// `--resume` the same session.
//
// Best-effort: failure is logged but never blocks chat. localStorage holds
// the canonical copy.
export async function patchConversation(
  id: string,
  patch: { cc_session_id?: string },
): Promise<{ ok: boolean }> {
  return api.patch<{ ok: boolean }>(`/v1/chat/history/${id}`, patch)
}

// ADR-016 follow-up (2026-05-19) — desktop pushes every user message and
// every final assistant reply to the cloud so the conversations + messages
// tables are the authoritative cross-device history. The local-CC chat
// path otherwise persists only to the configured CLI's private history on the
// local machine, which is invisible to support, second devices, and any
// future analytics.
//
// `message_id` is client-minted (crypto.randomUUID()) so retries / re-flush
// of localStorage on a cold start dedupe idempotently at the DB layer
// (INSERT OR IGNORE on (conversation_id, id)).
export async function appendMessage(
  conversationId: string,
  msg: {
    message_id: string
    role: 'user' | 'assistant' | 'system'
    content: string
    model?: string
    created_at?: string  // ISO; server fills if omitted
    title_hint?: string  // first user message: short-form title for the conv row
  },
): Promise<{ ok: boolean; message_id: string; conversation_id: string }> {
  return api.post<{ ok: boolean; message_id: string; conversation_id: string }>(
    `/v1/chat/history/${conversationId}/messages`,
    msg,
  )
}

export function sendMessage(
  model: string,
  messages: ChatMessage[],
  conversationId?: string,
): { close: () => void } {
  const url = `${api.getBaseUrl()}/v1/chat/completions`
  const body = {
    model,
    messages,
    stream: true,
    conversation_id: conversationId || undefined,
  }
  return createSSEStream(api.getBaseUrl(), '/v1/chat/completions', api.getToken(), () => {}, undefined, undefined, {
    method: 'POST',
    body,
  })
}

/**
 * Send message with callbacks — used by the chat store.
 * Uses POST /v1/chat/completions with full messages array in body
 * (replaces GET /api/chat/stream which had URL length limits).
 */
/** Shape of a pre-uploaded file ref attached to a chat completion request.
 *  Mirrors the response of `POST /v1/chat/upload`. The backend stores the
 *  file in the per-conversation sandbox, so we only forward metadata — the
 *  actual bytes are already server-side. */
export interface UploadedFileRef {
  path: string
  filename: string
  size: number
  sandbox_relpath?: string
  sha256?: string
}

export function streamMessage(
  model: string,
  messages: ChatMessage[],
  onMessage: (data: unknown) => void,
  onError?: (err: Error) => void,
  conversationId?: string,
  onHeaders?: (headers: Headers) => void,
  uploadedFiles?: UploadedFileRef[],
): { close: () => void } {
  const url = `${api.getBaseUrl()}/v1/chat/completions`
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    conversation_id: conversationId || undefined,
  }
  if (uploadedFiles && uploadedFiles.length > 0) {
    body.uploaded_files = uploadedFiles
  }
  return createSSEStream(api.getBaseUrl(), '/v1/chat/completions', api.getToken(), onMessage, onError, onHeaders, {
    method: 'POST',
    body,
  })
}
