import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

export interface SavedArtifact {
  id: string
  uri: string
  local_path: string
  name: string
  kind: string
  description?: string
  ext: string
  size_bytes: number
  saved_at: string
}

const STORAGE_KEY = 'awp_saved_artifacts'

function readSavedArtifacts(): SavedArtifact[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.id === 'string') : []
  } catch {
    return []
  }
}

export const useArtifactStore = defineStore('artifact', () => {
  const savedArtifacts = ref<SavedArtifact[]>(readSavedArtifacts())
  const focusedArtifactId = ref<string | null>(null)
  const isOpen = ref(false)
  const isMaximized = ref(false)
  const focusedArtifact = computed(() =>
    savedArtifacts.value.find((artifact) => artifact.id === focusedArtifactId.value) ?? null,
  )

  function persist(): void {
    try {
      // Keep the latest 100 metadata entries. Files stay under Electron userData.
      localStorage.setItem(STORAGE_KEY, JSON.stringify(savedArtifacts.value.slice(0, 100)))
    } catch { /* localStorage may be unavailable */ }
  }

  function open(): void {
    isOpen.value = true
  }

  function close(): void {
    isOpen.value = false
    isMaximized.value = false
  }

  function toggleMaximize(): void {
    isMaximized.value = !isMaximized.value
  }

  function addArtifact(artifact: SavedArtifact): void {
    savedArtifacts.value = [
      artifact,
      ...savedArtifacts.value.filter((existing) => existing.id !== artifact.id),
    ].slice(0, 100)
    focusedArtifactId.value = artifact.id
    isOpen.value = true
    persist()
  }

  function focusArtifact(id: string): void {
    if (!savedArtifacts.value.some((artifact) => artifact.id === id)) return
    focusedArtifactId.value = id
    isOpen.value = true
  }

  function clearArtifacts(): void {
    savedArtifacts.value = []
    focusedArtifactId.value = null
    persist()
  }

  return {
    savedArtifacts,
    focusedArtifactId,
    focusedArtifact,
    isOpen,
    isMaximized,
    open,
    close,
    toggleMaximize,
    addArtifact,
    focusArtifact,
    clearArtifacts,
  }
})