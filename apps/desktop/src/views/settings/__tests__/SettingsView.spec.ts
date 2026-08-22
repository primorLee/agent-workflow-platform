import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'

const apiGet = vi.hoisted(() => vi.fn())
const apiSetBaseUrl = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({
  api: {
    get: apiGet,
    setBaseUrl: apiSetBaseUrl,
  },
}))

vi.mock('@/views/settings/CcRuntimeSection.vue', () => ({
  default: { template: '<div data-testid="runtime-stub" />' },
}))
vi.mock('@/views/settings/AppUpdateSection.vue', () => ({
  default: { template: '<div data-testid="update-stub" />' },
}))

describe('SettingsView chat adapter contract', () => {
  let container: HTMLElement
  let unmount: (() => void) | undefined

  beforeEach(() => {
    localStorage.clear()
    apiGet.mockReset()
    apiSetBaseUrl.mockReset()
    apiGet.mockResolvedValue({ status: 'ok', version: 'demo' })
  })

  afterEach(() => {
    unmount?.()
    container?.remove()
  })

  it('labels the renderer URL as a chat adapter and probes its real health route', async () => {
    const { default: SettingsView } = await import('../../SettingsView.vue')
    const app = createApp(SettingsView)
    app.use(createPinia())
    app.config.globalProperties.__APP_VERSION__ = '0.1.0-test'
    app.use(createI18n({
      legacy: false,
      locale: 'en',
      messages: { en: {} },
      missingWarn: false,
      fallbackWarn: false,
    }))

    container = document.createElement('div')
    document.body.appendChild(container)
    app.mount(container)
    unmount = () => app.unmount()

    await nextTick()
    await Promise.resolve()
    await nextTick()

    const input = container.querySelector<HTMLInputElement>('#chat-adapter-url')
    expect(input).not.toBeNull()
    expect(input?.placeholder).toBe('http://127.0.0.1:8787')
    expect(container.textContent).toMatch(/Chat adapter|聊天适配器/)

    const testButton = input?.parentElement?.querySelector<HTMLButtonElement>('button')
    expect(testButton).not.toBeNull()
    testButton?.click()
    await Promise.resolve()
    await nextTick()

    expect(apiSetBaseUrl).toHaveBeenLastCalledWith('http://127.0.0.1:8787')
    expect(apiGet).toHaveBeenCalledWith('/api/health')
  })

  it('does not send a health request when the typed origin is rejected', async () => {
    const { default: SettingsView } = await import('../../SettingsView.vue')
    const app = createApp(SettingsView)
    app.use(createPinia())
    app.config.globalProperties.__APP_VERSION__ = '0.1.0-test'
    app.use(createI18n({
      legacy: false,
      locale: 'en',
      messages: { en: {} },
      missingWarn: false,
      fallbackWarn: false,
    }))

    container = document.createElement('div')
    document.body.appendChild(container)
    app.mount(container)
    unmount = () => app.unmount()
    await nextTick()
    await Promise.resolve()

    const input = container.querySelector<HTMLInputElement>('#chat-adapter-url')!
    input.value = 'http://example.test'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    apiSetBaseUrl.mockImplementationOnce(() => { throw new Error('invalid_service_base') })

    input.parentElement?.querySelector<HTMLButtonElement>('button')?.click()
    await Promise.resolve()
    await nextTick()

    expect(apiGet).not.toHaveBeenCalled()
    expect(container.textContent).toContain('invalid_service_base')
  })})