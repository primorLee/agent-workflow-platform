/**
 * Auto-updater — checks for new versions and installs on app quit.
 *
 * Port of: launch.py L867-960 (_auto_update + _apply_pending_update)
 *
 * Uses electron-updater which handles download, hash verification, and
 * install-on-quit natively — replaces ~180 lines of manual Python logic.
 *
 * Degradation policy:
 *   - If the release manifest is missing (404 / channel file not found),
 *     disable the periodic check to avoid log spam. Manual retry via
 *     `triggerManualCheck()` re-enables it.
 *   - Errors are funneled through `handleUpdaterError()` so the same
 *     message doesn't repeat within 1 hour (single-line format only).
 */

import { autoUpdater, type UpdateInfo } from 'electron-updater'
import { BrowserWindow, dialog } from 'electron'
import { log } from '../utils/logger'

// ---------------------------------------------------------------------------
// Renderer-facing state snapshot — broadcast via IPC every time it changes.
// The Vue layer renders a progress banner from this.
// ---------------------------------------------------------------------------

export type UpdaterState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'not-available'; current: string }
  | { phase: 'available'; version: string }
  | {
      phase: 'downloading'
      version: string
      percent: number
      bytes_per_second: number
      transferred: number
      total: number
    }
  | { phase: 'ready'; version: string }
  | { phase: 'error'; message: string }

let currentState: UpdaterState = { phase: 'idle' }

function broadcastState(next: UpdaterState): void {
  currentState = next
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send('updater:status', next)
    } catch {
      /* window may be closing — ignore */
    }
  }
}

/** Renderer can pull the current snapshot on boot in case it mounted after
 *  the first broadcast. */
export function getUpdaterState(): UpdaterState {
  return currentState
}

/** User clicked "立即下载" in the banner. Kick off the download — progress
 *  events will broadcast via download-progress handler. Safe to call only
 *  when phase==='available'. */
export async function downloadUpdateNow(): Promise<void> {
  if (currentState.phase !== 'available') {
    log(`[updater] downloadUpdateNow called in phase=${currentState.phase} — ignoring`)
    return
  }
  log('[updater] User requested foreground download')
  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    log(`[updater] downloadUpdate failed: ${err instanceof Error ? err.message : err}`)
    throw err
  }
}

/** Ask electron-updater to quit now and install the already-downloaded update.
 *  Safe to call only when currentState.phase === 'ready'. */
export function quitAndInstall(): void {
  if (currentState.phase !== 'ready') {
    log('[updater] quitAndInstall called in non-ready state — ignoring')
    return
  }
  try {
    autoUpdater.quitAndInstall(false, true) // isSilent=false, isForceRunAfter=true
  } catch (err) {
    log(`[updater] quitAndInstall failed: ${err instanceof Error ? err.message : err}`)
  }
}

const ONE_HOUR_MS = 60 * 60 * 1000
const CHECK_INTERVAL_MS = 30 * 60 * 1000

let checkIntervalId: ReturnType<typeof setInterval> | null = null
let autoCheckEnabled = true
const lastErrorLogAt = new Map<string, number>()

function firstLine(s: string): string {
  const idx = s.indexOf('\n')
  return (idx === -1 ? s : s.slice(0, idx)).trim()
}

function logUpdaterError(err: Error | unknown): void {
  const msg = err instanceof Error ? err.message : String(err)
  const key = firstLine(msg)
  const now = Date.now()
  const last = lastErrorLogAt.get(key) ?? 0
  if (now - last < ONE_HOUR_MS) {
    return
  }
  lastErrorLogAt.set(key, now)
  log(`[updater] Error: ${key}`)
}

function isManifestMissingError(err: Error | unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)) || ''
  const hay = msg.toLowerCase()
  return (
    msg.includes('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') ||
    /HttpError:\s*404/i.test(msg) ||
    hay.includes('cannot find channel') ||
    hay.includes('status code 404')
  )
}

function disableAutoCheck(): void {
  if (checkIntervalId) {
    clearInterval(checkIntervalId)
    checkIntervalId = null
  }
  if (autoCheckEnabled) {
    autoCheckEnabled = false
    log('[updater] Auto-check disabled (release manifest unavailable); use manual check to retry')
  }
}

function handleUpdaterError(err: Error | unknown): void {
  logUpdaterError(err)
  if (isManifestMissingError(err)) {
    disableAutoCheck()
  }
}

const MAX_UPDATE_FEED_URL_LENGTH = 2_048
const UPDATE_URL_CONTROL_OR_SPACE = /[\s\u0000-\u001f\u007f]/u
const INVALID_PERCENT_ESCAPE = /%(?![0-9a-fA-F]{2})/u

function rawAuthority(raw: string): string | null {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/iu.exec(raw)
  return match?.[1] ?? null
}

function isExplicitLoopbackAuthority(authority: string, parsed: URL): boolean {
  if (/^localhost(?::\d{1,5})?$/iu.test(authority)) {
    return parsed.hostname === 'localhost'
  }
  if (/^127\.0\.0\.1(?::\d{1,5})?$/u.test(authority)) {
    return parsed.hostname === '127.0.0.1'
  }
  return /^\[[0-9a-f:]+\](?::\d{1,5})?$/iu.test(authority)
    && parsed.hostname === '[::1]'
}

/**
 * Normalize an explicit generic-update feed.
 *
 * Remote feeds require HTTPS. Plain HTTP is limited to an explicitly written
 * semantic loopback host; parser shortcuts such as integer/octal IPv4 are
 * rejected instead of being silently canonicalized into a trusted endpoint.
 */
export function normalizeUpdateFeedUrl(raw: string | undefined | null): string | null {
  if (
    typeof raw !== 'string'
    || raw.length === 0
    || raw.length > MAX_UPDATE_FEED_URL_LENGTH
    || raw !== raw.trim()
    || UPDATE_URL_CONTROL_OR_SPACE.test(raw)
    || raw.includes('\\')
    || INVALID_PERCENT_ESCAPE.test(raw)
  ) {
    return null
  }

  const authority = rawAuthority(raw)
  if (!authority || authority.includes('@')) return null

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null
  if (parsed.port && (!/^\d{1,5}$/u.test(parsed.port) || Number(parsed.port) < 1)) return null
  if (!parsed.pathname.startsWith('/') || parsed.pathname.includes('//')) return null

  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(parsed.pathname)
  } catch {
    return null
  }
  if (
    UPDATE_URL_CONTROL_OR_SPACE.test(decodedPath)
    || decodedPath.includes('\\')
    || decodedPath.includes('//')
  ) {
    return null
  }

  if (parsed.protocol === 'http:' && !isExplicitLoopbackAuthority(authority, parsed)) {
    return null
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/u, '') || '/'
  return parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname)
}

function configuredFeedUrl(channel: 'stable' | 'insiders'): string | null {
  const value = channel === 'insiders'
    ? process.env.AWP_UPDATE_INSIDERS_URL
    : process.env.AWP_UPDATE_URL
  return normalizeUpdateFeedUrl(value)
}

function applyFeedUrl(channel: 'stable' | 'insiders', url: string): boolean {
  try {
    if (channel === 'insiders') {
      autoUpdater.setFeedURL({
        provider: 'generic',
        url,
        channel: 'insiders',
      })
    } else {
      autoUpdater.setFeedURL({
        provider: 'generic',
        url,
      })
    }
    return true
  } catch {
    log('[updater] Disabled: updater rejected the configured feed')
    return false
  }
}

export function startAutoUpdater(): void {
  const channel = process.env.AWP_CHANNEL === 'insiders' ? 'insiders' : 'stable'
  const url = configuredFeedUrl(channel)
  if (!url) {
    autoCheckEnabled = false
    log('[updater] Disabled: configure a valid explicit update feed URL to enable hosted updates')
    return
  }
  autoCheckEnabled = true
  // v1.7.1 (ADR-015 deploy retrospective): switched to true silent
  // background download. Previous "click-the-banner" flow required two
  // user interactions (download + restart) and production runs exposed it
  // as "auto-update doesn't work". New flow:
  //   1. checkForUpdates → if newer version: silent background download
  //   2. update-downloaded → native dialog "v<X> ready — restart now?"
  //      with [立即重启] [稍后] buttons
  //   3. Either way, autoInstallOnAppQuit=true installs on next exit
  // Banner still rendered in renderer for in-flight progress visibility.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowDowngrade = false

  // Channel-aware feed URL — main.ts exports AWP_CHANNEL based on appId.
  // Insiders must NOT pull Stable's latest.yml or it would download a Stable
  // package and overwrite the Insiders install (breaks channel isolation).
  //
  // 2026-05-19 BUG FIX: previously passed `channel: 'stable'` to setFeedURL,
  // which made electron-updater fetch `stable.yml` instead of the canonical
  // `latest.yml` that scripts/upload_desktop_release.py writes. Result: every
  // production install of v1.7.1 got a 404 on every check, isManifestMissingError
  // tripped disableAutoCheck(), and auto-update was permanently dead until
  // user restart. Stable installs now omit `channel` so the SDK uses
  // its default `latest.yml`. Insiders still needs `channel: 'insiders'`
  // because we ship insiders.yml separately.

  if (!applyFeedUrl(channel, url)) {
    autoCheckEnabled = false
    return
  }

  log('[updater] feed configured (channel=' + channel
    + ', manifest=' + (channel === 'insiders' ? 'insiders.yml' : 'latest.yml') + ')')

  // Event handlers — log to file AND broadcast to renderer for UI.
  autoUpdater.on('checking-for-update', () => {
    log('[updater] Checking for update...')
    broadcastState({ phase: 'checking' })
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    log(`[updater] Update available: v${info.version}`)
    broadcastState({ phase: 'available', version: info.version })
  })

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    log(`[updater] App is up to date (v${info.version})`)
    broadcastState({ phase: 'not-available', current: info.version })
  })

  autoUpdater.on('download-progress', (progress) => {
    log(`[updater] Download progress: ${progress.percent.toFixed(1)}%`)
    broadcastState({
      phase: 'downloading',
      version: (autoUpdater as unknown as { currentVersion?: string }).currentVersion ?? '',
      percent: progress.percent ?? 0,
      bytes_per_second: progress.bytesPerSecond ?? 0,
      transferred: progress.transferred ?? 0,
      total: progress.total ?? 0,
    })
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    log(`[updater] Update downloaded: v${info.version} — will install on quit`)
    broadcastState({ phase: 'ready', version: info.version })
    // v1.7.1: surface a native dialog so user knows the silent download
    // landed; default action installs on next quit if they pick 稍后.
    void promptInstallNow(info.version)
  })

  // Single error funnel — electron-updater emits 'error' AND rejects the
  // checkForUpdates() promise for the same failure, so we rely on this
  // event only and do not attach a .catch() to the initial call below.
  autoUpdater.on('error', (err: Error) => {
    handleUpdaterError(err)
    const msg = err instanceof Error ? err.message : String(err)
    // Don't spam the banner with 404 errors — those get autoCheckEnabled=false
    // separately and the banner just disappears.
    if (!isManifestMissingError(err)) {
      broadcastState({ phase: 'error', message: firstLine(msg) })
    } else {
      broadcastState({ phase: 'idle' })
    }
  })

  // Check on startup (with delay to not block window creation).
  // No .catch here — the 'error' event above handles it (avoids double-log).
  setTimeout(() => {
    if (!autoCheckEnabled) return
    void autoUpdater.checkForUpdates()
  }, 5_000)

  // Check every 30 minutes
  checkIntervalId = setInterval(() => {
    if (!autoCheckEnabled) return
    void autoUpdater.checkForUpdates()
  }, CHECK_INTERVAL_MS)

  log('[updater] Started')
}

export function stopAutoUpdater(): void {
  if (checkIntervalId) {
    clearInterval(checkIntervalId)
    checkIntervalId = null
  }
  // electron-updater doesn't need explicit cleanup beyond stopping the check interval
  log('[updater] Stopped')
}

/**
 * Manual update check — re-enables auto-check if it was disabled due to a
 * prior manifest-missing error, then triggers a fresh check. Intended to be
 * wired to an IPC handler / menu item for user-initiated retries.
 */
export function triggerManualCheck(): Promise<void> {
  const channel = process.env.AWP_CHANNEL === 'insiders' ? 'insiders' : 'stable'
  const url = configuredFeedUrl(channel)
  if (!url) {
    log('[updater] Manual check ignored: no valid update feed configured')
    return Promise.resolve()
  }
  if (!applyFeedUrl(channel, url)) {
    autoCheckEnabled = false
    return Promise.resolve()
  }
  autoCheckEnabled = true
  if (!checkIntervalId) {
    checkIntervalId = setInterval(() => {
      if (!autoCheckEnabled) return
      void autoUpdater.checkForUpdates()
    }, CHECK_INTERVAL_MS)
  }
  log('[updater] Manual check requested')
  return autoUpdater
    .checkForUpdates()
    .then(() => undefined)
    .catch((err) => {
      handleUpdaterError(err)
    })
}

/**
 * v1.7.1 — surface a native dialog when a silent background download
 * completes. autoDownload=true means the user wasn't informed download
 * started; we owe them a clear "ready to install" prompt.
 *
 * Buttons:
 *   立即重启 → quitAndInstall now
 *   稍后    → no-op; autoInstallOnAppQuit=true means next natural quit
 *             will install. We log so support can correlate user gripes.
 *
 * Throttle: each version's prompt fires at most once per process to avoid
 * harassing the user (e.g., long-running session where the dialog was
 * dismissed but background timers re-detect the same downloaded build).
 */
const _promptedVersions = new Set<string>()
async function promptInstallNow(version: string): Promise<void> {
  if (_promptedVersions.has(version)) return
  _promptedVersions.add(version)

  const target =
    BrowserWindow.getFocusedWindow()
    ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    ?? null
  if (!target) {
    log('[updater] no window available for install prompt; will install on quit')
    return
  }
  try {
    const r = await dialog.showMessageBox(target, {
      type: 'info',
      title: 'Agent Workflow Platform 更新',
      message: `新版本 v${version} 已下载完成`,
      detail: '点击 "立即重启" 现在更新, 或选择 "稍后" — 退出 App 时会自动安装。',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (r.response === 0) {
      log(`[updater] User chose 立即重启 for v${version}`)
      try {
        autoUpdater.quitAndInstall(false, true)
      } catch (err) {
        log(`[updater] quitAndInstall failed: ${err instanceof Error ? err.message : err}`)
      }
    } else {
      log(`[updater] User chose 稍后 for v${version} — install will run on next quit`)
    }
  } catch (err) {
    // dialog.showMessageBox can throw if window destroyed mid-display;
    // either way the user will pick up the update on next natural quit.
    log(`[updater] install prompt failed: ${err instanceof Error ? err.message : err}`)
  }
}
