/**
 * Common paths and configuration readers for AgentWorkflowPlatform Desktop.
 *
 * All data lives under ~/.awp (backward compat with pywebview launcher).
 */

import path from 'node:path'
import os from 'node:os'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { log } from './logger'
import { secureGetCredential } from './credentials'
import { normalizeServiceBaseUrl } from './service-base-url'
import type { SettingsData, SshConfig } from '../ipc/types'

// ---------------------------------------------------------------------------
// Canonical paths — channel-aware (Stable / Insiders / Dev)
// ---------------------------------------------------------------------------

/**
 * Resolve the userData directory for this channel.
 *
 * Pure env-based derivation — the Electron runtime sets
 * `process.env.AWP_CHANNEL` from `bootstrap/channel.ts` at module load
 * time (before anything else imports this file), so we never need to touch
 * `electron` here. Vitest and standalone scripts hit the same code path;
 * they can override via NODE_ENV / AWP_CHANNEL.
 *
 *   NODE_ENV=development        -> ~/.awp-dev
 *   AWP_CHANNEL=insiders   -> ~/.awp-insiders
 *   otherwise                   -> ~/.awp
 *
 * Deliberately does NOT import `electron` — keeps config.ts usable from any
 * runtime and avoids module-load-order differences between Electron, tests,
 * and standalone tools.
 */
function resolveAwpDir(): string {
  // Electron bootstrap writes the authoritative path after applying its
  // packaged/test gate. Standalone unit tests may opt into an absolute override
  // only with the exact test flag; production never trusts AWP_USER_DATA_DIR.
  const bootstrapped = process.env.AWP_RESOLVED_USER_DATA_DIR
  if (bootstrapped && path.isAbsolute(bootstrapped)) return path.resolve(bootstrapped)
  const testOverride = process.env.AWP_USER_DATA_DIR
  if (
    process.env.NODE_ENV === 'test'
    && process.env.AWP_TEST_USER_DATA_DIR_OPT_IN === '1'
    && testOverride
    && path.isAbsolute(testOverride)
  ) {
    return path.resolve(testOverride)
  }

  const channel = (process.env.AWP_CHANNEL ?? '').toLowerCase()
  const isDev = process.env.NODE_ENV === 'development'
  if (isDev) return path.join(os.homedir(), '.awp-dev')
  if (channel === 'insiders') return path.join(os.homedir(), '.awp-insiders')
  return path.join(os.homedir(), '.awp')
}

/**
 * Base directory for all AgentWorkflowPlatform user data (channel-aware).
 *
 * ***Lazy by design*** — module-body eager eval would run before `main.ts`
 * gets a chance to call `app.setPath('userData', ...)`, because ES imports
 * resolve before main.ts's top-level statements execute. The first importer
 * (e.g. `ipc/handlers.ts` via `main.ts:12`) would freeze `AWP_DIR` at
 * Electron's default userData path (`%APPDATA%/Agent Workflow Platform Insiders`) instead
 * of `~/.awp-insiders`, silently breaking the Stable/Insiders channel
 * split that auth/credentials/known_hosts all rely on.
 *
 * Solution: a cached getter. First call is always after `app.setPath` has
 * run (it fires from IPC handlers, services, etc. — all registered inside
 * `app.whenReady()`), so `app.getPath('userData')` returns the correct dir.
 */
let _cachedAwpDir: string | null = null

export function getAwpDir(): string {
  if (_cachedAwpDir === null) {
    _cachedAwpDir = resolveAwpDir()
  }
  return _cachedAwpDir
}

/** Explicitly provisioned SSH private key in the app-owned private tree. */
export function getSshKeyPath(): string {
  return path.join(getAwpDir(), 'private', 'keys', 'awp_vm_key')
}

/** Tunnel status file written by the keepalive service. */
export function getTunnelStatusPath(): string {
  return path.join(getAwpDir(), 'tunnel_status.json')
}

/** VM setup progress file (polled by frontend). */
export function getSetupProgressPath(): string {
  return path.join(getAwpDir(), 'setup_progress.json')
}

/** Auth JSON persisted across restarts. */
export function getAuthPath(): string {
  return path.join(getAwpDir(), 'auth.json')
}

/** Customer ID file. */
export function getCustomerIdPath(): string {
  return path.join(getAwpDir(), 'customer_id')
}

/** API token file. */
export function getApiTokenPath(): string {
  return path.join(getAwpDir(), 'api_token')
}

/** Launch log file. */
export function getLogPath(): string {
  return path.join(getAwpDir(), 'launch.log')
}

/**
 * Ensure the AgentWorkflowPlatform data directory exists.
 *
 * Idempotent — safe to call from any IO path that writes under getAwpDir().
 */
export function ensureAwpDir(): void {
  mkdirSync(getAwpDir(), { recursive: true })
}

// ---------------------------------------------------------------------------
// Config readers
// ---------------------------------------------------------------------------

/** Resolve the validated chat-adapter base used by explicit Electron callers. */
export function getApiBase(): string {
  const envBase = process.env.AWP_API_BASE || process.env.AWP_API_URL
  if (envBase) {
    const normalized = normalizeServiceBaseUrl(envBase)
    if (!normalized) throw new Error('invalid_api_base')
    return normalized
  }

  try {
    const settings = loadGlobalSettings() as Record<string, unknown> | null
    const configured = settings?.['serverUrl'] ?? settings?.['apiBase']
    if (typeof configured === 'string' && configured) {
      const normalized = normalizeServiceBaseUrl(configured)
      if (!normalized) throw new Error('invalid_api_base')
      return normalized
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'invalid_api_base') throw error
  }

  return 'http://127.0.0.1:8787'
}

/** Read the generic remote-workspace SSH configuration. */
export function getSshConfig(): SshConfig | null {
  try {
    const settings = loadGlobalSettings()
    const remote = settings?.remote
    if (!remote?.sshUser) return null
    return {
      user: remote.sshUser,
      host: remote.vmHost ?? '127.0.0.1',
      port: remote.sshPort ?? 2222,
    }
  } catch {
    return null
  }
}

/** Return the configured remote agent identifier, when present. */
export function getActiveAgentId(): string | null {
  try {
    const settings = loadGlobalSettings() as Record<string, unknown> | null
    const remote = (settings?.['remote'] ?? {}) as Record<string, unknown>
    const id = remote['activeAgentId']
    return typeof id === 'string' && id.length > 0 ? id : null
  } catch {
    return null
  }
}
/** Build hosted Authorization headers exclusively from encrypted storage. */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  if (process.env.AWP_HOSTED_AUTH_OPT_IN !== '1') return {}
  try {
    const credential = await secureGetCredential('auth_token')
    if (!credential.ok || typeof credential.value !== 'string') return {}
    const token = credential.value.trim()
    return token ? { Authorization: `Bearer ${token}` } : {}
  } catch {
    return {}
  }
}
// ---------------------------------------------------------------------------
// Service helpers (used by background services)
// ---------------------------------------------------------------------------

/**
 * Write tunnel status to file for the frontend to read.
 *
 * Port of: launch.py _write_tunnel_status()
 */
export function writeTunnelStatus(status: string, errorMsg = ''): void {
  try {
    const tunnelStatusPath = getTunnelStatusPath()
    mkdirSync(path.dirname(tunnelStatusPath), { recursive: true })
    writeFileSync(
      tunnelStatusPath,
      JSON.stringify({
        status,
        error: errorMsg,
        timestamp: new Date().toISOString(),
      }),
      'utf-8',
    )
  } catch {
    // Non-critical — frontend will see stale status
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function loadGlobalSettings(): SettingsData | null {
  const settingsPath = path.join(getAwpDir(), 'settings.json')
  if (!existsSync(settingsPath)) return null
  return JSON.parse(readFileSync(settingsPath, 'utf-8')) as SettingsData
}
