/**
 * CcRuntimeSection — unit tests for the ADR-012 Phase 2 CC runtime panel
 * (task T-A035).
 *
 * What we guard:
 *   1. When the IPC is exposed (window.electronAPI.cc_runtime_status), the
 *      section mounts, fetches status once, and renders the current version.
 *   2. Clicking "check now" invokes cc_runtime_check_now AND re-fetches
 *      status so the timestamp reflects the post-update state.
 *   3. updating=true keeps the button disabled (prevents double-triggering
 *      npm install).
 *   4. When the IPC is missing, the section short-circuits to nothing —
 *      no placeholder, no error. This is the graceful-degradation path
 *      hit by pywebview and the browser dev harness.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'

import zhCN from '@/locales/zh-CN.json'

// LoadingSpinner pulls in nothing interesting, but we stub it anyway so a
// missing asset wouldn't take this suite down.
vi.mock('@/components/common/LoadingSpinner.vue', () => ({
  default: defineComponent({
    props: ['size'],
    render: () => h('span', { 'data-testid': 'spinner-stub' }),
  }),
}))

interface MountResult {
  container: HTMLElement
  unmount: () => void
}

async function mountSection(): Promise<MountResult> {
  const { default: CcRuntimeSection } = await import('../CcRuntimeSection.vue')
  const app = createApp(CcRuntimeSection)
  const i18n = createI18n({
    legacy: false,
    locale: 'zh-CN',
    messages: { 'zh-CN': zhCN },
    missingWarn: false,
    fallbackWarn: false,
  })
  app.use(i18n)

  const container = document.createElement('div')
  document.body.appendChild(container)
  app.mount(container)

  // Let onMounted's async fetchStatus settle.
  await nextTick()
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
  await nextTick()

  return {
    container,
    unmount: () => {
      app.unmount()
      container.remove()
    },
  }
}

function setElectronAPI(api: Record<string, unknown> | undefined): void {
  // happy-dom exposes `window` as a mutable global. We assign a fresh
  // `electronAPI` shim per test.
  const w = window as unknown as { electronAPI?: Record<string, unknown> }
  if (api === undefined) {
    delete w.electronAPI
  } else {
    w.electronAPI = api
  }
}

describe('CcRuntimeSection', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    setElectronAPI(undefined)
  })

  it('hides itself when the cc_runtime IPC is missing (graceful degradation)', async () => {
    // No electronAPI on window — emulates pywebview / browser dev harness.
    setElectronAPI(undefined)
    const { container, unmount } = await mountSection()

    expect(
      container.querySelector('[data-testid="cc-runtime-section"]'),
    ).toBeNull()
    // The component's root is expected to be a comment / empty — no visible
    // section at all.
    unmount()
  })

  it('renders currentVersion and timestamps after mount', async () => {
    const now = Date.now()
    const status = {
      currentVersion: '1.2.3',
      lastCheckMs: now - 3 * 60 * 1000, // 3 minutes ago
      lastUpdateMs: 0, // never
      updating: false,
      available: true,
      source: 'external',
    }
    const cc_runtime_status = vi.fn(async () => status)
    const cc_runtime_check_now = vi.fn(async () => ({ updated: false }))

    setElectronAPI({ cc_runtime_status, cc_runtime_check_now })

    const { container, unmount } = await mountSection()

    expect(
      container.querySelector('[data-testid="cc-runtime-section"]'),
    ).not.toBeNull()

    const ver = container.querySelector<HTMLElement>(
      '[data-testid="cc-runtime-current-version"]',
    )
    expect(ver?.textContent?.trim()).toBe('1.2.3')

    // onMounted must have fetched status exactly once.
    expect(cc_runtime_status).toHaveBeenCalledTimes(1)

    // "last update = never" falls back to the i18n "never" string.
    const lastUpdate = container.querySelector<HTMLElement>(
      '[data-testid="cc-runtime-last-update"]',
    )
    expect(lastUpdate?.textContent?.trim()).toBe('尚未检查')

    unmount()
  })

  it('click "check now" invokes check_now and re-fetches status', async () => {
    const cc_runtime_status = vi
      .fn()
      // First call — onMounted.
      .mockResolvedValueOnce({
        currentVersion: '1.2.3',
        lastCheckMs: 0,
        lastUpdateMs: 0,
        updating: false,
        available: true,
        source: 'managed',
      })
      // Second call — after check_now resolved.
      .mockResolvedValueOnce({
        currentVersion: '1.2.4',
        lastCheckMs: Date.now(),
        lastUpdateMs: Date.now(),
        updating: false,
        available: true,
        source: 'managed',
      })
    const cc_runtime_check_now = vi.fn(async () => ({
      updated: true,
      from: '1.2.3',
      to: '1.2.4',
    }))

    setElectronAPI({ cc_runtime_status, cc_runtime_check_now })

    const { container, unmount } = await mountSection()

    expect(cc_runtime_status).toHaveBeenCalledTimes(1)

    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="cc-runtime-check-now-btn"]',
    )
    expect(btn).not.toBeNull()
    expect(btn!.disabled).toBe(false)

    btn!.click()
    // Let the async handler settle.
    await nextTick()
    await Promise.resolve()
    await nextTick()
    await Promise.resolve()
    await nextTick()
    await Promise.resolve()
    await nextTick()

    expect(cc_runtime_check_now).toHaveBeenCalledTimes(1)
    // Post-check re-fetch — cc_runtime_status must have been called a
    // second time to refresh the rendered version.
    expect(cc_runtime_status).toHaveBeenCalledTimes(2)

    const ver = container.querySelector<HTMLElement>(
      '[data-testid="cc-runtime-current-version"]',
    )
    expect(ver?.textContent?.trim()).toBe('1.2.4')

    // Success toast rendered with both versions.
    const msg = container.querySelector<HTMLElement>(
      '[data-testid="cc-runtime-message"]',
    )
    expect(msg?.textContent ?? '').toContain('1.2.3')
    expect(msg?.textContent ?? '').toContain('1.2.4')

    unmount()
  })

  it('disables the button while updating=true', async () => {
    const cc_runtime_status = vi.fn(async () => ({
      currentVersion: '1.2.3',
      lastCheckMs: Date.now(),
      lastUpdateMs: 0,
      updating: true,
      available: true,
      source: 'managed',
    }))
    const cc_runtime_check_now = vi.fn(async () => ({ updated: false }))

    setElectronAPI({ cc_runtime_status, cc_runtime_check_now })

    const { container, unmount } = await mountSection()

    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="cc-runtime-check-now-btn"]',
    )
    expect(btn).not.toBeNull()
    expect(btn!.disabled).toBe(true)

    // Clicking a disabled button should not reach the IPC.
    btn!.click()
    await nextTick()
    expect(cc_runtime_check_now).not.toHaveBeenCalled()

    unmount()
  })
})
