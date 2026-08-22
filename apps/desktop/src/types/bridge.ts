export interface AuthData {
  token: string
  customer_id: string
  email: string
}

export interface BridgeStatusResult {
  bridge_alive: boolean
  gateway_alive: boolean
  tunnel_alive: boolean
  tunnel_status: string
  has_config: boolean
  has_key: boolean
  diag: string
  error?: string
}

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

/** safeStorage 凭据操作结果 */
export interface CredentialResult {
  ok: boolean
  value?: string
  error?: string
}

/**
 * Allow-listed credential keys accepted by `secure:*-credential` IPC.
 *
 * This is the renderer-side mirror of `electron/ipc/credential-keys.ts`.
 * The main process is the real security boundary: it will reject any key
 * outside its own `CREDENTIAL_KEYS` list. Mirroring the literal union here
 * gives renderer callers a compile-time error if they mistype a key
 * (e.g. `setCredential('authToken', ...)`) instead of a silent runtime
 * rejection after shipping.
 *
 * If you add a key: update both this union AND `electron/ipc/credential-keys.ts`.
 * Any drift between the two ends up rejected by main at runtime.
 */
export type CredentialKey = 'auth_token' | 'token' | 'sshPassword'

/**
 * Payload of the `transport:host-key-mismatch` IPC event, emitted when the
 * SSH host key of the configured VM has changed since the last successful
 * connection. The transport layer refuses the new connection; the renderer
 * surfaces a toast/modal explaining how to recover.
 */
export interface HostKeyMismatchPayload {
  /** Opaque SHA-256 reference; no endpoint or local path is exposed. */
  hostId: string
  /** Short non-secret fragment of the previously stored fingerprint. */
  stored_fp: string
  /** Short non-secret fragment of the just-received fingerprint. */
  received_fp: string
}

/**
 * Desktop ConnectionHealth panel wire shape — mirrors
 * `cloud/routes/agent_status._snapshot_for_customer` + a few client-side
 * fields populated by `electron/services/connection-health.ts`.
 */
export type ConnectionHealthState =
  | 'connecting'
  | 'online'
  | 'degraded'
  | 'offline'
  | 'error'
  | 'unknown'

export interface ConnectionHealthSnapshot {
  state: ConnectionHealthState
  agent_id: string | null
  last_heartbeat: string | null
  last_heartbeat_age_s: number | null
  transport: string
  active_tasks: number
  version: string
  uptime_s: number | null
  recent_errors: string[]
  hostname: string
  /** Client-side wall clock at which the snapshot was received (ms epoch). */
  received_at_ms: number
  /** Last transport error (null when healthy). */
  last_error: string | null
}

export interface DesktopBridge {
  save_customer_id(id: string): Promise<boolean>
  save_token(token: string): Promise<boolean>
  save_auth(token: string, customer_id: string, email: string): Promise<boolean>
  get_auth(): Promise<AuthData | null>
  save_settings(data: unknown, customer_id?: string): Promise<boolean>
  load_settings(customer_id?: string): Promise<unknown | null>
  get_updater_state(): Promise<UpdaterState>
  on_updater_status(cb: (state: UpdaterState) => void): () => void
  /**
   * 1.7.41: fires once when cc-runtime-updater finishes the first-launch
   * background install. Renderer subscribes to flip
   * __CC_LOCAL_RUNTIME_AVAILABLE without an app restart so the very next
   * chat advertises `cc-on-desktop` and bypasses the ADR-016 shield.
   */
  on_cc_runtime_installed?(cb: (info: unknown) => void): () => void
  updater_quit_install(): Promise<{ ok: boolean; error?: string }>
  /**
   * UpdateBanner "立即下载" button. Kicks off a manual download of the
   * already-detected update. No silent auto-download — present only in
   * Electron runtime (pywebview builds lack this; UpdateBanner feature-
   * detects).
   */
  updater_download?(): Promise<{ ok: boolean; error?: string }>
  /**
   * Settings panel "检查更新" button — fire an immediate check-for-updates
   * regardless of the 30-min polling cycle. Returns ok=true once the check
   * is dispatched; the actual outcome arrives via on_updater_status.
   */
  updater_check_now?(): Promise<{ ok: boolean; error?: string }>
  bridge_status(): Promise<BridgeStatusResult>
  /**
   * Subscribe to host-key-mismatch events. Returns an unsubscribe function.
   * Only present in Electron runtime; may be undefined under pywebview.
   */
  on_host_key_mismatch?(cb: (payload: HostKeyMismatchPayload) => void): () => void
  /** Remove exactly one validated host entry; clearing the full store is unsupported. */
  clear_known_hosts?(hostId: string): Promise<{ ok: boolean; removed: number; error?: string }>
  // safeStorage 加密凭据操作 — key 必须是 allow-listed `CredentialKey`，
  // main-process 会对任何陌生 key 直接拒绝（见 electron/ipc/credential-keys.ts）。
  set_credential(key: CredentialKey, value: string): Promise<CredentialResult>
  get_credential(key: CredentialKey): Promise<CredentialResult>
  delete_credential(key: CredentialKey): Promise<CredentialResult>

  /**
   * ConnectionHealth panel — pull the last cached snapshot for immediate
   * first paint. Only present in Electron runtime.
   */
  get_connection_health?(): Promise<ConnectionHealthSnapshot>
  /** Subscribe to push updates from the main-process SSE consumer. Returns unsubscribe. */
  on_connection_health?(cb: (snap: ConnectionHealthSnapshot) => void): () => void
  /**
   * Re-run the launch-time self-test on demand (Settings → 诊断与支持).
   * Same checks that fire automatically at startup — used after the operator
   * fixes something (SSH key perms, safeStorage, userData writability, …)
   * and wants to confirm without restarting the app. Resolves structured
   * failures + warnings for in-page rendering; never rejects.
   * Only present in Electron runtime — pywebview leaves it undefined and the
   * UI feature-detects before calling.
   */
  run_startup_diagnostic?(): Promise<{
    ok: boolean
    failures: string[]
    warnings: string[]
    error?: string
  }>

  /**
   * Connectivity preflight (T-CU09) — three-probe snapshot wired into the
   * top-right status dot tooltip. `connectivityLast` reads the cached result
   * (no network cost, may be null before the startup probe fires);
   * `connectivityCheck` forces a fresh run and refreshes the cache.
   * Only present in Electron runtime.
   */
  connectivityLast?(): Promise<ConnectivityCheckResult | null>
  connectivityCheck?(): Promise<ConnectivityCheckResult | null>

}

/**
 * Result of the explicit connectivity preflight. Mirrors
 * `electron/services/connectivity-check.ts::ConnectivityCheckResult` — kept
 * loose (unions of string literals) so the renderer doesn't have to import
 * from the main-process sources.
 */
export interface ConnectivityCheckResult {
  cloud_http: 'ok' | 'fail' | 'skipped'
  cloud_sse: 'ok' | 'fail' | 'skipped'
  vm_ssh: 'ok' | 'fail' | 'skipped'
  /** Human-readable per-probe explanation, keyed by probe name. */
  details: Record<string, string>
  /** Wall-clock (ms epoch) of when the result was produced. */
  checked_at_ms: number
}
