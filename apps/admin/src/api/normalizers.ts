export type JsonRecord = Record<string, unknown>

export interface BrokerSnapshot {
  backend: string
  redisConnected: boolean
  fallbackTriggered: boolean
  lastPingMs: number | null
  lastPingAt: string | null
}

export interface ReadySnapshot {
  status: string
  database: string
  broker: BrokerSnapshot
}

export interface TaskRecord {
  id: string
  tenantId: string | null
  type: string
  status: string
  createdAt: string | null
  updatedAt: string | null
  assignedAgentId: string | null
  deliveredAt: string | null
  responseReceivedAt: string | null
  idempotencyKey: string | null
  error: string | null
  payload: JsonRecord
  result: unknown
}

export interface SessionRecord {
  id: string
  userId: string | null
  type: string
  status: string
  createdAt: string | null
  lastHeartbeat: string | null
  resources: JsonRecord
  metadata: JsonRecord
}

export const DEFAULT_API_URL = 'http://127.0.0.1:8100'

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {}
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

export function normalizeApiBase(input: string): string {
  const candidate = input.trim() || DEFAULT_API_URL
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(candidate)
    ? candidate
    : `http://${candidate}`

  let url: URL
  try {
    url = new URL(withProtocol)
  } catch {
    throw new Error('The API URL is not valid.')
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('The API URL must use HTTP or HTTPS.')
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error('This monitor only sends its development key to a loopback address.')
  }
  if (url.username || url.password) {
    throw new Error('Credentials must not be embedded in the API URL.')
  }

  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

export function normalizeLive(value: unknown): string {
  if (!isRecord(value)) throw new Error('Unexpected liveness response.')
  return asString(value.status, 'unknown')
}

export function normalizeReady(value: unknown): ReadySnapshot {
  if (!isRecord(value)) throw new Error('Unexpected readiness response.')
  const broker = asRecord(value.broker)

  return {
    status: asString(value.status, 'unknown'),
    database: asString(value.database, 'unknown'),
    broker: {
      backend: asString(broker.backend, 'unknown'),
      redisConnected: broker.redis_connected === true,
      fallbackTriggered: broker.fallback_triggered === true,
      lastPingMs: asNullableNumber(broker.last_ping_ms),
      lastPingAt: asNullableString(broker.last_ping_at),
    },
  }
}

export function normalizeTasks(value: unknown): TaskRecord[] {
  if (!Array.isArray(value)) throw new Error('Unexpected tasks response.')

  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`Task ${index + 1} is not an object.`)
    return {
      id: asString(item.id, `missing-task-${index + 1}`),
      tenantId: asNullableString(item.tenant_id),
      type: asString(item.task_type, 'unknown'),
      status: asString(item.status, 'unknown'),
      createdAt: asNullableString(item.created_at),
      updatedAt: asNullableString(item.updated_at),
      assignedAgentId: asNullableString(item.assigned_agent_id),
      deliveredAt: asNullableString(item.delivered_at),
      responseReceivedAt: asNullableString(item.response_received_at),
      idempotencyKey: asNullableString(item.idempotency_key),
      error: asNullableString(item.error),
      payload: asRecord(item.payload),
      result: item.result ?? null,
    }
  })
}

export function normalizeSessions(value: unknown): SessionRecord[] {
  if (!Array.isArray(value)) throw new Error('Unexpected sessions response.')

  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`Session ${index + 1} is not an object.`)
    return {
      id: asString(item.session_id, `missing-session-${index + 1}`),
      userId: asNullableString(item.user_id),
      type: asString(item.session_type, 'unknown'),
      status: asString(item.status, 'unknown'),
      createdAt: asNullableString(item.created_at),
      lastHeartbeat: asNullableString(item.last_heartbeat),
      resources: asRecord(item.resources),
      metadata: asRecord(item.metadata),
    }
  })
}
