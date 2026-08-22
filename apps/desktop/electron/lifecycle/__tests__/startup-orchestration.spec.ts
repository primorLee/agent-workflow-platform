import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { startDesktopUi } from '../startup-orchestration'

describe('desktop startup orchestration', () => {
  it('keeps the production main wiring non-blocking', () => {
    const mainSource = readFileSync(resolve(process.cwd(), 'electron', 'main.ts'), 'utf-8')
    expect(mainSource).toMatch(/startDesktopUi\(\{[\s\S]*createWindow,[\s\S]*startOptionalServices: startServices,/u)
    expect(mainSource).not.toMatch(/await\s+startServices\s*\(/u)
  })

  it('creates the window without waiting for optional services to settle', async () => {
    let releaseServices!: () => void
    const pendingServices = new Promise<void>((resolve) => {
      releaseServices = resolve
    })
    const events: string[] = []
    const createWindow = vi.fn(() => events.push('window'))
    const startOptionalServices = vi.fn(async () => {
      events.push('services')
      await pendingServices
    })
    const onOptionalServiceError = vi.fn()

    startDesktopUi({ createWindow, startOptionalServices, onOptionalServiceError })

    expect(createWindow).toHaveBeenCalledOnce()
    expect(events).toEqual(['window'])
    await Promise.resolve()
    expect(startOptionalServices).toHaveBeenCalledOnce()
    expect(events).toEqual(['window', 'services'])
    expect(onOptionalServiceError).not.toHaveBeenCalled()

    releaseServices()
    await Promise.resolve()
  })

  it('contains optional service failures after the window is created', async () => {
    const failure = new Error('optional service failed')
    const events: string[] = []
    const onOptionalServiceError = vi.fn(() => events.push('handled'))

    startDesktopUi({
      createWindow: () => events.push('window'),
      startOptionalServices: async () => {
        events.push('services')
        throw failure
      },
      onOptionalServiceError,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(events).toEqual(['window', 'services', 'handled'])
    expect(onOptionalServiceError).toHaveBeenCalledWith(failure)
  })
})