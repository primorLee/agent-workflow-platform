/**
 * ADR-012 Phase 2 (T-A041) — strict Window augmentation for electronAPI.
 *
 * The project's root `env.d.ts` already declares
 * `electronAPI?: DesktopBridge`. DesktopBridge covers the pywebview-era
 * surface but is missing the ADR-012 CC methods (`cc_*` +
 * `cc_runtime_*`). Renderer modules that needed CC methods used to cast
 * to `any` — that's exactly the iter-6 footgun we're closing.
 *
 * Here we upgrade `window.electronAPI` to `DesktopElectronApi`, which
 * extends DesktopBridge with the ADR-012 methods. Existing callsites
 * that only touch DesktopBridge members stay compatible; CC callsites
 * now get full IntelliSense + compile-time checking for missing methods
 * (iter-6 regression) and wrong arg shapes (iter-7-style drift).
 *
 * `electronAPI` stays optional because pywebview builds leave it
 * undefined, and so do unit-test environments that mount the renderer
 * under jsdom without a preload.
 */

import type { DesktopElectronApi } from './adr012'

declare global {
  interface Window {
    electronAPI?: DesktopElectronApi
    pywebview?: { api?: DesktopElectronApi }
    /** Exact, fail-closed main-process opt-in for the hosted account adapter. */
    __AWP_HOSTED_AUTH_ENABLED?: boolean
    /** Ephemeral local-demo capability injected by the trusted Electron preload. */
    readonly __AWP_DEMO_TOKEN?: string | null
    /** Canonical origin for the current ephemeral local-demo capability. */
    readonly __AWP_DEMO_ORIGIN?: string | null
    /** Local shell mode exposed by preload for compatibility workflows. */
    __AWP_LAB_MODE?: boolean
  }
}

// Ensures this file is treated as a module (required for
// `declare global` to merge with ambient Window correctly).
export {}
