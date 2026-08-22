/**
 * Trusted Electron preload for the Agent Workflow Platform desktop.
 *
 * The context-isolated bridge is checked against DesktopElectronApi so a
 * missing or misspelled method fails during TypeScript verification.
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopElectronApi } from '../src/types/adr012'
import type {
  ConnectionHealthSnapshot,
  HostKeyMismatchPayload,
  UpdaterState,
} from '../src/types/bridge'
import type {
  CcStreamEventPayload,
  CcSessionExitPayload,
} from '../src/types/adr012'

// Local shell mode is captured once and exposed separately from electronAPI.
// Tests and non-Electron renderers can read the cheap boolean independently.
contextBridge.exposeInMainWorld('__AWP_LAB_MODE', process.env.AWP_LAB_MODE === '1')
contextBridge.exposeInMainWorld(
  '__AWP_HOSTED_AUTH_ENABLED',
  process.env.AWP_HOSTED_AUTH_OPT_IN === '1',
)
const demoToken = process.env.AWP_DEMO_TOKEN ?? ''
contextBridge.exposeInMainWorld(
  '__AWP_DEMO_TOKEN',
  /^[A-Za-z0-9_-]{43}$/u.test(demoToken) ? demoToken : null,
)
function normalizeDemoOrigin(value: string | undefined): string | null {
  if (!value || value !== value.trim() || value.includes('\\') || /[\u0000-\u001f\u007f%]/u.test(value)) return null
  try {
    const parsed = new URL(value)
    const hostname = parsed.hostname.toLowerCase()
    const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
    if (!loopback || parsed.protocol !== 'http:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') return null
    return parsed.origin
  } catch {
    return null
  }
}
contextBridge.exposeInMainWorld('__AWP_DEMO_ORIGIN', normalizeDemoOrigin(process.env.AWP_DEMO_ORIGIN))

contextBridge.exposeInMainWorld('electronAPI', {
  // ---- Auth & identity ----
  save_customer_id: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('bridge:save-customer-id', id),

  save_token: (token: string): Promise<boolean> =>
    ipcRenderer.invoke('bridge:save-token', token),

  save_auth: (token: string, customer_id: string, email: string): Promise<boolean> =>
    ipcRenderer.invoke('bridge:save-auth', token, customer_id, email),

  get_auth: (): Promise<{ token: string; customer_id: string; email: string } | null> =>
    ipcRenderer.invoke('bridge:get-auth'),

  // ---- Settings ----
  save_settings: (data: unknown, customer_id?: string): Promise<boolean> =>
    ipcRenderer.invoke('bridge:save-settings', data, customer_id),

  load_settings: (customer_id?: string): Promise<unknown> =>
    ipcRenderer.invoke('bridge:load-settings', customer_id),

  // ---- Remote workspace SSH ----
  // Legacy renderer SSH-test IPC is intentionally absent. Internal workspace
  // services use the guarded main-process SSH transport directly.
  // Auto-updater status — pull current snapshot.
  get_updater_state: (): Promise<UpdaterState> =>
    ipcRenderer.invoke('bridge:updater-state'),

  // Subscribe to updater state changes. Returns an unsubscribe function.
  on_updater_status: (cb: (state: UpdaterState) => void): (() => void) => {
    const listener = (_event: unknown, state: UpdaterState) => { cb(state) }
    ipcRenderer.on('updater:status', listener)
    return () => { ipcRenderer.removeListener('updater:status', listener) }
  },

  // Fires after an explicitly configured managed runtime is staged and activated.
  // The renderer refreshes availability without requiring an app restart.
  on_cc_runtime_installed: (cb: (info: unknown) => void): (() => void) => {
    const listener = (_event: unknown, info: unknown) => { cb(info) }
    ipcRenderer.on('cc-runtime:installed', listener)
    return () => { ipcRenderer.removeListener('cc-runtime:installed', listener) }
  },

  // Reports download, verification, and atomic staging progress for an
  // explicitly configured managed executable.
  on_cc_runtime_progress: (cb: (info: {
    stage: 'idle' | 'downloading' | 'verifying' | 'staging' | 'done' | 'error'
    bytesDownloaded: number
    bytesTotal: number
    version: string | null
    error?: string
  }) => void): (() => void) => {
    const listener = (_event: unknown, info: unknown) => { cb(info as Parameters<typeof cb>[0]) }
    ipcRenderer.on('cc-runtime:progress', listener)
    return () => { ipcRenderer.removeListener('cc-runtime:progress', listener) }
  },

  // One-shot snapshot for renderers that mount after download already started.
  cc_runtime_progress: (): Promise<{
    stage: 'idle' | 'downloading' | 'verifying' | 'staging' | 'done' | 'error'
    bytesDownloaded: number
    bytesTotal: number
    version: string | null
    error?: string
  }> =>
    ipcRenderer.invoke('bridge:cc-runtime-progress'),

  // User clicked "立即重启" on the update banner.
  updater_quit_install: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('bridge:updater-quit-install'),

  // User clicked "立即下载" on the update banner (no silent auto-download).
  updater_download: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('bridge:updater-download'),

  // User clicked "检查更新" in Settings — triggers an immediate check + the
  // resulting state flows back via 'updater:status' (subscribe via
  // on_updater_status). Returns ok=true once the check is dispatched; the
  // actual outcome (available / not-available / downloading / ready / error)
  // arrives asynchronously through the status channel.
  updater_check_now: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('bridge:updater-check-now'),

  bridge_status: (): Promise<{
    bridge_alive: boolean
    gateway_alive: boolean
    tunnel_alive: boolean
    tunnel_status: string
    has_config: boolean
    has_key: boolean
    diag: string
  }> =>
    ipcRenderer.invoke('bridge:bridge-status'),

  // ---- Transport host-key mismatch (MITM guard) ----
  // Only opaque references and short fingerprint fragments cross the bridge.
  on_host_key_mismatch: (
    cb: (payload: HostKeyMismatchPayload) => void,
  ): (() => void) => {
    const listener = (_event: unknown, payload: HostKeyMismatchPayload): void => { cb(payload) }
    ipcRenderer.on('transport:host-key-mismatch', listener)
    return () => { ipcRenderer.removeListener('transport:host-key-mismatch', listener) }
  },

  // Clear exactly one existing opaque host entry; clear-all is not exposed.
  clear_known_hosts: (hostId: string): Promise<{ ok: boolean; removed: number; error?: string }> =>
    ipcRenderer.invoke('bridge:clear-known-hosts', hostId),

  // ---- Secure credential storage (safeStorage 加密凭据) ----
  set_credential: (key: string, value: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('secure:set-credential', key, value),

  get_credential: (key: string): Promise<{ ok: boolean; value?: string; error?: string }> =>
    ipcRenderer.invoke('secure:get-credential', key),

  delete_credential: (key: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('secure:delete-credential', key),

  // ---- Connection-Health panel ----
  // Returns the cached snapshot synchronously (fast path for first paint).
  get_connection_health: (): Promise<ConnectionHealthSnapshot> =>
    ipcRenderer.invoke('connection-health:get'),

  // Subscribe to push updates from the SSE consumer in main. Returns an
  // unsubscribe fn.
  on_connection_health: (cb: (snap: ConnectionHealthSnapshot) => void): (() => void) => {
    const listener = (_event: unknown, snap: ConnectionHealthSnapshot): void => { cb(snap) }
    ipcRenderer.on('connection-health:update', listener)
    return () => { ipcRenderer.removeListener('connection-health:update', listener) }
  },

  // ---- Connectivity preflight (T-CU09) ----
  // Two-shot surface for ConnectionStatusDot tooltip:
  //   - connectivityLast: read the cached result from the startup probe, no
  //     network cost. Returns null when the preflight hasn't run yet.
  //   - connectivityCheck: force a fresh probe run and update the cache.
  // The main-process preflight never contacts a service unless a strict
  // control-plane URL was explicitly configured.
  connectivityCheck: (): Promise<{
    cloud_http: 'ok' | 'fail' | 'skipped'
    cloud_sse: 'ok' | 'fail' | 'skipped'
    vm_ssh: 'ok' | 'fail' | 'skipped'
    details: Record<string, string>
    checked_at_ms: number
  } | null> =>
    ipcRenderer.invoke('connectivity:check'),

  connectivityLast: (): Promise<{
    cloud_http: 'ok' | 'fail' | 'skipped'
    cloud_sse: 'ok' | 'fail' | 'skipped'
    vm_ssh: 'ok' | 'fail' | 'skipped'
    details: Record<string, string>
    checked_at_ms: number
  } | null> =>
    ipcRenderer.invoke('connectivity:last'),

  // ---- Startup self-test (user-triggered re-run) ----
  // Re-run launch checks after a local configuration change without restarting.
  run_startup_diagnostic: (): Promise<{
    ok: boolean
    failures: string[]
    warnings: string[]
    error?: string
  }> =>
    ipcRenderer.invoke('startup:run-diagnostic'),

  // ---- Provider-neutral Agent CLI runtime adapter ----
  // External executables require an explicit absolute path. Managed updates
  // require an explicitly configured signed manifest; the default is disabled.
  cc_runtime_status: (): Promise<{
    currentVersion: string | null
    lastCheckMs: number
    lastUpdateMs: number
    updating: boolean
    available: boolean
    source: 'external' | 'managed' | 'disabled'
  }> =>
    ipcRenderer.invoke('cc-runtime:status'),

  cc_runtime_check_now: (): Promise<{
    updated: boolean
    from?: string
    to?: string
    error?: string
  }> =>
    ipcRenderer.invoke('cc-runtime:check-now'),

  cc_runtime_force_update: (): Promise<{
    updated: boolean
    from?: string
    to?: string
    error?: string
  }> =>
    ipcRenderer.invoke('cc-runtime:force-update'),

  // Return the explicitly configured or verified managed executable path.
  cc_runtime_get_cli_path: (): Promise<string | null> =>
    ipcRenderer.invoke('cc-runtime:get-cli-path'),


  // ---- Agent CLI subprocess lifecycle ----
  // Owns one configured CLI child process per conversation and streams
  // provider-compatible events back to the renderer.
  cc_start: (opts: { conversationId: string; cwd?: string; model?: string; ccSessionId?: string }):
      Promise<{ ok: boolean; sessionId?: string; error?: string }> =>
    ipcRenderer.invoke('cc:start', opts),

  cc_send_message: (opts: { sessionId: string; content: string; attachments?: unknown[] }):
      Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('cc:send-message', opts),

  cc_stop: (opts: { sessionId: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('cc:stop', opts),

  cc_status: (opts: { sessionId: string }): Promise<{
    phase: 'spawning' | 'idle' | 'streaming' | 'exited' | 'unknown'
    pid?: number
    model?: string
  }> =>
    ipcRenderer.invoke('cc:status', opts),

  // Read the most recent compatible Agent CLI diagnostic log. Used by the chat
  // error-bubble UI to show a diagnostic affordance when the runtime
  // process exits unexpectedly (cc_error_during_execution etc.).
  cc_get_last_stderr_log: (): Promise<{
    path: string
    content: string
    full_size: number
  } | null> =>
    ipcRenderer.invoke('cc:get-last-stderr-log'),

  cc_on_stream_event: (
    cb: (payload: CcStreamEventPayload) => void,
  ): (() => void) => {
    const listener = (_e: unknown, payload: CcStreamEventPayload) => { cb(payload) }
    ipcRenderer.on('cc:stream-event', listener)
    return () => { ipcRenderer.removeListener('cc:stream-event', listener) }
  },

  cc_on_session_exit: (
    cb: (payload: CcSessionExitPayload) => void,
  ): (() => void) => {
    const listener = (_e: unknown, payload: CcSessionExitPayload) => { cb(payload) }
    ipcRenderer.on('cc:session-exit', listener)
    return () => { ipcRenderer.removeListener('cc:session-exit', listener) }
  },

  // Real desktop MCP notification event.
  awp_ide_on_notify_user: (
    cb: (payload: { message: string; level: 'info' | 'success' | 'warning' | 'error'; duration_ms: number }) => void,
  ): (() => void) => {
    const listener = (_e: unknown, p: { message: string; level: 'info' | 'success' | 'warning' | 'error'; duration_ms: number }) => { cb(p) }
    ipcRenderer.on('awp-ide:notify-user', listener)
    return () => { ipcRenderer.removeListener('awp-ide:notify-user', listener) }
  },

  // Focus an artifact after the main process validates an internal awp:// link.
  awp_ide_on_focus_artifact: (
    cb: (payload: { artifactId: string }) => void,
  ): (() => void) => {
    const listener = (_e: unknown, p: { artifactId: string }) => { cb(p) }
    ipcRenderer.on('awp-ide:focus-artifact', listener)
    return () => { ipcRenderer.removeListener('awp-ide:focus-artifact', listener) }
  },
  // Invoke a registered generic desktop MCP tool from the renderer.
  awp_ide_call_tool: (
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; data?: unknown; error?: string }> => {
    return ipcRenderer.invoke('awp-ide:call-tool', { name, args })
  },
} satisfies DesktopElectronApi)
