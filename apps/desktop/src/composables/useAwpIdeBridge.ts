/** Renderer listeners for real desktop MCP events and validated artifact links. */
import { onMounted, onUnmounted } from 'vue'
import { useToastStore } from '@/stores/toast'
import { useArtifactStore } from '@/stores/artifact'

interface AwpIdeApi {
  awp_ide_on_notify_user?: (cb: (payload: {
    message: string
    level: 'info' | 'success' | 'warning' | 'error'
    duration_ms: number
  }) => void) => () => void
  awp_ide_on_focus_artifact?: (cb: (payload: { artifactId: string }) => void) => () => void
}

export function useAwpIdeBridge(): void {
  const toast = useToastStore()
  const artifacts = useArtifactStore()
  const unsubscribers: Array<() => void> = []

  onMounted(() => {
    const api = (window as unknown as { electronAPI?: AwpIdeApi }).electronAPI
    if (!api) return
    if (typeof api.awp_ide_on_notify_user === 'function') {
      unsubscribers.push(api.awp_ide_on_notify_user((payload) => {
        const duration = payload.duration_ms > 0 ? payload.duration_ms : undefined
        toast.show(payload.message, payload.level, duration)
      }))
    }
    if (typeof api.awp_ide_on_focus_artifact === 'function') {
      unsubscribers.push(api.awp_ide_on_focus_artifact(({ artifactId }) => {
        artifacts.focusArtifact(artifactId)
      }))
    }
  })

  onUnmounted(() => {
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
  })
}