/**
 * IPC handler registration — all 13 bridge methods.
 *
 * Each handler corresponds to a window.electronAPI.xxx() call from the renderer.
 * Port of the Python AppBridge class from launch.py.
 */

import { ipcMain, BrowserWindow } from 'electron'
import {
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
} from 'node:fs'
import path from 'node:path'
import { log, logError } from '../utils/logger'
import {
  getAwpDir,
  getAuthPath,
  getCustomerIdPath,
  ensureAwpDir,
} from '../utils/config'
import {
  secureGetCredential,
  secureSetCredential,
  secureDeleteCredential,
} from '../utils/credentials'
import { isEncryptedStorage } from '../utils/safe-storage-compat'
import {
  readLegacyAuthFile,
  removeLegacyAuthFile,
  replaceLegacyAuthFile,
} from '../utils/legacy-auth-migration'
import { isCredentialKey } from './credential-keys'
import type {
  AuthData,
  BridgeStatusResult,
} from './types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Regex for validating customer_id — 用于拼接 settings_${id}.json / preferences_${id}.json 文件名。
 * 严格约束 [a-zA-Z0-9_-] 与长度 1..64，防止 path traversal（`../`）、分隔符注入（`/`, `\`）、
 * Windows 保留字符（`:`, `*`, `?`, `"`, `<`, `>`, `|`）和 NUL 字节。
 */
const CUSTOMER_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/

/** Type-narrowing 校验：凡是要把 customer_id 拼进文件名的入口都必须先过这关。 */
function isValidCustomerId(id: unknown): id is string {
  return typeof id === 'string' && CUSTOMER_ID_RE.test(id)
}

/** Hosted credential storage is disabled unless the operator opts in exactly. */
function isHostedAuthEnabled(): boolean {
  return process.env.AWP_HOSTED_AUTH_OPT_IN === '1'
}

function hostedAuthDisabled(): { ok: false; error: string } {
  return { ok: false, error: 'hosted_auth_disabled' }
}

function identifierOperationErrorKind(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as NodeJS.ErrnoException).code
    if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(code)) return code
    if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error.name)) return error.name
  }
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Background task state (mirrors Python class-level state)
// ---------------------------------------------------------------------------

// setupWorker / setupResult / setupRunning module-level state REMOVED 2026-05-21
// alongside the bridge:setup-vm handler. bridge:get-setup-progress is now a
// permanent no-op (done=true, result=null) — legacy ChatView slide-over still
// polls it but never starts a setup, so progress is always "nothing to report".

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJsonSafe<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T
  } catch {
    return null
  }
}

function writeJsonSafe(filePath: string, data: unknown): void {
  ensureAwpDir()
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

// sshConnectAndTest + emitSshProgress + activeConn/activeDone REMOVED 2026-05-21
// alongside the bridge:test-ssh / test_ssh:cancel handlers (renderer-facing SSH
// onboarding deprecated; Agent mode only). Internal operator services still use ssh2.


// ---------------------------------------------------------------------------
// Legacy auth.json → safeStorage token migration
// ---------------------------------------------------------------------------

/** Hosted-only legacy migration: validate, encrypt, then remove plaintext. */
export async function migratePlaintextApiToken(): Promise<void> {
  if (!isHostedAuthEnabled()) return
  if (!isEncryptedStorage()) {
    notifyMigrationFailure('plaintext_api_token', 'encryption_unavailable')
    return
  }
  try {
    const record = readLegacyAuthFile(getAwpDir(), 'api_token')
    if (!record) return
    const token = record.buffer.toString('utf8').trim()
    if (token) {
      const result = await secureSetCredential('auth_token', token)
      if (!result.ok) {
        notifyMigrationFailure('plaintext_api_token', result.error ?? 'credential_write_failed')
        return
      }
    }
    removeLegacyAuthFile(record)
    log('[migration] legacy api token migrated or removed')
  } catch (error) {
    notifyMigrationFailure('plaintext_api_token', migrationErrorKind(error))
  }
}

async function migrateLegacyAuthToken(): Promise<void> {
  if (!isHostedAuthEnabled()) return
  if (!isEncryptedStorage()) {
    notifyMigrationFailure('legacy_auth_metadata', 'encryption_unavailable')
    return
  }
  try {
    const record = readLegacyAuthFile(getAwpDir(), 'auth.json')
    if (!record) return
    let raw: unknown
    try {
      raw = JSON.parse(record.buffer.toString('utf8'))
    } catch {
      throw new Error('legacy_auth_json_invalid')
    }
    if (!isPlainRecord(raw)) throw new Error('legacy_auth_json_invalid')
    if (raw['migrated'] === true && !Object.prototype.hasOwnProperty.call(raw, 'token')) return

    const token = typeof raw['token'] === 'string' ? raw['token'].trim() : ''
    if (token) {
      const result = await secureSetCredential('auth_token', token)
      if (!result.ok) {
        notifyMigrationFailure('legacy_auth_metadata', result.error ?? 'credential_write_failed')
        return
      }
    }
    const stripped = {
      customer_id: typeof raw['customer_id'] === 'string' ? raw['customer_id'] : '',
      email: typeof raw['email'] === 'string' ? raw['email'] : '',
      migrated: true,
    }
    replaceLegacyAuthFile(record, `${JSON.stringify(stripped, null, 2)}\n`)
    log('[migration] legacy auth metadata migrated')
  } catch (error) {
    notifyMigrationFailure('legacy_auth_metadata', migrationErrorKind(error))
  }
}

function notifyMigrationFailure(kind: string, error: unknown): void {
  const payload = { kind, errorKind: migrationErrorKind(error) }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send('credentials:migration-failed', payload)
    } catch {
      // A closing renderer does not change migration state.
    }
  }
}

function migrationErrorKind(error: unknown): string {
  const raw = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
  if (/^[a-z][a-z0-9_]{0,63}$/u.test(raw)) return raw
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (typeof code === 'string' && /^[A-Z0-9_]{1,32}$/u.test(code)) return code.toLowerCase()
  return 'migration_failed'
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerIpcHandlers(): void {
  log('[ipc] Registering IPC handlers')

  // Legacy hosted credentials are inspected only after an exact operator opt-in.
  if (isHostedAuthEnabled()) {
    void migrateLegacyAuthToken()
    void migratePlaintextApiToken()
  }

  // 1. save-customer-id — customer_id 会被拼进文件名，必须严格校验
  ipcMain.handle('bridge:save-customer-id', async (_event, id: unknown): Promise<boolean> => {
    try {
      if (!isValidCustomerId(id)) {
        log('save-customer-id: rejected invalid identifier')
        return false
      }
      ensureAwpDir()
      writeFileSync(getCustomerIdPath(), id, 'utf-8')
      log('Customer identifier saved')
      return true
    } catch (err) {
      log(`save-customer-id failed: error_kind=${identifierOperationErrorKind(err)}`)
      return false
    }
  })

  // 2. save-token — encrypted hosted credential plus validated legacy cleanup.
  ipcMain.handle('bridge:save-token', async (_event, token: unknown): Promise<boolean> => {
    if (!isHostedAuthEnabled()) return false
    if (typeof token !== 'string') return false
    const result = await secureSetCredential('auth_token', token)
    if (!result.ok) return false
    try {
      const legacy = readLegacyAuthFile(getAwpDir(), 'api_token')
      if (legacy) removeLegacyAuthFile(legacy)
    } catch (error) {
      log(`[save-token] legacy_cleanup_error_kind=${migrationErrorKind(error)}`)
    }
    return true
  })
  // 3. save-auth
  // 安全：token 走 safeStorage（secureSetCredential('auth_token', token)），不再落 auth.json；
  // customer_id / email 非敏感，明文写 auth.json 并打 migrated:true 标记。
  // 兼容性：仍然返回 boolean（旧契约），token 加密失败直接返回 false 让上层感知。
  ipcMain.handle(
    'bridge:save-auth',
    async (_event, token: unknown, customer_id: unknown, email: unknown): Promise<boolean> => {
      if (!isHostedAuthEnabled()) return false
      try {
        if (typeof token !== 'string' || typeof email !== 'string') {
          return false
        }
        if (!isValidCustomerId(customer_id)) {
          log('save-auth: rejected invalid customer identifier')
          return false
        }

        // token 加密入 safeStorage
        if (token) {
          const res = await secureSetCredential('auth_token', token)
          if (!res.ok) {
            log(`save-auth: secureSetCredential failed: ${res.error ?? 'unknown'}`)
            return false
          }
        }

        // 非敏感字段写 auth.json（剥离 token）
        const stripped: Record<string, unknown> = {
          customer_id,
          email,
          migrated: true,
        }
        writeJsonSafe(getAuthPath(), stripped)
        return true
      } catch (err) {
        log(`save-auth failed: error_kind=${identifierOperationErrorKind(err)}`)
        return false
      }
    },
  )

  // 4. get-auth — encrypted token plus non-sensitive profile metadata.
  ipcMain.handle('bridge:get-auth', async (): Promise<AuthData | null> => {
    if (!isHostedAuthEnabled()) return null
    try {
      const meta = readJsonSafe<Record<string, unknown>>(getAuthPath())
      const customer_id = typeof meta?.['customer_id'] === 'string' ? meta['customer_id'] : ''
      const email = typeof meta?.['email'] === 'string' ? meta['email'] : ''
      const credential = await secureGetCredential('auth_token')
      const token = credential.ok && typeof credential.value === 'string' ? credential.value : ''
      const credentialError = credential.ok
        ? undefined
        : migrationErrorKind(credential.error ?? 'credential_read_failed')
      if (!token && !customer_id && !email && !credentialError) return null
      const result: AuthData = { token, customer_id, email }
      if (credentialError) result.credential_error = credentialError
      return result
    } catch (error) {
      log(`[get-auth] error_kind=${migrationErrorKind(error)}`)
      return null
    }
  })
  // 5. save-settings — customer_id 拼文件名，必须过 CUSTOMER_ID_RE
  ipcMain.handle(
    'bridge:save-settings',
    async (_event, data: unknown, customer_id?: unknown): Promise<boolean> => {
      try {
        let fname = 'settings.json'
        if (customer_id !== undefined && customer_id !== null && customer_id !== '') {
          if (!isValidCustomerId(customer_id)) {
            log(`save-settings: rejected invalid customer_id`)
            return false
          }
          fname = `settings_${customer_id}.json`
        }
        const filePath = path.join(getAwpDir(), fname)
        writeJsonSafe(filePath, data)
        return true
      } catch (err) {
        log(`save-settings failed: error_kind=${identifierOperationErrorKind(err)}`)
        return false
      }
    },
  )

  // 6. load-settings
  ipcMain.handle(
    'bridge:load-settings',
    async (_event, customer_id?: unknown): Promise<unknown> => {
      try {
        if (customer_id !== undefined && customer_id !== null && customer_id !== '') {
          if (!isValidCustomerId(customer_id)) {
            log(`load-settings: rejected invalid customer_id`)
            return null
          }
          const scopedPath = path.join(getAwpDir(), `settings_${customer_id}.json`)
          const scoped = readJsonSafe<unknown>(scopedPath)
          if (scoped !== null) return scoped
        }
        // Fallback to global settings
        const globalPath = path.join(getAwpDir(), 'settings.json')
        return readJsonSafe<unknown>(globalPath)
      } catch (err) {
        log(`load-settings failed: error_kind=${identifierOperationErrorKind(err)}`)
        return null
      }
    },
  )

  // 10c. updater-state — renderer pulls current snapshot on mount
  ipcMain.handle('bridge:updater-state', async () => {
    try {
      const { getUpdaterState } = await import('../services/auto-updater')
      return getUpdaterState()
    } catch {
      return { phase: 'idle' as const }
    }
  })

  // 10d. updater-quit-and-install — renderer clicks "立即重启"
  ipcMain.handle('bridge:updater-quit-install', async () => {
    try {
      const { quitAndInstall } = await import('../services/auto-updater')
      quitAndInstall()
      return { ok: true }
    } catch (err) {
      logError('updater-quit-install', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // 10e. updater-download — renderer clicks "立即下载" (no silent auto-download)
  ipcMain.handle('bridge:updater-download', async () => {
    try {
      const { downloadUpdateNow } = await import('../services/auto-updater')
      await downloadUpdateNow()
      return { ok: true }
    } catch (err) {
      logError('updater-download', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // 10f. updater-check-now — renderer "检查更新" button (Settings panel).
  // Fires triggerManualCheck() which re-enables the periodic 30-min cycle
  // (in case autoCheckEnabled got toggled off by a prior 404), then runs
  // an immediate checkForUpdates(). UpdaterState is broadcast via the
  // existing 'updater:status' channel so the UI can render
  // checking → not-available / downloading / ready / error in-place.
  ipcMain.handle('bridge:updater-check-now', async () => {
    try {
      const { triggerManualCheck } = await import('../services/auto-updater')
      await triggerManualCheck()
      return { ok: true }
    } catch (err) {
      logError('updater-check-now', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Backward-compatible status shape for the general remote-agent bridge.
  ipcMain.handle('bridge:bridge-status', async (): Promise<BridgeStatusResult> => {
    try {
      const { getActiveAgentId } = await import('../utils/config')
      const activeAgentId = getActiveAgentId()
      let hasKey = false
      try {
        const { readProvisionedSshPrivateKey } = await import('../utils/ssh-private-key')
        hasKey = Boolean(readProvisionedSshPrivateKey(getAwpDir()))
      } catch { /* invalid bundles stay unavailable */ }
      return {
        bridge_alive: Boolean(activeAgentId),
        gateway_alive: false,
        tunnel_alive: false,
        tunnel_status: activeAgentId ? 'agent-configured' : 'not-configured',
        has_config: Boolean(activeAgentId),
        has_key: hasKey,
        diag: activeAgentId
          ? 'Remote agent configured'
          : 'No remote agent configured; local demo mode remains available',
      }
    } catch (err) {
      logError('bridge-status', err)
      return {
        bridge_alive: false,
        gateway_alive: false,
        tunnel_alive: false,
        tunnel_status: 'error',
        has_config: false,
        has_key: false,
        diag: 'Remote agent status check failed',
        error: err instanceof Error ? err.message : String(err),
      }
    }
  })
  // 17. Clear exactly one opaque, existing host-key pin.
  ipcMain.handle(
    'bridge:clear-known-hosts',
    async (_event, hostId: unknown): Promise<{ ok: boolean; removed: number; error?: string }> => {
      try {
        const { clearKnownHost, isKnownHostId } = await import('../bridge/ssh-known-hosts')
        if (!isKnownHostId(hostId)) return { ok: false, removed: 0, error: 'invalid_host_reference' }
        const removed = clearKnownHost(hostId)
        log(`[clear-known-hosts] removed=${removed}`)
        return { ok: true, removed }
      } catch (error) {
        const errorKind = migrationErrorKind(error)
        log(`[clear-known-hosts] error_kind=${errorKind}`)
        return { ok: false, removed: 0, error: errorKind }
      }
    },
  )
  // --- Secure credential storage (safeStorage 加密) ---
  //
  // Every handler below gates on the central allow-list defined in
  // `credential-keys.ts`. A renderer-side XSS cannot name a brand-new
  // "auth_token"-adjacent key and silently steamroll the user's session,
  // because the main process rejects unknown keys outright. The rejection
  // error echoes only the offending KEY (never the value) so dev logs can
  // triage a mis-wired caller without leaking secrets into the bundle.

  /** Preview an untrusted key for logs. We cap the length so a pathological
   *  renderer can't pump megabytes into the main-process log file, and we
   *  replace C0 controls / NUL with a visible placeholder so log scrapers
   *  don't get confused by embedded `\n` / `\0` / ANSI escapes. The value
   *  returned is safe for logs but MUST NOT be echoed to the renderer as
   *  part of the error string — we only return the key name verbatim when
   *  it's short and clean. */
  const previewKey = (raw: unknown): string => {
    const s = typeof raw === 'string' ? raw : `<${typeof raw}>`
    const MAX = 64
    const truncated = s.length > MAX ? `${s.slice(0, MAX)}…` : s
    return truncated.replace(/[\x00-\x1f\x7f]/g, '?')
  }

  // 14. set-credential: 加密存储敏感凭据（allow-list 限定 key）
  ipcMain.handle(
    'secure:set-credential',
    async (_event, key: unknown, value: unknown): Promise<{ ok: boolean; error?: string }> => {
      if (key === 'auth_token' && !isHostedAuthEnabled()) return hostedAuthDisabled()
      if (!isCredentialKey(key)) {
        const shown = previewKey(key)
        log(`[secure:set-credential] rejected unknown key: ${shown}`)
        return { ok: false, error: `credential key not allow-listed: ${shown}` }
      }
      if (typeof value !== 'string') {
        log(`[secure:set-credential] rejected non-string value for key=${key}`)
        return { ok: false, error: 'credential value must be a string' }
      }
      return secureSetCredential(key, value)
    },
  )

  // 15. get-credential: 解密读取凭据（allow-list 限定 key）
  ipcMain.handle(
    'secure:get-credential',
    async (_event, key: unknown): Promise<{ ok: boolean; value?: string; error?: string }> => {
      if (key === 'auth_token' && !isHostedAuthEnabled()) return hostedAuthDisabled()
      if (!isCredentialKey(key)) {
        const shown = previewKey(key)
        log(`[secure:get-credential] rejected unknown key: ${shown}`)
        return { ok: false, error: `credential key not allow-listed: ${shown}` }
      }
      return secureGetCredential(key)
    },
  )

  // 16. delete-credential: 删除指定凭据（allow-list 限定 key）
  ipcMain.handle(
    'secure:delete-credential',
    async (_event, key: unknown): Promise<{ ok: boolean; error?: string }> => {
      if (key === 'auth_token' && !isHostedAuthEnabled()) return hostedAuthDisabled()
      if (!isCredentialKey(key)) {
        const shown = previewKey(key)
        log(`[secure:delete-credential] rejected unknown key: ${shown}`)
        return { ok: false, error: `credential key not allow-listed: ${shown}` }
      }
      const res = await secureDeleteCredential(key)
      return res
    },
  )

  // 17. startup:run-diagnostic — 用户在设置页手动重跑启动自检
  //
  // 场景：操作者按自检报告修完问题（SSH key 权限、userData 可写等）后，
  // 想确认现在所有检查都过了、不再需要重启 app。此 handler 调用同一套
  // `runStartupDiagnostic()` 并把结构化结果返给渲染进程，由 SettingsView
  // 自行渲染 failures + warnings 列表（不走 dialog.showMessageBox —
  // 那个是 launch-time 专用的）。lazy-import 避免启动期成本，也复用
  // services/index.ts 里同样的 fail-soft 风格。
  ipcMain.handle(
    'startup:run-diagnostic',
    async (): Promise<{
      ok: boolean
      failures: string[]
      warnings: string[]
      error?: string
    }> => {
      try {
        const { runStartupDiagnostic } = await import(
          '../services/startup-diagnostic'
        )
        const r = await runStartupDiagnostic()
        return { ok: r.ok, failures: r.failures, warnings: r.warnings }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        logError('startup:run-diagnostic', e)
        return {
          ok: false,
          failures: [`自检模块加载失败: ${msg}`],
          warnings: [],
          error: msg,
        }
      }
    },
  )

  log('[ipc] All handlers registered')
}
