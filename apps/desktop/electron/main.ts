/**
 * AgentWorkflowPlatform Desktop — Electron main process entry point.
 *
 * Replaces launch.py: creates the BrowserWindow, registers IPC handlers,
 * starts background services, and manages the app lifecycle.
 */

import './bootstrap/channel' // MUST be first — sets userData before any other import
import { app, BrowserWindow, Menu, dialog, session, shell } from 'electron'

// Compatibility mode detection must run before preload snapshots the process
// environment. Operators can select it explicitly with AWP_LAB_MODE=1; the
// retained packaged application name remains supported for existing installs.
if (process.env.AWP_LAB_MODE !== '1') {
  try {
    if (app.getName() === 'AgentWorkflowPlatform Lab') {
      process.env.AWP_LAB_MODE = '1'
    }
  } catch { /* app.getName may not be ready in some test contexts; env wins. */ }
}

// Hosted account endpoints are an optional compatibility adapter. Public
// builds start in local/no-account mode unless the operator explicitly opts
// in with the exact value 1. Canonicalize before preload snapshots env.
process.env.AWP_HOSTED_AUTH_OPT_IN =
  process.env.AWP_HOSTED_AUTH_OPT_IN === '1' ? '1' : '0'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import os from 'node:os'
import { readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs'
import { isInsidersChannel } from './bootstrap/channel'
import { registerIpcHandlers } from './ipc/handlers'
import { startServices, stopServices } from './services/index'
import { startDesktopUi } from './lifecycle/startup-orchestration'
import { log } from './utils/logger'
import {
  decideWindowOpen,
  installNavigationGuards,
  normalizeTrustedDocumentUrl,
} from './security/navigation-policy'
// ADR-012 Phase 1 (T-A018): local CC subprocess IPC surface. Registered once
// at whenReady so the renderer can `window.electronAPI.ccStart(...)` etc.
// Idempotent — removeHandler-first pattern mirrors services/index.ts.
import { registerCcIpc } from './cc/cc-wrapper'

// ---------------------------------------------------------------------------
// Version — read once from package.json at startup.
//
// tsconfig.electron.json uses rootDir: "." (T-A041) so the compiled main.js
// lives at dist-electron/electron/main.js — two levels below the repo root
// (or below the asar root in packaged builds). Use app.getAppPath() which
// resolves to the project root in dev and to app.asar's root in packaged
// builds, always containing package.json. Keep a __dirname-based fallback
// for early-boot logs where app might not be ready (shouldn't happen here
// because we already imported `app` synchronously, but belt + braces).
// ---------------------------------------------------------------------------
// ADR-014a Phase 3: when E2E (or `dev:lab:chat` script) launches
// `electron dist-electron/electron/main.js` directly, app.getAppPath()
// resolves to the directory containing main.js — NOT the project root —
// so package.json / dist/index.html / resources/icon.ico are all in the
// wrong place. Detect this and fall back to two-levels-up (the repo root).
function resolveAppRoot(): string {
  try {
    const fromAppApi = app.getAppPath()
    if (existsSync(path.join(fromAppApi, 'package.json'))) return fromAppApi
  } catch { /* not ready */ }
  // __dirname = dist-electron/electron → repo root is two levels up
  const fromDirname = path.resolve(__dirname, '..', '..')
  return fromDirname
}
const APP_ROOT = resolveAppRoot()

const pkgPath = path.join(APP_ROOT, 'package.json')
const version: string = JSON.parse(readFileSync(pkgPath, 'utf-8')).version ?? '0.0.0'

// Channel-derived state lives in bootstrap/channel.ts — imported above so
// app.setPath('userData') and process.env.AWP_CHANNEL are applied
// before any other module's top-level code runs.
const productName = app.getName()

// ---------------------------------------------------------------------------
// Single-instance lock — prevent multiple windows
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

// ---------------------------------------------------------------------------
// Startup integrity check — block launch when running from an unexpected path.
//
// On a dev machine the repo's `desktop/build/win-unpacked/Agent Workflow Platform.exe` can
// be launched directly (shortcut / Explorer click) while `app.isPackaged` is
// still `true` — the app then looks identical to a real install but is frozen
// at whatever version last ran electron-builder. autoUpdater downloads new
// NSIS installers into `%LOCALAPPDATA%/awp-desktop-updater/pending/` and
// those installers overwrite the Start-Menu install, not this win-unpacked
// copy — so the user keeps re-launching the stale one and never sees the
// update land.
//
// Previously we only logged a WARN; v1.4.8 escalates to an Electron modal so
// the user cannot silently keep using the stale copy. Stable and Insiders have
// separate allowed install prefixes (derived from app.getName()). Set
// AWP_ALLOW_ANY_PATH=1 to bypass the check for local dev of a packaged
// build (e.g. running build/win-unpacked/Agent Workflow Platform.exe directly).
//
// Note: dialog.showMessageBoxSync must be called after app.whenReady(), so the
// actual prompt is issued from inside the whenReady handler. This function is
// async-safe to call before window creation.
//
// Persistent allow-list — if the user clicks "允许此路径 24 小时", we record
// the exe path + expiry into <userData>/allowed-nonstandard-paths.json so
// repeated launches from the same non-standard path don't keep nagging. Entry
// TTL is 24 h: long enough that an active dev session (typical full workday
// including lunch + evening iteration) fits inside one decision, short enough
// that a forgotten sideloaded exe on a shared machine auto-re-nags the next
// day (1 h would re-nag mid-session — annoying; 7 d would let stale copies
// linger past weekends; Signal/Chrome class products typically pick 1–7 d, we
// sit at the conservative end to favor safety on shared/corporate machines).
// ---------------------------------------------------------------------------
const ALLOW_TTL_MS = 24 * 60 * 60 * 1000 // 24 h — see comment block above
const ALLOW_LIST_NAME = 'allowed-nonstandard-paths.json'

interface AllowEntry {
  exe: string
  until_ts: number
}
interface AllowStore {
  entries: AllowEntry[]
}

function allowListPath(): string {
  // userData is already redirected via app.setPath('userData', ...) above.
  // Must only be called after that redirect (true at module load time here).
  return path.join(app.getPath('userData'), ALLOW_LIST_NAME)
}

function readAllowStore(): AllowStore {
  try {
    const p = allowListPath()
    if (!existsSync(p)) return { entries: [] }
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as AllowStore
    const now = Date.now()
    const entries = (raw.entries ?? []).filter(
      (e) => e && typeof e.exe === 'string' && typeof e.until_ts === 'number' && e.until_ts > now,
    )
    return { entries }
  } catch (err) {
    log(`[main] allow-list read failed (ignored): ${String(err)}`)
    return { entries: [] }
  }
}

function writeAllowStore(store: AllowStore): void {
  try {
    writeFileSync(allowListPath(), JSON.stringify(store, null, 2), 'utf-8')
  } catch (err) {
    log(`[main] allow-list write failed: ${String(err)}`)
  }
}

function isExeAllowed(exePath: string): boolean {
  const store = readAllowStore()
  const norm = exePath.toLowerCase()
  return store.entries.some((e) => e.exe.toLowerCase() === norm)
}

function addExeToAllowList(exePath: string): void {
  const store = readAllowStore()
  const now = Date.now()
  const norm = exePath.toLowerCase()
  const existing = store.entries.find((e) => e.exe.toLowerCase() === norm)
  if (existing) {
    existing.until_ts = now + ALLOW_TTL_MS
  } else {
    store.entries.push({ exe: exePath, until_ts: now + ALLOW_TTL_MS })
  }
  writeAllowStore(store)
}

async function checkInstallPathOrPrompt(): Promise<boolean> {
  if (!app.isPackaged) return true
  if (process.platform !== 'win32') return true
  if (process.env.AWP_ALLOW_ANY_PATH === '1') {
    log('[main] install path check bypassed via AWP_ALLOW_ANY_PATH=1')
    return true
  }

  const exePath = app.getPath('exe')
  const installDirName = isInsidersChannel ? 'awp-desktop-insiders' : 'awp-desktop'
  const allowedPrefix = path.join(os.homedir(), 'AppData', 'Local', 'Programs', installDirName)

  // Normalize both paths: resolve symlinks/junctions, expand 8.3 short names
  // (ADMINI~1 -> Administrator), unify separators, strip long-path '\\?\' prefix.
  // realpathSync.native triggers Windows API canonicalization; throws if path
  // doesn't exist — fall back to path.resolve which at least normalizes seps.
  let canonExe: string
  let canonPrefix: string
  try {
    canonExe = realpathSync.native(exePath)
  } catch {
    canonExe = path.resolve(exePath)
  }
  try {
    canonPrefix = realpathSync.native(allowedPrefix)
  } catch {
    // Prefix may not exist yet (e.g. Insiders install not done) — resolve() only
    canonPrefix = path.resolve(allowedPrefix)
  }

  // Strip long-path prefix '\\?\' that realpathSync.native may prepend
  canonExe = canonExe.replace(/^\\\\\?\\/, '')
  canonPrefix = canonPrefix.replace(/^\\\\\?\\/, '')

  // path.relative is the semantically correct "is inside directory" check:
  // if rel starts with '..' or is absolute, exe is outside prefix. Case-
  // insensitive on Windows because path.relative preserves case but NTFS is
  // case-insensitive, so we lowercase both operands.
  const rel = path.relative(canonPrefix.toLowerCase(), canonExe.toLowerCase())
  const okPath = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))

  if (okPath) return true

  // Persistent allow-list: user previously clicked "允许此路径 24 小时" for this
  // exe path and the window hasn't expired. Use the canonicalized path so
  // allow-list entries survive symlink/8.3-name differences between sessions.
  if (isExeAllowed(canonExe)) {
    log(`[main] exe path allowed by persistent list (24h window): ${canonExe}`)
    return true
  }

  log(`[main] FATAL exe path outside install prefix: ${canonExe}`)
  log(`[main] FATAL expected prefix: ${canonPrefix}`)

  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    title: `${productName} — 非官方安装位置`,
    message: `你正在运行非安装副本的 ${productName}`,
    detail:
      `可执行文件位置：${exePath}\n\n` +
      `期望位置：${allowedPrefix}\n\n` +
      `自动更新不会升级这个副本。建议从 Start Menu 或桌面快捷方式启动官方安装版。\n\n` +
      `选择"允许此路径 24 小时"记住你的选择，避免每次启动都弹窗。`,
    buttons: ['打开安装目录', '允许此路径 24 小时', '退出'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  })

  if (choice === 0) {
    shell.openPath(allowedPrefix).catch(() => {})
    app.exit(0)
    return false
  }
  if (choice === 2) {
    app.exit(0)
    return false
  }
  // choice === 1: persist allow-list entry for 24 h so repeat launches from
  // this same exe don't nag. Using canonExe (post realpath) to survive 8.3
  // short-name and junction variance between launches.
  addExeToAllowList(canonExe)
  log(`[main] user added ${canonExe} to allow list for 24h`)
  return true
}

let mainWindow: BrowserWindow | null = null

function openArtifactFromNavigation(artifactId: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    try { window.webContents.send('awp-ide:focus-artifact', { artifactId }) }
    catch { /* window destroyed mid-broadcast */ }
  }

  const safeId = path.basename(artifactId)
  if (!safeId || safeId !== artifactId) return
  const localPath = path.join(app.getPath('userData'), 'artifacts', safeId)
  void shell.openPath(localPath).then((errorMessage) => {
    if (errorMessage) log('[navigation] artifact open failed')
  }).catch(() => {
    log('[navigation] artifact open failed')
  })
}

function openExternalFromNavigation(url: string): void {
  void shell.openExternal(url).catch(() => {
    log('[navigation] external open failed')
  })
}

const navigationSideEffects = {
  openExternal: openExternalFromNavigation,
  openArtifact: openArtifactFromNavigation,
}

function createWindow(): void {
  const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev')
  const indexPath = path.join(APP_ROOT, 'dist', 'index.html')
  const requestedDocumentUrl = isDev
    ? process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173'
    : pathToFileURL(indexPath).href
  const trustedDocumentUrl = normalizeTrustedDocumentUrl(
    requestedDocumentUrl,
    isDev ? 'development' : 'production',
  )
  if (!trustedDocumentUrl) {
    log('[navigation] refused invalid application document configuration')
    app.quit()
    return
  }

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 800,
    minHeight: 560,
    title: `Agent Workflow Platform v${version}`,
    icon: path.join(APP_ROOT, 'resources', 'icon.ico'),
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      // v1.6.6 UI port — match designer mockup outer window bg
      // (oklch(0.955 0.004 252) ≈ #F1F2F6) so the Electron-drawn
      // min/max/close overlay blends into the 10px gutter.
      color: '#F1F2F6',
      symbolColor: '#3B4252',
      height: 36,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 安全加固: 启用 sandbox 隔离渲染进程，preload 仅通过 contextBridge 暴露 IPC
      sandbox: true,
    },
    show: false,
  })
  const appWindow = mainWindow

  // Show when content is painted
  appWindow.once('ready-to-show', () => {
    appWindow.show()
  })

  // Keep the privileged preload attached only to the application document.
  // The injectable installer owns all top-level navigation registrations.
  installNavigationGuards({
    getURL: () => appWindow.webContents.getURL(),
    on: (event, listener) => {
      if (event === 'will-navigate') {
        appWindow.webContents.on('will-navigate', (navigationEvent, url) => {
          listener(navigationEvent, url)
        })
      } else {
        appWindow.webContents.on('will-redirect', (navigationEvent, url) => {
          listener(navigationEvent, url)
        })
      }
    },
    setWindowOpenHandler: (handler) => {
      appWindow.webContents.setWindowOpenHandler(({ url }) => handler({ url }))
    },
  }, trustedDocumentUrl, navigationSideEffects)

  // ---------------------------------------------------------------------------
  // CSP headers — file:// protocol needs explicit https: allowance
  // ---------------------------------------------------------------------------
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self' file: http://127.0.0.1:8787 https://*.api.example.com",
            "script-src 'self' file:",
            "style-src 'self' file: 'unsafe-inline'",
            // img-src 仅限自家域 — LLM markdown 图片来源必须走 api.example.com，不放通配 https
            "img-src 'self' file: data: http://127.0.0.1:8787",
            // connect-src 去掉 file: — HTTP/WS 请求不应来自 file 协议源
            "connect-src 'self' http://localhost:* http://127.0.0.1:8787 https://*.api.example.com wss://api.example.com wss://*.api.example.com",
            "font-src 'self' file: data: https://fonts.gstatic.com",
            // 防 clickjacking + 限制表单提交目标
            "frame-ancestors 'none'",
            "form-action 'self'",
          ].join('; '),
        ],
      },
    })
  })

  // ---------------------------------------------------------------------------
  // Load the one document that is allowed to carry the privileged preload.
  // ---------------------------------------------------------------------------
  if (isDev) {
    void appWindow.loadURL(trustedDocumentUrl).catch(() => {
      log('[main] failed to load trusted development document')
    })
    appWindow.webContents.openDevTools({ mode: 'detach' })
    log('[main] Dev mode — loading trusted application origin')
  } else {
    void appWindow.loadFile(indexPath).catch(() => {
      log('[main] failed to load bundled application document')
    })
    log('[main] Prod mode — loading bundled application document')
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------
  appWindow.on('closed', () => {
    mainWindow = null
  })
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  log(`[main] Agent Workflow Platform v${version} starting`)

  // Block launch if exe is outside the allowed install prefix (Windows packaged
  // only). Dialog runs here because it requires a ready app.
  if (!(await checkInstallPathOrPrompt())) {
    return
  }

  // Remove the native menu bar entirely
  Menu.setApplicationMenu(null)

  // Register the internal artifact signal. The same strict parser used by
  // navigation handlers validates awp://artifact/<artifact_id> before any
  // renderer IPC or filesystem side effect occurs.
  try {
    const { protocol: appProtocol } = require('electron') as typeof import('electron')
    appProtocol.handle('awp', async (request: Request) => {
      try {
        const decision = decideWindowOpen(request.url)
        if (decision.action !== 'open-artifact') {
          return new Response(null, { status: 404 })
        }
        openArtifactFromNavigation(decision.artifactId)
        return new Response(null, { status: 204 })
      } catch {
        log('[navigation] internal artifact protocol handler failed')
        return new Response(null, { status: 500 })
      }
    })
  } catch {
    log('[navigation] internal artifact protocol registration failed')
  }

  // Register all IPC handlers before window creation
  registerIpcHandlers()

  // ADR-012 Phase 1 (T-A018): register CC subprocess IPC handlers
  // (`cc:start` / `cc:send-message` / `cc:stop` / `cc:status`). Idempotent.
  try {
    registerCcIpc()
  } catch (e) {
    log(`[main] registerCcIpc failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`)
  }

  // Expose the local UI first. Optional adapters start afterwards and cannot
  // delay or suppress window creation if one of them stalls.
  startDesktopUi({
    createWindow,
    startOptionalServices: startServices,
    onOptionalServiceError: (error) => {
      log(`[main] optional services failed (continuing): ${
        error instanceof Error ? error.message : String(error)
      }`)
    },
  })

  // macOS: re-create window when dock icon clicked
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

// Quit when all windows closed (except macOS).
// stopServices() became async in ADR-012 Phase 2 Part 4 (T-A020) so it can
// drain CC subprocesses with a 5 s hard cap. Fire-and-forget here: the
// internal race guarantees resolution, and blocking the event handler on
// an `await` would delay the subsequent `app.quit()` call with no benefit.
app.on('window-all-closed', () => {
  log('[main] All windows closed — cleaning up services')
  void stopServices().catch((e) =>
    log(`[main] stopServices error (window-all-closed): ${e instanceof Error ? e.message : String(e)}`),
  )

  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  log('[main] before-quit — stopping services')
  void stopServices().catch((e) =>
    log(`[main] stopServices error (before-quit): ${e instanceof Error ? e.message : String(e)}`),
  )
})

// Second instance: focus existing window
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})
