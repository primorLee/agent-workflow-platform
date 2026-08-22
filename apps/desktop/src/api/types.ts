/** Inline PNG emitted by a runtime tool and rendered inside a chat message. */
export interface InlinePlotImage {
  id: string
  /** Base64-encoded PNG bytes without a data-URL prefix. */
  png_base64: string
  title: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  token_usage?: TokenUsage
  images?: InlinePlotImage[]
  /** Adapter-defined metadata is preserved without imposing a vertical schema. */
  metadata?: Record<string, unknown>
}

export interface ChatModel {
  id: string
  name: string
  provider: string
  description: string
}

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
}

export interface Conversation {
  conversation_id: string
  title: string
  created_at: string
  updated_at?: string
  message_count: number
}

export interface FormField {
  key: string
  label: string
  type: string
  default?: unknown
  options?: { value: string; label: string }[]
  required?: boolean
}

export interface FormSchema {
  fields: FormField[]
}

export interface HealthStatus {
  status: string
  version: string
}

export interface LoginResponse {
  api_key: string
  customer_id: string
}

export interface AnalyticsEvent {
  event_type: string
  payload: Record<string, unknown>
  timestamp: number
}
