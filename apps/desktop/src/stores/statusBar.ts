import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * Shared reactive state for the StatusBar.
 *
 * Workspace views that expose zoom and cursor state should import this
 * store and call the setters to keep the status bar in sync.
 *
 *   const sb = useStatusBarStore()
 *   sb.setZoom(1.5)
 *   sb.setCursor(120.3, 45.7)
 */
export const useStatusBarStore = defineStore('statusBar', () => {
  const zoom = ref(1)
  const cursorX = ref(0)
  const cursorY = ref(0)

  function setZoom(level: number) {
    zoom.value = level
  }

  function setCursor(x: number, y: number) {
    cursorX.value = x
    cursorY.value = y
  }

  function $reset() {
    zoom.value = 1
    cursorX.value = 0
    cursorY.value = 0
  }

  return { zoom, cursorX, cursorY, setZoom, setCursor, $reset }
})
