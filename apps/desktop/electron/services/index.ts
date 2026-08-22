/**
 * Background service orchestrator.
 *
 * Starts and stops all long-running background services in the correct order.
 * Called from main.ts at app lifecycle events.
 */

// Retired remote-command polling is intentionally absent from the public client.
import { startAutoUpdater, stopAutoUpdater } from './auto-updater'
import {
  startConnectionHealth,
  stopConnectionHealth,
} from './connection-health'
// Workspace tools execute through the local MCP server; no background
// command subscription is started by the desktop lifecycle.
import { ensureInstalled as ensureCcRuntimeInstalled, setProgressBroadcast } from '../cc/cc-runtime-updater'
import { registerCcRuntimeHandlers } from '../cc/cc-runtime-handlers'
// Persistent localhost MCP server consumed by a compatible Agent CLI.
// It lives for the lifetime of the desktop process.
import {
  startAwpIdeServer,
  stopAwpIdeServer,
} from './awp-ide-server'
import { formatAwpIdeStartedLog } from './awp-ide-server/start-log'
// Stop any live compatible Agent CLI subprocesses during application shutdown.
import { stopAllSessions as stopCcSessions } from '../cc/cc-wrapper'
import { log } from '../utils/logger'

let started = false

/**
 * Start fail-isolated optional services after the desktop window is scheduled.
 *
 * Called once from main.ts after IPC handlers are registered. Network-backed
 * adapters remain dormant unless their own explicit configuration is valid.
 */
export async function startServices(): Promise<void> {
  if (started) return
  started = true
  log('[services] Starting all background services')

  // Local startup diagnostics are non-fatal and must not delay window creation.
  try {
    const { runStartupDiagnostic, showStartupDiagnosticDialog } = await import('./startup-diagnostic')
    const diag = await runStartupDiagnostic()
    if (!diag.ok) {
      showStartupDiagnosticDialog(diag)
    } else if (diag.warnings.length > 0) {
      log(`[services] startup warnings: ${diag.warnings.join(' | ')}`)
    }
  } catch (e) {
    log(`[services] startup-diagnostic skipped (not available): ${e instanceof Error ? e.message : String(e)}`)
  }

  // Start the desktop auto-updater; it remains governed by its own configuration.
  startAutoUpdater()

  // Connection health remains dormant unless the operator configured a validated target.
  startConnectionHealth()



  // Register on-demand connectivity status IPC. The checker itself performs no
  // network request unless a validated endpoint was explicitly configured.
  try {
    const { runConnectivityCheck, getLastConnectivityResult } = await import(
      './connectivity-check'
    )
    const { ipcMain } = await import('electron')
    // Idempotent re-registration: removeHandler is a no-op if not registered,
    // so repeated startServices() calls (tests, soft restart) don't crash.
    ipcMain.removeHandler('connectivity:check')
    ipcMain.removeHandler('connectivity:last')
    ipcMain.handle('connectivity:check', async () => {
      try {
        return await runConnectivityCheck()
      } catch (e) {
        log(`[connectivity:check] ipc err: ${e instanceof Error ? e.message : String(e)}`)
        return null
      }
    })
    ipcMain.handle('connectivity:last', () => getLastConnectivityResult())

    setTimeout(() => {
      void runConnectivityCheck().catch((e) => log(`[services] connectivity-check err: ${e instanceof Error ? e.message : String(e)}`))
    }, 10_000) // allow local services to initialize before the cached check
  } catch (e) {
    log(`[services] connectivity-check skipped (not available): ${e instanceof Error ? e.message : String(e)}`)
  }

  // Start the local workspace MCP server. Its endpoint is discovered by the
  // compatible CLI adapter when a session starts.
  try {
    // Electron owns the authoritative packaged version, avoiding path arithmetic.
    const { app: _app } = require('electron') as typeof import('electron')
    const desktopVersion = (() => {
      try { return _app.getVersion() } catch { return '0.0.0' }
    })()
    const ideStart = await startAwpIdeServer({
      desktopVersion,
      appDataRoot: _app.getPath('userData'),
    })
    log(formatAwpIdeStartedLog(ideStart))

    // Optional IPC bridge for invoking registered generic workspace tools
    // from a renderer. Re-registration remains safe across soft restarts.
    const { ipcMain: _ipcMain } = await import('electron')
    const { dispatchAwpIdeTool } = require('./awp-ide-server/tools') as typeof import('./awp-ide-server/tools')
    _ipcMain.removeHandler('awp-ide:call-tool')
    _ipcMain.handle(
      'awp-ide:call-tool',
      async (
        _ev: unknown,
        payload: { name: string; args: Record<string, unknown> },
      ) => {
        try {
          const result = await dispatchAwpIdeTool(payload.name, payload.args)
          if (result.isError) {
            const errText = result.content?.[0]?.text ?? 'unknown error'
            return { ok: false, error: errText }
          }
          // awp-ide tools return { content: [{ type: text, text: JSON }] }.
          // Parse the JSON text back to a structured object for the renderer.
          const raw = result.content?.[0]?.text ?? '{}'
          try { return { ok: true, data: JSON.parse(raw) } }
          catch { return { ok: true, data: raw } }
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
      },
    )
  } catch (e) {
    log(`[awp-ide] start failed (non-fatal; compatible CLI sessions continue without local workspace tools): ${e instanceof Error ? e.message : String(e)}`)
  }

  // 11. Provider-neutral Agent CLI runtime adapter. External executables
  //     require an explicit absolute path. Managed updates are disabled until
  //     a signed manifest is explicitly configured, then use checksum-verified
  //     staged activation without blocking the renderer.
  try {
    registerCcRuntimeHandlers()
    // Broadcast bounded download progress to active renderer windows.
    setProgressBroadcast((p) => {
      try {
        const { BrowserWindow } = require('electron')
        for (const win of BrowserWindow.getAllWindows()) {
          try { win.webContents.send('cc-runtime:progress', p) } catch { /* window gone */ }
        }
      } catch { /* electron not loaded in test contexts */ }
    })
    ensureCcRuntimeInstalled()
      .then((r) => {
        log(`[cc-runtime-updater] ${JSON.stringify(r)}`)
        // Notify active renderer windows after runtime availability changes.
        try {
          const { BrowserWindow } = require('electron')
          for (const win of BrowserWindow.getAllWindows()) {
            try { win.webContents.send('cc-runtime:installed', r) } catch { /* window gone */ }
          }
        } catch { /* electron not loaded in test contexts */ }
      })
      .catch((e) =>
        log(
          `[cc-runtime-updater] error: ${e instanceof Error ? e.message : String(e)}`,
        ),
      )
  } catch (e) {
    log(
      `[services] cc-runtime-updater skipped: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

/**
 * Hard cap on Agent CLI shutdown. Each session already attempts graceful
 * termination; this outer deadline prevents platform I/O from blocking app
 * exit indefinitely while preserving the normal clean-drain path.
 */
const CC_STOP_TIMEOUT_MS = 5_000

/**
 * Graceful shutdown of all background services.
 *
 * Called from main.ts on window-all-closed and before-quit.
 * Safe to call multiple times. Stops in reverse order.
 *
 * Returns a promise so callers may await bounded Agent CLI process cleanup.
 */
export async function stopServices(): Promise<void> {
  if (!started) return
  started = false
  log('[services] Stopping all background services')

  // Drain managed CLI sessions before stopping supporting services. The
  // public client never scans or deletes shared CLI history/config folders.
  // Drain live compatible CLI sessions with a hard timeout so `app.quit`
  // cannot be blocked by a wedged child.
  // `stopAllSessions()` asks every app-owned child to terminate cleanly.
  // A timeout keeps application shutdown bounded on every platform.

  try {
    await Promise.race([
      stopCcSessions(),
      new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), CC_STOP_TIMEOUT_MS),
      ).then((r) => {
        if (r === 'timeout') {
          log(
            `[stopServices] Agent CLI stop exceeded ${CC_STOP_TIMEOUT_MS}ms; continuing bounded shutdown`,
          )
        }
      }),
    ])
  } catch (e) {
    // Never let a CLI-side error block other shutdown bookkeeping / app quit.
    log(
      `[stopServices] cc-wrapper stop error: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  // Stop the remaining background services after managed CLI processes drain.
  stopConnectionHealth()
  stopAutoUpdater()

  // Stop the local workspace MCP server and remove its ownership lock.
  // Fire-and-forget with own error guard; not on the CLI-drain critical path.
  try {
    await stopAwpIdeServer()
  } catch (e) {
    log(`[awp-ide] stop error: ${e instanceof Error ? e.message : String(e)}`)
  }


  log('[services] All background services stopped')
}
