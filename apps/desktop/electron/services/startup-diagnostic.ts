/**
 * Startup diagnostic — surface environmental problems BEFORE the app
 * silently dies on the user.
 *
 * Why this exists:
 *   Some environments can hit "launch → exit" with no user-visible explanation.
 *   Root causes seen in the wild include:
 *     - Windows Defender quarantining part of the app-resources tree so
 *       `app.getPath('userData')` becomes read-only.
 *     - `safeStorage.isEncryptionAvailable()` returning false (OS key chain
 *       absent / broken profile) — credential reads throw later.
 *     - SSH private key file missing or world-readable so later ssh2
 *       attempts fail with cryptic "permission denied".
 *     - Stale channel install where `~/.awp-insiders` doesn't exist.
 *     - No network route to api.example.com (corporate proxy / VPN off).
 *
 *   We want every check to run independently, collect failures + warnings,
 *   and return a structured result. NO check is allowed to throw out of
 *   this module — a broken diagnostic must never become the launch crash
 *   it's meant to diagnose.
 *
 * Wire-up: T-CU02 handles calling `runStartupDiagnostic()` from main.ts
 * and deciding whether to show the dialog / exit. This file deliberately
 * does not touch main.ts.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { app, dialog, safeStorage, shell } from 'electron'

import {
  getAwpDir,
  getSshConfig,
} from '../utils/config'
import { readProvisionedSshPrivateKey } from '../utils/ssh-private-key'
import { log as logToFile } from '../utils/logger'

const log = (msg: string) => logToFile(`[startup-diagnostic] ${msg}`)

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface StartupDiagnosticResult {
  /** `true` iff `failures.length === 0` — warnings do NOT block startup. */
  ok: boolean
  /** Hard blockers — the app almost certainly cannot function. */
  failures: string[]
  /** Soft issues — app may work but user should know. */
  warnings: string[]
}


// ---------------------------------------------------------------------------
// Per-check helpers — every one wrapped so failure becomes a collected
// string, never a thrown error.
// ---------------------------------------------------------------------------

/** Check 1 — userData dir is writable (tmp marker roundtrip). */
function checkUserDataWritable(failures: string[]): void {
  let userDataDir = ''
  try {
    userDataDir = app.getPath('userData')
  } catch (e) {
    failures.push(
      `userData 路径不可解析: ${e instanceof Error ? e.message : String(e)}`,
    )
    return
  }
  try {
    fs.mkdirSync(userDataDir, { recursive: true })
    const marker = path.join(userDataDir, '.startup-diagnostic-marker')
    fs.writeFileSync(marker, String(Date.now()), 'utf-8')
    fs.unlinkSync(marker)
    log(`userData writable: ${userDataDir}`)
  } catch (e) {
    failures.push(
      `userData 目录不可写 (${userDataDir}): ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
  }
}

/** Check 2 — encrypted credential storage availability. */
function checkSafeStorage(warnings: string[]): void {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      warnings.push('凭据存储已禁用：系统加密不可用，应用绝不会降级为明文存储')
      return
    }
    log('encrypted credential storage available')
  } catch {
    warnings.push('凭据存储已禁用：系统加密检查失败，应用绝不会降级为明文存储')
  }
}
/** Check 3 — awp-dir exists (create recursively if missing). */
function checkAwpDir(failures: string[]): void {
  let dir = ''
  try {
    dir = getAwpDir()
  } catch (e) {
    failures.push(
      `awp-dir 解析失败: ${e instanceof Error ? e.message : String(e)}`,
    )
    return
  }
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
      log(`awp-dir created: ${dir}`)
    } else {
      log(`awp-dir exists: ${dir}`)
    }
  } catch (e) {
    failures.push(
      `awp-dir (${dir}) 创建失败: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
  }
}

/** Check 4 — an explicitly provisioned app-owned SSH key bundle is valid. */
function checkSshKey(failures: string[], warnings: string[]): void {
  let sshCfg: ReturnType<typeof getSshConfig>
  try {
    sshCfg = getSshConfig()
  } catch {
    warnings.push('SSH 配置读取异常')
    return
  }
  if (!sshCfg?.host || !sshCfg.user) return
  try {
    const provisioned = readProvisionedSshPrivateKey(getAwpDir())
    if (!provisioned) {
      failures.push('SSH 私钥尚未通过应用私有目录中的清单显式配置')
      return
    }
    log('validated explicit app-owned SSH key bundle')
  } catch {
    failures.push('SSH 私钥包验证失败；应用已拒绝使用该密钥')
  }
}

/** Check 5 — log file is writable (logToFile never throws; self-test). */
function checkLogWritable(warnings: string[]): void {
  try {
    logToFile('[startup-diagnostic] self-test')
  } catch (e) {
    // logToFile swallows internally — if it *does* throw something bizarre
    // happened (disk full mid-flush, etc). Surface as warning, not failure:
    // we've already degraded logging and the app can limp on without a log.
    warnings.push(
      `日志目录写入失败: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run all local startup checks. Each check is isolated — one failure does not
 * short-circuit the rest. Always resolves; never rejects.
 */
export async function runStartupDiagnostic(): Promise<StartupDiagnosticResult> {
  const failures: string[] = []
  const warnings: string[] = []

  log('starting self-test')

  // Synchronous checks first — they are cheap and order-independent.
  try {
    checkUserDataWritable(failures)
  } catch (e) {
    failures.push(
      `checkUserDataWritable 内部异常: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
  }
  try {
    checkSafeStorage(warnings)
  } catch (e) {
    warnings.push(
      `checkSafeStorage 内部异常: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  try {
    checkAwpDir(failures)
  } catch (e) {
    failures.push(
      `checkAwpDir 内部异常: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
  }
  try {
    checkSshKey(failures, warnings)
  } catch (e) {
    warnings.push(
      `checkSshKey 内部异常: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  try {
    checkLogWritable(warnings)
  } catch (e) {
    warnings.push(
      `checkLogWritable 内部异常: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
  }

  const result: StartupDiagnosticResult = {
    ok: failures.length === 0,
    failures,
    warnings,
  }
  log(
    `self-test done: ok=${result.ok} failures=${failures.length} warnings=${warnings.length}`,
  )
  return result
}

/**
 * Modal dialog summarising diagnostic results. Blocking on purpose — the
 * caller (T-CU02) will invoke this in `app.whenReady()` before any window
 * is opened, so the user gets a chance to read/act before the main UI
 * either appears or the process exits.
 *
 * Buttons:
 *   0 = 打开日志目录 (shell.openPath; does NOT exit, caller decides)
 *   1 = 继续          (return to caller — caller may still exit on `failures`)
 *   2 = 退出          (caller should `app.exit(1)`)
 *
 * The return value is the button index — kept simple so T-CU02 can switch
 * on it without a custom enum we'd have to keep in sync.
 */
export function showStartupDiagnosticDialog(
  result: StartupDiagnosticResult,
): void {
  const lines: string[] = []
  if (result.failures.length > 0) {
    lines.push('【启动阻塞项】')
    for (const f of result.failures) lines.push(`  - ${f}`)
  }
  if (result.warnings.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('【警告】')
    for (const w of result.warnings) lines.push(`  - ${w}`)
  }
  if (lines.length === 0) {
    lines.push('所有自检通过。')
  }

  let logDir = ''
  try {
    logDir = getAwpDir()
  } catch {
    // ignore — "打开日志目录" button will be a no-op
  }

  const choice = dialog.showMessageBoxSync({
    type: result.ok ? 'info' : 'error',
    title: 'AgentWorkflowPlatform 启动自检',
    message: result.ok
      ? 'AgentWorkflowPlatform 启动自检完成'
      : 'AgentWorkflowPlatform 启动自检发现问题',
    detail: lines.join('\n'),
    buttons: ['打开日志目录', '继续', '退出'],
    defaultId: result.ok ? 1 : 2,
    cancelId: 1,
    noLink: true,
  })

  if (choice === 0 && logDir) {
    // Fire-and-forget — we don't await, dialog is already dismissed.
    void shell.openPath(logDir).catch((e: unknown) => {
      log(
        `shell.openPath failed: ${e instanceof Error ? e.message : String(e)}`,
      )
    })
  }
}
