import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useArtifactStore, type SavedArtifact } from '../artifact'

const fixture: SavedArtifact = {
  id: 'artifact-1',
  uri: 'awp://artifacts/artifact-1',
  local_path: '/workspace/artifacts/result.md',
  name: 'result.md',
  kind: 'document',
  ext: '.md',
  size_bytes: 42,
  saved_at: '2026-01-01T00:00:00.000Z',
}

describe('useArtifactStore', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('starts closed with no saved artifact', () => {
    const store = useArtifactStore()
    expect(store.savedArtifacts).toEqual([])
    expect(store.focusedArtifact).toBeNull()
    expect(store.isOpen).toBe(false)
    expect(store.isMaximized).toBe(false)
  })

  it('adds, focuses, and persists an artifact', () => {
    const store = useArtifactStore()
    store.addArtifact(fixture)
    expect(store.focusedArtifact).toEqual(fixture)
    expect(store.isOpen).toBe(true)
    expect(JSON.parse(localStorage.getItem('awp_saved_artifacts') || '[]')).toEqual([fixture])
  })

  it('replaces duplicate ids and keeps the newest metadata first', () => {
    const store = useArtifactStore()
    store.addArtifact(fixture)
    store.addArtifact({ ...fixture, name: 'renamed.md' })
    expect(store.savedArtifacts).toHaveLength(1)
    expect(store.savedArtifacts[0].name).toBe('renamed.md')
  })

  it('ignores an unknown focus id and resets maximize on close', () => {
    const store = useArtifactStore()
    store.addArtifact(fixture)
    store.focusArtifact('missing')
    expect(store.focusedArtifactId).toBe(fixture.id)
    store.toggleMaximize()
    store.close()
    expect(store.isOpen).toBe(false)
    expect(store.isMaximized).toBe(false)
  })

  it('hydrates saved metadata and can clear it', () => {
    localStorage.setItem('awp_saved_artifacts', JSON.stringify([fixture]))
    setActivePinia(createPinia())
    const store = useArtifactStore()
    expect(store.savedArtifacts).toEqual([fixture])
    store.clearArtifacts()
    expect(store.savedArtifacts).toEqual([])
    expect(localStorage.getItem('awp_saved_artifacts')).toBe('[]')
  })
})