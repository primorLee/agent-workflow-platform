import { computed, reactive, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'

import {
  createControlPlaneClient,
  loadConnection,
  type ControlPlaneClient,
  type HealthSnapshot,
} from '@/api/controlPlane'
import type { SessionRecord, TaskRecord } from '@/api/normalizers'

type Resource = 'health' | 'tasks' | 'sessions'

type ResourceState<T> = Record<Resource, T>

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown monitor error.'
}

export const useMonitorStore = defineStore('monitor', () => {
  const client = shallowRef<ControlPlaneClient | null>(null)
  const health = ref<HealthSnapshot | null>(null)
  const tasks = ref<TaskRecord[]>([])
  const sessions = ref<SessionRecord[]>([])
  const selectedTaskId = ref<string | null>(null)
  const lastUpdatedAt = ref<Date | null>(null)
  const hasLoaded = ref(false)

  const pending = reactive<ResourceState<boolean>>({
    health: false,
    tasks: false,
    sessions: false,
  })
  const errors = reactive<ResourceState<string | null>>({
    health: null,
    tasks: null,
    sessions: null,
  })

  const refreshing = computed(() => pending.health || pending.tasks || pending.sessions)
  const selectedTask = computed(() =>
    tasks.value.find((task) => task.id === selectedTaskId.value) ?? null,
  )
  const taskCounts = computed(() => {
    const counts: Record<string, number> = { total: tasks.value.length }
    for (const task of tasks.value) counts[task.status] = (counts[task.status] || 0) + 1
    return counts
  })

  function initialize(): boolean {
    const settings = loadConnection()
    if (!settings) return false
    client.value = createControlPlaneClient(settings)
    return true
  }

  function requireClient(): ControlPlaneClient {
    if (!client.value && !initialize()) throw new Error('Connect to the local control plane first.')
    return client.value as ControlPlaneClient
  }

  async function refreshHealth(): Promise<void> {
    pending.health = true
    errors.health = null
    try {
      health.value = await requireClient().health()
    } catch (error) {
      errors.health = errorMessage(error)
    } finally {
      pending.health = false
    }
  }

  async function refreshTasks(): Promise<void> {
    pending.tasks = true
    errors.tasks = null
    try {
      tasks.value = await requireClient().tasks()
      if (selectedTaskId.value && !tasks.value.some((task) => task.id === selectedTaskId.value)) {
        selectedTaskId.value = null
      }
    } catch (error) {
      errors.tasks = errorMessage(error)
    } finally {
      pending.tasks = false
    }
  }

  async function refreshSessions(): Promise<void> {
    pending.sessions = true
    errors.sessions = null
    try {
      sessions.value = await requireClient().sessions()
    } catch (error) {
      errors.sessions = errorMessage(error)
    } finally {
      pending.sessions = false
    }
  }

  async function refreshAll(): Promise<void> {
    await Promise.all([refreshHealth(), refreshTasks(), refreshSessions()])
    hasLoaded.value = true
    lastUpdatedAt.value = new Date()
  }

  function selectTask(taskId: string | null): void {
    selectedTaskId.value = taskId
  }

  function reset(): void {
    client.value = null
    health.value = null
    tasks.value = []
    sessions.value = []
    selectedTaskId.value = null
    lastUpdatedAt.value = null
    hasLoaded.value = false
    errors.health = null
    errors.tasks = null
    errors.sessions = null
  }

  return {
    health,
    tasks,
    sessions,
    pending,
    errors,
    refreshing,
    selectedTask,
    selectedTaskId,
    taskCounts,
    lastUpdatedAt,
    hasLoaded,
    initialize,
    refreshAll,
    refreshHealth,
    refreshTasks,
    refreshSessions,
    selectTask,
    reset,
  }
})
