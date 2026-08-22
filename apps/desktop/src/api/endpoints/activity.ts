import { api } from '../client'
import { createSSEStream } from '../sse'
import type { ActivityEvent } from '@/types/activity'

export interface ActivityListResponse {
  events: ActivityEvent[]
  count: number
}

export interface PostActivityRequest {
  phase: string
  status?: string
  title: string
  description?: string
  progress?: number
  task_id?: string
  iteration?: number
  metrics?: Array<Record<string, unknown>>
  diagnostics?: Record<string, unknown>
  duration_ms?: number
}

/** Fetch recent activity events */
export async function getActivityEvents(
  limit = 50,
  taskId?: string,
): Promise<ActivityListResponse> {
  const params: Record<string, string> = { limit: String(limit) }
  if (taskId) params.task_id = taskId
  return api.get<ActivityListResponse>('/v1/activity/events', params)
}

/** Post a new activity event */
export async function postActivityEvent(
  body: PostActivityRequest,
): Promise<ActivityEvent> {
  return api.post<ActivityEvent>('/v1/activity/events', body)
}

/** Update an existing activity event */
export async function updateActivityEvent(
  eventId: string,
  body: PostActivityRequest,
): Promise<ActivityEvent> {
  return api.patch<ActivityEvent>(`/v1/activity/events/${eventId}`, body)
}

/** Connect to activity SSE stream */
export function streamActivityEvents(
  onMessage: (event: ActivityEvent | { type: string }) => void,
  onError?: (err: Error) => void,
  taskId?: string,
): { close: () => void } {
  const params = new URLSearchParams()
  if (taskId) params.set('task_id', taskId)
  const qs = params.toString()
  const relativePath = `/v1/activity/stream${qs ? '?' + qs : ''}`
  return createSSEStream(
    api.getBaseUrl(),
    relativePath,
    api.getToken(),
    onMessage as (data: unknown) => void,
    onError,
  )
}
