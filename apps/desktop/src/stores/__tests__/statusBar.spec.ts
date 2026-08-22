import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useStatusBarStore } from '../statusBar'

describe('useStatusBarStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('initial state: zoom=1, cursor at origin', () => {
    const sb = useStatusBarStore()
    expect(sb.zoom).toBe(1)
    expect(sb.cursorX).toBe(0)
    expect(sb.cursorY).toBe(0)
  })

  it('setZoom() updates zoom level', () => {
    const sb = useStatusBarStore()
    sb.setZoom(2.5)
    expect(sb.zoom).toBe(2.5)
    sb.setZoom(0.25)
    expect(sb.zoom).toBe(0.25)
  })

  it('setCursor() updates X and Y atomically', () => {
    const sb = useStatusBarStore()
    sb.setCursor(100.5, -42.3)
    expect(sb.cursorX).toBe(100.5)
    expect(sb.cursorY).toBe(-42.3)
  })

  it('$reset() restores defaults after mutation', () => {
    const sb = useStatusBarStore()
    sb.setZoom(7)
    sb.setCursor(50, 60)
    sb.$reset()
    expect(sb.zoom).toBe(1)
    expect(sb.cursorX).toBe(0)
    expect(sb.cursorY).toBe(0)
  })

  it('multiple updates are independent', () => {
    const sb = useStatusBarStore()
    sb.setZoom(3)
    expect(sb.cursorX).toBe(0)
    sb.setCursor(1, 2)
    expect(sb.zoom).toBe(3)
  })
})
