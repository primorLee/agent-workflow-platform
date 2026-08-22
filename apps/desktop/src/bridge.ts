import type { DesktopBridge, CredentialResult, CredentialKey } from '@/types/bridge'

export type Runtime = 'electron' | 'pywebview' | 'browser'

/**
 * Window augmentation for electronAPI / pywebview.api lives in
 * `src/types/window.d.ts` (ADR-012 T-A041) — that declaration types
 * `electronAPI` as `DesktopElectronApi` (extends `DesktopBridge`). We
 * down-cast to `DesktopBridge` at the consumer boundary because the
 * legacy bridge surface is all most callers need.
 */

function desktopWindow(): Window | null {
  if (typeof window === 'undefined') return null
  return window
}

export function detectRuntime(): Runtime {
  const w = desktopWindow()
  if (w?.electronAPI) return 'electron'
  if (w?.pywebview?.api) return 'pywebview'
  return 'browser'
}

export const runtime: Runtime = detectRuntime()
export const isDesktop: boolean = runtime !== 'browser'

function createBridge(): DesktopBridge | null {
  const w = desktopWindow()
  if (!w) return null
  if (runtime === 'electron') return w.electronAPI ?? null
  if (runtime === 'pywebview') return w.pywebview?.api ?? null
  return null
}

export const bridge: DesktopBridge | null = createBridge()

/** Wait for bridge availability (Electron: immediate, pywebview: event-based, browser: null) */
export function waitForBridge(timeout = 3000): Promise<DesktopBridge | null> {
  if (bridge) return Promise.resolve(bridge)

  const w = desktopWindow()
  if (w && !w.electronAPI) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeout)
      window.addEventListener('pywebviewready', () => {
        clearTimeout(timer)
        setTimeout(() => {
          const api = desktopWindow()?.pywebview?.api ?? null
          resolve(api)
        }, 100)
      }, { once: true })
    })
  }

  return Promise.resolve(null)
}

// ---------------------------------------------------------------------------
// 安全凭据存取封装 — 优先走 Electron safeStorage，不可用时返回失败
// ---------------------------------------------------------------------------

/** 检查桌面 bridge 是否支持 safeStorage 凭据操作 */
export function hasSecureCredentials(): boolean {
  return !!(bridge && typeof bridge.set_credential === 'function')
}

/**
 * 加密存储凭据。返回 false 表示 bridge 不可用或加密不可用。
 * `key` 必须是 allow-listed `CredentialKey` — TS 在编译期捕获打错字的调用方，
 * main-process 也会在运行时拒绝未列入白名单的 key（见 S1 修复）。
 */
export async function setCredential(key: CredentialKey, value: string): Promise<boolean> {
  if (!bridge?.set_credential) return false
  try {
    const res: CredentialResult = await bridge.set_credential(key, value)
    return res.ok
  } catch {
    return false
  }
}

/** 解密读取凭据。返回 undefined 表示不存在或不可用 */
export async function getCredential(key: CredentialKey): Promise<string | undefined> {
  if (!bridge?.get_credential) return undefined
  try {
    const res: CredentialResult = await bridge.get_credential(key)
    if (res.ok) return res.value
    return undefined
  } catch {
    return undefined
  }
}

/** 删除凭据 */
export async function deleteCredential(key: CredentialKey): Promise<boolean> {
  if (!bridge?.delete_credential) return false
  try {
    const res: CredentialResult = await bridge.delete_credential(key)
    return res.ok
  } catch {
    return false
  }
}
