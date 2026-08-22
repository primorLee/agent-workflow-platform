/**
 * Shared type definitions for IPC handlers.
 */

// ---- Auth ----

export interface AuthData {
  token: string
  customer_id: string
  email: string
  /**
   * Present when the safeStorage-backed token read failed (decrypt error,
   * encryption unavailable, FS permission). F6 (2026-04-19 audit, P1): the
   * renderer must treat this as a "re-prompt login" signal rather than
   * silently seeing `token: ''` and falling into the "not logged in" state
   * with no diagnostic trail. The detail string is a debug aid for support
   * bundles — the actual token value is NEVER surfaced here.
   */
  credential_error?: string
}

// ---- Settings ----

/** Settings are free-form JSON; the typed remote key configures SSH/agent access. */
export interface SettingsData {
  remote?: RemoteSettings
  [key: string]: unknown
}

export interface RemoteSettings {
  sshUser?: string
  sshPort?: number
  vmHost?: string
  vmrunPath?: string
  vmxPath?: string
}

// ---- SSH ----

/**
 * v1.5.12 Fix 3: test-ssh now returns classified error metadata so the
 * renderer can render actionable hints (copy-command button, help link)
 * instead of the generic "check port/username/password" one-liner.
 *
 * `output` stays for backward compat (legacy web-fallback store still reads
 * it). When `ok === false`, UI code should prefer `kind/title/hint/action`
 * and only show `raw` inside a <details> panel.
 */
export type SshErrorKind =
  | 'handshake-timeout'
  | 'auth-failed'
  | 'connection-refused'
  | 'host-unreachable'
  | 'dns-fail'
  | 'host-key-mismatch'
  | 'algo-mismatch'
  | 'reset'
  | 'firewall-blocked'
  | 'unknown'

export interface SshErrorAction {
  label: string
  command?: string
  link?: string
}

export interface SshTestResult {
  ok: boolean
  output: string
  kind?: SshErrorKind
  title?: string
  hint?: string
  action?: SshErrorAction
  raw?: string
}

export interface SshConfig {
  user: string
  host: string
  port: number
}

// ---- Bridge / Gateway ----

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

export interface SkillResult {
  ok: boolean
  result?: string
  error?: string
}
