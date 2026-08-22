/**
 * Provider-neutral Agent CLI subprocess adapter.
 *
 * One process is owned per conversation. The adapter keeps the production
 * stream-json parser, partial-line buffering, 4 MiB runaway-output guard,
 * session resume, graceful cancellation, stderr capture, and explicitly
 * opt-in capped failure diagnostics. It never selects a provider, remote host,
 * credential, model, or permission policy for the user.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { renderMcpConfig } from './mcp-config-renderer'
import {
  getCliPath as getManagedCliPath,
  getCurrentVersion as getManagedRuntimeVersion,
  recoverFromMissingBinary,
} from './cc-runtime-updater'
// The collector is invoked only when AWP_AGENT_TELEMETRY_OPT_IN=1.
import { recordEventCapped } from '../services/trace-collector'

// Local subprocess diagnostics are exact opt-in. The default path does not
// create a directory or file. Persisted records are structural summaries only:
// raw prompts, paths, arguments, stdout, stderr, tokens, and credentials never
// reach disk.
function _diagnosticsEnabled(): boolean {
  return process.env.AWP_AGENT_CLI_TRACE === '1'
}

const _STDERR_LOG_RETAIN = 5
const _STDERR_LOG_MAX_BYTES = 64 * 1024
const _TRACE_LOG_MAX_BYTES = 128 * 1024
const _SAFE_DIAGNOSTIC_KEYS = new Set([
  'bytes',
  'code',
  'count',
  'elapsed_ms',
  'errno',
  'exitCode',
  'isBadBinary',
  'kind',
  'lastEventType',
  'malformedLines',
  'retryCount',
  'signal',
  'stage',
  'status',
  'turnInFlight',
  'type',
])

interface DiagnosticFileState {
  path: string
  bytes: number
}

const _stderrFiles = new Map<string, DiagnosticFileState>()

function _diagnosticFile(name: string): string | null {
  if (!_diagnosticsEnabled()) return null
  try {
    return path.join(app.getPath('userData'), name)
  } catch {
    return null
  }
}

function _getCcStderrDir(create = false): string | null {
  if (!_diagnosticsEnabled()) return null
  try {
    const dir = path.join(app.getPath('userData'), 'agent-cli-diagnostics')
    if (create) fs.mkdirSync(dir, { recursive: true })
    return dir
  } catch {
    return null
  }
}

function _ccStderrLogPath(sessionId: string): string | null {
  const dir = _getCcStderrDir(true)
  return dir ? path.join(dir, `${sessionId}.jsonl`) : null
}

function _safeDiagnosticScalar(value: unknown): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value !== 'string') return undefined
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(value)) {
    return { type: 'string', bytes: Buffer.byteLength(value, 'utf-8') }
  }
  if (/token|secret|password|credential|authorization|cookie|private.?key/i.test(value)) {
    return '[redacted]'
  }
  return value
}

function _structuredDiagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > 2) return '[truncated]'
  if (typeof value === 'string') {
    return { type: 'string', bytes: Buffer.byteLength(value, 'utf-8') }
  }
  if (Buffer.isBuffer(value)) return { type: 'buffer', bytes: value.length }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return { type: 'array', count: value.length }
  if (!value || typeof value !== 'object') return { type: typeof value }

  const safe: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (!_SAFE_DIAGNOSTIC_KEYS.has(key)) continue
    if (nested && typeof nested === 'object') {
      safe[key] = _structuredDiagnosticValue(nested, depth + 1)
    } else {
      const scalar = _safeDiagnosticScalar(nested)
      if (scalar !== undefined) safe[key] = scalar
    }
  }
  return safe
}

function _appendCappedJsonLine(
  target: string,
  record: Record<string, unknown>,
  maxBytes: number,
  rotate: boolean,
): number {
  const line = `${JSON.stringify(record)}\n`
  const lineBytes = Buffer.byteLength(line, 'utf-8')
  if (lineBytes > maxBytes) return 0
  try {
    let current = fs.existsSync(target) ? fs.statSync(target).size : 0
    if (current + lineBytes > maxBytes) {
      if (!rotate) return current
      const rotated = `${target}.1`
      try { if (fs.existsSync(rotated)) fs.unlinkSync(rotated) } catch { /* best effort */ }
      try { fs.renameSync(target, rotated) } catch { return current }
      current = 0
    }
    fs.appendFileSync(target, line, { encoding: 'utf-8', mode: 0o600 })
    return current + lineBytes
  } catch {
    return 0
  }
}

function _pruneStderrLogs(): void {
  const dir = _getCcStderrDir(false)
  if (!dir || !fs.existsSync(dir)) return
  try {
    const entries = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    for (const entry of entries.slice(_STDERR_LOG_RETAIN)) {
      try { fs.unlinkSync(path.join(dir, entry.name)) } catch { /* best effort */ }
    }
  } catch { /* diagnostics never affect runtime */ }
}

function _openStderrLog(
  sessionId: string,
  details: { pid: number | undefined; source: 'external' | 'managed' },
): void {
  const target = _ccStderrLogPath(sessionId)
  if (!target) return
  try {
    fs.writeFileSync(target, '', { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
  } catch {
    return
  }
  const bytes = _appendCappedJsonLine(target, {
    ts: new Date().toISOString(),
    type: 'spawn',
    sessionId,
    pid: details.pid ?? null,
    source: details.source,
  }, _STDERR_LOG_MAX_BYTES, false)
  _stderrFiles.set(sessionId, { path: target, bytes })
  _pruneStderrLogs()
}

function _appendStderrSummary(sessionId: string, text: string): void {
  const state = _stderrFiles.get(sessionId)
  if (!state) return
  const signals: string[] = []
  if (/\bAPI Error\b/i.test(text)) signals.push('api_error')
  if (/\brate.?limit/i.test(text)) signals.push('rate_limit')
  if (/\bpermission|access denied|forbidden\b/i.test(text)) signals.push('permission')
  const bytes = _appendCappedJsonLine(state.path, {
    ts: new Date().toISOString(),
    type: 'stderr',
    bytes: Buffer.byteLength(text, 'utf-8'),
    lines: text.length === 0 ? 0 : text.split(/\r?\n/u).length,
    signals,
  }, _STDERR_LOG_MAX_BYTES, false)
  if (bytes > 0) state.bytes = bytes
}

function _closeStderrLog(
  sessionId: string,
  details?: { type: 'exit' | 'spawn_error'; code?: string | number | null; signal?: string | null },
): void {
  const state = _stderrFiles.get(sessionId)
  if (!state) return
  if (details) {
    const bytes = _appendCappedJsonLine(state.path, {
      ts: new Date().toISOString(),
      type: details.type,
      code: _safeDiagnosticScalar(details.code ?? null),
      signal: _safeDiagnosticScalar(details.signal ?? null),
    }, _STDERR_LOG_MAX_BYTES, false)
    if (bytes > 0) state.bytes = bytes
  }
  _stderrFiles.delete(sessionId)
}

/** Return the newest opt-in structural diagnostic log. */
export function getMostRecentCcStderr(): { path: string; content: string } | null {
  const dir = _getCcStderrDir(false)
  if (!dir || !fs.existsSync(dir)) return null
  try {
    const entries = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    if (!entries.length) return null
    const target = path.join(dir, entries[0].name)
    return { path: target, content: fs.readFileSync(target, 'utf-8') }
  } catch {
    return null
  }
}

function _trace(channel: string, sessionId: string, kind: string, data: unknown): void {
  const target = _diagnosticFile('agent-cli-trace.jsonl')
  if (!target) return
  _appendCappedJsonLine(target, {
    ts: new Date().toISOString(),
    channel,
    sessionId,
    kind,
    data: _structuredDiagnosticValue(data),
  }, _TRACE_LOG_MAX_BYTES, true)
}

function _emitFailureTelemetry(
  kind: string,
  payload: Record<string, unknown>,
  convId?: string,
): void {
  if (process.env.AWP_AGENT_TELEMETRY_OPT_IN !== '1') return
  try {
    // Clip long strings; never record attachment or message bodies here.
    const clipped: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(payload)) {
      clipped[k] = typeof v === 'string' && v.length > 400 ? v.slice(0, 400) + '...' : v
    }
    recordEventCapped(
      kind,
      { platform: process.platform, ...clipped },
      convId ? { convId } : undefined,
    )
  } catch {
    /* telemetry must never affect the chat flow */
  }
}

/** Resolve managed runtime metadata for optional failure context. */
function _getCliVersionSafe(): string | null {
  try {
    const version = getManagedRuntimeVersion()
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

/** Count repeated spawn failures during this app session. */
let _spawnFailureCount = 0

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionPhase = 'spawning' | 'idle' | 'streaming' | 'exited'

export interface CcSession {
  sessionId: string
  conversationId: string
  proc: ChildProcess
  cwd: string
  model?: string
  phase: SessionPhase
  stdoutBuffer: string
  stderrBuffer: string
  /** Per-session decoder so a mid-codepoint chunk doesn't poison another session. */
  decoder: TextDecoder
  /** Accumulator for tool-use `input_json_delta` fragments keyed by block index. */
  pendingToolInput: Map<number, string>
  startedAt: number
  lastActivityAt: number
  /** Native session id emitted by the configured CLI and reused with --resume. */
  ccSessionId?: string
  // Optional stream-health state used by the opt-in failure diagnostics.
  /** Last successfully-parsed stdout event `type` (e.g. 'assistant', 'result'). */
  lastEventType?: string
  /** stderr matched /API Error/ at least once during this session. */
  sawApiError?: boolean
  /** Count of stdout lines that failed JSON.parse. */
  malformedStdoutLines?: number
  /** A user turn was sent and its terminating done-chunk hasn't arrived yet. */
  turnInFlight?: boolean
  /** stopSession was invoked, so the following exit is expected. */
  stopRequested?: boolean
  /** Shared cancellation work so repeated stop calls never stack timers/listeners. */
  stopPromise?: Promise<{ ok: boolean }>
}

export interface StartSessionOpts {
  conversationId: string
  cwd?: string
  model?: string
  /**
   * Optional native session id. When present, the adapter passes it as a
   * separate --resume argument so the configured CLI can restore its own
   * durable history. The wrapper never reads or rewrites that history.
   */
  ccSessionId?: string
}

export interface StartSessionResult {
  ok: boolean
  sessionId?: string
  error?: string
}

/**
 * Attachment metadata supplied by the caller. Absolute local files are read
 * directly. Remote retrieval is available only through an explicit URL
 * template plus the remote API opt-in.
 */
export interface AttachmentRef {
  path: string
  filename: string
  size?: number
  sandbox_relpath?: string
  sha256?: string
}

export interface SendMessageOpts {
  sessionId: string
  content: string
  /** Optional local or explicitly configured remote attachments. */
  attachments?: AttachmentRef[]
}

export interface SessionStatus {
  phase: SessionPhase
  pid?: number
  model?: string
  conversationId?: string
}

/** Flat chunk shape consumed by `src/stores/chat.ts:520-700`. */
export interface FlatChunk {
  type?: string
  delta?: string
  conversation_id?: string
  model?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  label?: string
  tool?: string
  done?: boolean
  error?: string
  /**
   * Native CLI session id emitted on the first message_start of a spawn
   * (translated from the stream-json `system/init` event). Renderer captures
   * it and pins it onto the active thread so subsequent cc_start calls can
   * pass `--resume <id>`.
   */
  cc_session_id?: string
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const sessions = new Map<string, CcSession>()
const byConv = new Map<string, string>()

/** Emits local stream and exit events in addition to renderer broadcasts. */
export const ccEvents = new EventEmitter()

/** Bound buffered stream output while leaving headroom for tool payloads. */
const STDOUT_OVERSIZE_LIMIT = 4 * 1024 * 1024

/** Grace period between SIGTERM and SIGKILL. */
const STOP_GRACE_MS = 3_000


/** Windows soft-shutdown wait after writing a protocol shutdown event. */
const WIN_SOFT_SHUTDOWN_MS = 500

// ---------------------------------------------------------------------------
// CLI resolution
// ---------------------------------------------------------------------------

/**
 * Parse exact user-supplied prefix arguments from AWP_AGENT_CLI_ARGS_JSON.
 * Remote HTTP(S) arguments require AWP_AGENT_REMOTE_API_OPT_IN=1.
 */
function parseConfiguredArgs(): string[] {
  const raw = (process.env.AWP_AGENT_CLI_ARGS_JSON ?? '').trim()
  if (!raw) return []
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new CcWrapperError('invalid_cli_args_json')
  }
  if (
    !Array.isArray(value)
    || value.length > 128
    || value.some((item) => typeof item !== 'string' || item.length > 8_192)
  ) {
    throw new CcWrapperError('invalid_cli_args_json')
  }
  const args = value as string[]
  if (
    args.some(isRemoteHttpUrl)
    && process.env.AWP_AGENT_REMOTE_API_OPT_IN !== '1'
  ) {
    throw new CcWrapperError('remote_api_requires_explicit_opt_in')
  }
  return args
}

/**
 * Resolve an explicitly configured CLI, or the executable installed by the
 * signed provider-neutral runtime adapter. There is intentionally no vendor
 * binary name, remote shell, or hosted fallback.
 */
function resolveCliInvocation(): {
  exe: string
  prefixArgs: string[]
  managedRuntime: boolean
} {
  const explicitPath = (process.env.AWP_AGENT_CLI_EXECUTABLE ?? '').trim()
  if (explicitPath) {
    if (!path.isAbsolute(explicitPath)) {
      throw new CcWrapperError('cli_executable_must_be_absolute')
    }
    return {
      exe: path.resolve(explicitPath),
      prefixArgs: parseConfiguredArgs(),
      managedRuntime: false,
    }
  }

  const explicitCommand = (process.env.AWP_AGENT_CLI_COMMAND ?? '').trim()
  if (explicitCommand) {
    if (!/^[A-Za-z0-9._-]+$/.test(explicitCommand)) {
      throw new CcWrapperError('invalid_cli_command')
    }
    return {
      exe: explicitCommand,
      prefixArgs: parseConfiguredArgs(),
      managedRuntime: false,
    }
  }

  try {
    const managed = getManagedCliPath()
    if (managed) {
      return { exe: managed, prefixArgs: parseConfiguredArgs(), managedRuntime: true }
    }
  } catch {
    // The clear unavailable result below is the provider-neutral default.
  }
  throw new CcWrapperError('runtime_unavailable')
}

export class CcWrapperError extends Error {
  code: string

  constructor(code: string, message?: string) {
    super(message ?? code)
    this.name = 'CcWrapperError'
    this.code = code
  }
}

const SAFE_PARENT_ENV_KEYS = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC',
  'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA',
  'LANG', 'LC_ALL', 'TERM', 'COLORTERM',
] as const

function buildSafeParentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of SAFE_PARENT_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function isRemoteHttpUrl(value: string): boolean {
  const matches = value.match(/https?:\/\/[^\s"'<>]+/gi) ?? []
  return matches.some((candidate) => {
    try {
      const url = new URL(candidate)
      const host = url.hostname.toLowerCase()
      return host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]'
    } catch {
      return true
    }
  })
}

function parseExplicitCliEnv(): Record<string, string> {
  const raw = (process.env.AWP_AGENT_CLI_ENV_JSON ?? '').trim()
  if (!raw) return {}
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new CcWrapperError('invalid_cli_env_json')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CcWrapperError('invalid_cli_env_json')
  }

  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 128) throw new CcWrapperError('cli_env_too_large')
  const configured: Record<string, string> = {}
  let containsRemote = false
  for (const [key, item] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== 'string') {
      throw new CcWrapperError('invalid_cli_env_entry')
    }
    if (item.length > 32_768) throw new CcWrapperError('cli_env_value_too_large')
    configured[key] = item
    containsRemote ||= isRemoteHttpUrl(item)
  }
  if (containsRemote && process.env.AWP_AGENT_REMOTE_API_OPT_IN !== '1') {
    throw new CcWrapperError('remote_api_requires_explicit_opt_in')
  }
  return configured
}

/**
 * The child receives only basic operating-system values plus the exact
 * key/value pairs the user placed in AWP_AGENT_CLI_ENV_JSON. No provider URL,
 * credential, model, permission policy, or app-internal AWP variable is added.
 */
export async function buildCcEnv(): Promise<NodeJS.ProcessEnv> {
  return { ...buildSafeParentEnv(), ...parseExplicitCliEnv() }
}

function redactArgv(argv: string[]): string[] {
  let redactNext = false
  return argv.map((arg) => {
    if (redactNext) {
      redactNext = false
      return '<redacted>'
    }
    if (/^--?(?:api[-_]?key|token|secret|password|authorization|credential)$/i.test(arg)) {
      redactNext = true
      return arg
    }
    if (/^--?(?:api[-_]?key|token|secret|password|authorization|credential)=/i.test(arg)) {
      return arg.replace(/=.*/, '=<redacted>')
    }
    if (/(?:["']?(?:api[-_]?key|token|secret|password|authorization|credential)["']?\s*[:=])/i.test(arg)) {
      return '<redacted-config-arg>'
    }
    try {
      const url = new URL(arg)
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        if (url.username || url.password) {
          url.username = '<redacted>'
          url.password = ''
        }
        for (const key of [...url.searchParams.keys()]) {
          if (/(?:key|token|secret|password|authorization|credential)/i.test(key)) {
            url.searchParams.set(key, '<redacted>')
          }
        }
        return url.toString()
      }
    } catch {
      // Not a URL; retain the non-secret diagnostic argument.
    }
    return arg
  })
}

// ---------------------------------------------------------------------------
// Broadcast helper
// ---------------------------------------------------------------------------

function broadcast(channel: string, payload: unknown): void {
  // Trace every broadcast so we can diff against stdout to find dropped events.
  if (_diagnosticsEnabled()) {
    const p = payload as { sessionId?: string; event?: unknown } | undefined
    _trace('broadcast', p?.sessionId ?? '', channel, p?.event ?? payload)
  }
  ccEvents.emit(channel, payload)
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send(channel, payload)
    } catch {
      /* window may be closing — ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Stream parser
// ---------------------------------------------------------------------------

/** Convert a tool event into a concise, user-facing progress label. */
function _toolStatusLabel(rawName: string, input?: unknown): string {
  const name = String(rawName || '').replace(/^mcp__[^_]+__(?:[^_]+__)?/, '')
  const values = input && typeof input === 'object' ? input as Record<string, unknown> : undefined
  const text = (key: string): string => values && typeof values[key] === 'string'
    ? values[key] as string
    : ''
  const head = (value: string, limit = 40): string => {
    const first = (value.split('\n')[0] || '').trim()
    return first.length > limit ? `${first.slice(0, limit)}...` : first
  }
  const base = (value: string): string => value
    ? value.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || value
    : ''

  switch (name) {
    case 'vm_exec':
    case 'vm_exec_stream':
    case 'Bash': {
      const command = text('command') || text('cmd')
      return command ? `Running: ${head(command)}` : 'Running command'
    }
    case 'vm_write_file':
    case 'Write': {
      const file = text('path') || text('file_path')
      return file ? `Writing ${base(file)}` : 'Writing file'
    }
    case 'vm_read_file':
    case 'Read': {
      const file = text('path') || text('file_path')
      return file ? `Reading ${base(file)}` : 'Reading file'
    }
    case 'Edit':
    case 'MultiEdit': {
      const file = text('file_path')
      return file ? `Editing ${base(file)}` : 'Editing file'
    }
    case 'awp_save_artifact': return 'Saving artifact'
    case 'awp_open_file_in_tab': return 'Opening file'
    case 'awp_notify_user': return ''
    case 'Grep': return 'Searching code'
    case 'Glob': return 'Finding files'
    case 'WebSearch':
    case 'WebFetch': return 'Retrieving information'
    case 'TodoWrite': return 'Updating task list'
    case 'Task': return 'Running subtask'
    default: return 'Working'
  }
}
/**
 * Translate one configured-CLI stdout event into the renderer's flat chunk
 * shape. Both complete-message wrapper events and delta-oriented stream events
 * are supported, and tool input fragments are buffered until complete.
 * Exported for focused parser tests.
 */
export function translateEvent(
  event: unknown,
  session: CcSession,
): FlatChunk | FlatChunk[] | null {
  if (!event || typeof event !== 'object') return null
  const ev = event as Record<string, unknown>
  const t = ev['type']

  switch (t) {
    // -------------------------------------------------------------------
    // Complete-message wrapper events
    // -------------------------------------------------------------------

    case 'system': {
      const subtype = typeof ev['subtype'] === 'string' ? (ev['subtype'] as string) : ''
      if (subtype === 'init') {
        // The init event establishes the native session id and optional model.
        const model = typeof ev['model'] === 'string' ? (ev['model'] as string) : session.model
                // Surface the native id so a later spawn can pass --resume unchanged.
        const ccSessionId = typeof ev['session_id'] === 'string'
          ? (ev['session_id'] as string)
          : undefined
        if (ccSessionId) {
          session.ccSessionId = ccSessionId
        }
        return [
          { type: 'cc_status', label: 'ready' },
          {
            type: 'message_start',
            conversation_id: session.conversationId,
            model,
            cc_session_id: ccSessionId,
          },
        ]
      }
      // Other subtypes (hook_started/hook_response/...) are housekeeping.
      return null
    }

    case 'assistant': {
      // Wrapper event: complete assistant message with content blocks.
      // Real CLI emits one `assistant` per provider-neutral message; content is an
      // array of {type:"text",text:"..."} and/or {type:"tool_use",name,...}.
      const msg = (ev['message'] ?? {}) as Record<string, unknown>
      const content = Array.isArray(msg['content']) ? (msg['content'] as unknown[]) : []
      const out: FlatChunk[] = []
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        const b = block as Record<string, unknown>
        const bt = b['type']
        if (bt === 'text' && typeof b['text'] === 'string') {
          const text = b['text'] as string
          if (text.length > 0) out.push({ delta: text })
        } else if (bt === 'tool_use') {
          const name = typeof b['name'] === 'string' ? (b['name'] as string) : 'tool'
          out.push({ type: 'cc_status', label: _toolStatusLabel(name, b['input']), tool: name })
        }
        // `thinking` / `redacted_thinking` / other block types: silent skip.
      }
      // NOTE: we do NOT emit {done:true} here — `result` does that, and many
      // turns are multi-message (tool-use round-trips). Usage likewise rolls
      // up in `result`.
      return out.length > 0 ? out : null
    }

    case 'user': {
      // Tool results echoed back to the transcript. Nothing to render in the
      // chat bubble; cc_status already announced the tool.
      return null
    }

    case 'rate_limit_event': {
      const info = (ev['rate_limit_info'] ?? {}) as Record<string, unknown>
      const status = typeof info['status'] === 'string' ? (info['status'] as string) : ''
      if (status && status !== 'allowed') {
        return { type: 'cc_status', label: 'rate_limited' }
      }
      // `allowed` fires on every turn — don't spam the UI.
      return null
    }

    case 'result': {
      // Session done. `usage` is flat here (input_tokens/output_tokens/...).
      // Errors surface via is_error:true + result field.
      const isError = ev['is_error'] === true
      const subtype = typeof ev['subtype'] === 'string' ? (ev['subtype'] as string) : ''
      const done: FlatChunk = { done: true }

      const usage = ev['usage'] as Record<string, unknown> | undefined
      if (usage) {
        const u: FlatChunk['usage'] = {}
        if (typeof usage['input_tokens'] === 'number') u.input_tokens = usage['input_tokens'] as number
        if (typeof usage['output_tokens'] === 'number') u.output_tokens = usage['output_tokens'] as number
        if (typeof usage['cache_read_input_tokens'] === 'number') u.cache_read_input_tokens = usage['cache_read_input_tokens'] as number
        if (typeof usage['cache_creation_input_tokens'] === 'number') u.cache_creation_input_tokens = usage['cache_creation_input_tokens'] as number
        done.usage = u
      }

      if (isError) {
        const errMsg =
          typeof ev['result'] === 'string' ? (ev['result'] as string) :
          subtype ? `cc_${subtype}` : 'cc_error'
        done.error = errMsg
      }
      return done
    }

    // -------------------------------------------------------------------
    // Raw provider-neutral SDK events (fake-cc-cli + back-compat)
    // -------------------------------------------------------------------

    case 'message_start': {
      const msg = (ev['message'] ?? {}) as Record<string, unknown>
      return {
        type: 'message_start',
        conversation_id: session.conversationId,
        model: typeof msg['model'] === 'string' ? (msg['model'] as string) : session.model,
      }
    }

    case 'content_block_start': {
      const idx = typeof ev['index'] === 'number' ? (ev['index'] as number) : -1
      const block = (ev['content_block'] ?? {}) as Record<string, unknown>
      if (block['type'] === 'tool_use') {
        if (idx >= 0) session.pendingToolInput.set(idx, '')
        const name = typeof block['name'] === 'string' ? (block['name'] as string) : 'tool'
        return { type: 'cc_status', label: _toolStatusLabel(name), tool: name }
      }
      return null
    }

    case 'content_block_delta': {
      const idx = typeof ev['index'] === 'number' ? (ev['index'] as number) : -1
      const delta = (ev['delta'] ?? {}) as Record<string, unknown>
      if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
        return { delta: delta['text'] as string }
      }
      if (delta['type'] === 'input_json_delta' && typeof delta['partial_json'] === 'string') {
        if (idx >= 0) {
          const prev = session.pendingToolInput.get(idx) ?? ''
          session.pendingToolInput.set(idx, prev + (delta['partial_json'] as string))
        }
        return null
      }
      return null
    }

    case 'content_block_stop': {
      const idx = typeof ev['index'] === 'number' ? (ev['index'] as number) : -1
      if (idx >= 0) session.pendingToolInput.delete(idx)
      return null
    }

    case 'message_delta': {
      const usage = ev['usage'] as Record<string, unknown> | undefined
      if (usage) {
        const out: FlatChunk['usage'] = {}
        if (typeof usage['input_tokens'] === 'number') out.input_tokens = usage['input_tokens'] as number
        if (typeof usage['output_tokens'] === 'number') out.output_tokens = usage['output_tokens'] as number
        if (typeof usage['cache_read_input_tokens'] === 'number') out.cache_read_input_tokens = usage['cache_read_input_tokens'] as number
        if (typeof usage['cache_creation_input_tokens'] === 'number') out.cache_creation_input_tokens = usage['cache_creation_input_tokens'] as number
        return { usage: out }
      }
      return null
    }

    case 'message_stop':
      return { done: true }

    default:
      return null
  }
}

function handleStdoutChunk(session: CcSession, bufLike: Buffer | Uint8Array | string): void {
  const piece =
    typeof bufLike === 'string'
      ? bufLike
      : session.decoder.decode(bufLike, { stream: true })
  session.stdoutBuffer += piece
  session.lastActivityAt = Date.now()

  if (session.stdoutBuffer.length > STDOUT_OVERSIZE_LIMIT) {
    broadcast('cc:stream-event', {
      sessionId: session.sessionId,
      event: { error: 'runtime_output_oversize', done: true } satisfies FlatChunk,
    })
    void stopSession({ sessionId: session.sessionId })
    return
  }

  const lines = session.stdoutBuffer.split('\n')
  session.stdoutBuffer = lines.pop() ?? ''

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // Preserve a short local diagnostic and continue parsing subsequent lines.
      session.stderrBuffer += `[cc-wrapper] malformed stdout line: ${line.slice(0, 200)}\n`
      // Track only the count in optional failure diagnostics.
      session.malformedStdoutLines = (session.malformedStdoutLines ?? 0) + 1
      continue
    }
    // Retain the last valid event type for failure classification.
    const evType = (parsed as Record<string, unknown> | null)?.['type']
    if (typeof evType === 'string') session.lastEventType = evType
    const chunk = translateEvent(parsed, session)
    if (!chunk) continue
    const list = Array.isArray(chunk) ? chunk : [chunk]
    for (const c of list) {
      // A done chunk completes the in-flight turn contract.
      if (c.done === true) session.turnInFlight = false
      broadcast('cc:stream-event', { sessionId: session.sessionId, event: c })
    }
  }
}

// ---------------------------------------------------------------------------
// Public API — session lifecycle
// ---------------------------------------------------------------------------

export async function startSession(opts: StartSessionOpts): Promise<StartSessionResult> {
  if (!opts || typeof opts !== 'object') {
    return { ok: false, error: 'invalid_start_options' }
  }
  const { conversationId } = opts
  if (
    !conversationId
    || typeof conversationId !== 'string'
    || !conversationId.trim()
    || conversationId.length > 512
    || /[\u0000-\u001f\u007f]/.test(conversationId)
  ) {
    return { ok: false, error: 'invalid_conversation_id' }
  }

  // Idempotency: existing session for this conversation wins.
  const existingId = byConv.get(conversationId)
  if (existingId) {
    const existing = sessions.get(existingId)
    if (existing && existing.phase !== 'exited') {
      return { ok: true, sessionId: existingId }
    }
    // Stale entry — clean up.
    byConv.delete(conversationId)
  }

  const cwd = opts.cwd ?? process.cwd()
  if (typeof cwd !== 'string' || !cwd || cwd.includes('\u0000')) {
    return { ok: false, error: 'invalid_working_directory' }
  }

  let invocation: { exe: string; prefixArgs: string[]; managedRuntime: boolean }
  try {
    invocation = resolveCliInvocation()
  } catch (error) {
    const code = error instanceof CcWrapperError ? error.code : 'runtime_unavailable'
    return { ok: false, error: code }
  }
  const { exe, prefixArgs, managedRuntime } = invocation

  const model =
    typeof opts.model === 'string' && opts.model.trim()
      ? opts.model.trim()
      : undefined
  if (model && (model.length > 256 || /[\u0000-\u001f\u007f]/.test(model))) {
    return { ok: false, error: 'invalid_model' }
  }

  const protocol = (process.env.AWP_AGENT_CLI_PROTOCOL ?? 'stream-json').trim()
  if (protocol !== 'stream-json' && protocol !== 'passthrough') {
    return { ok: false, error: 'invalid_cli_protocol' }
  }
  const argv = [...prefixArgs]
  if (protocol === 'stream-json') {
    argv.push(
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--print',
      '--verbose',
    )
  }
  if (model) argv.push('--model', model)

  if (opts.ccSessionId !== undefined) {
    if (
      typeof opts.ccSessionId !== 'string'
      || !/^[A-Za-z0-9._:-]{1,256}$/.test(opts.ccSessionId)
    ) {
      return { ok: false, error: 'invalid_resume_session_id' }
    }
    argv.push('--resume', opts.ccSessionId)
  }

  // Local MCP is discovered from the Desktop-owned loopback server. A remote
  // MCP endpoint is possible only through explicit URL/name plus the operator
  // opt-in enforced again by mcp-config-renderer.
  try {
    let awpIde: { url: string; token?: string; conversationId?: string } | undefined
    try {

      const service = require('../services/awp-ide-server') as {
        getServerEndpoint?: () => { url?: string; token?: string } | null
      }
      const endpoint = service.getServerEndpoint?.()
      if (endpoint?.url) {
        awpIde = {
          url: endpoint.url,
          token: endpoint.token,
          conversationId,
        }
      }
    } catch {
      // Some minimal/test builds intentionally omit the local MCP server.
    }

    const remoteUrl = (process.env.AWP_AGENT_REMOTE_MCP_URL ?? '').trim()
    const remoteName = (process.env.AWP_AGENT_REMOTE_MCP_NAME ?? '').trim()
    const remoteToken = (process.env.AWP_AGENT_REMOTE_MCP_TOKEN ?? '').trim()
    const remoteMcp = remoteUrl
      ? {
          name: remoteName,
          url: remoteUrl,
          token: remoteToken || undefined,
          conversationId,
        }
      : undefined

    if (awpIde || remoteMcp) {
      const rendered = renderMcpConfig({
        awpIde,
        remoteMcp,
        allowRemoteMcp: remoteMcp
          ? process.env.AWP_AGENT_REMOTE_MCP_OPT_IN === '1'
          : false,
      })
      argv.push('--mcp-config', rendered.path)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    broadcast('cc:stream-event', {
      sessionId: '',
      event: { error: `mcp_config_render_failed:${message}`, done: true } satisfies FlatChunk,
    })
    return { ok: false, error: 'mcp_config_render_failed' }
  }

  let ccEnv: NodeJS.ProcessEnv
  try {
    ccEnv = await buildCcEnv()
  } catch (err) {
    const code = err instanceof CcWrapperError ? err.code : 'env_build_failed'
    const msg = err instanceof Error ? err.message : String(err)
    broadcast('cc:error', { sessionId: '', code, message: msg })
    broadcast('cc:stream-event', {
      sessionId: '',
      event: { error: code, done: true } satisfies FlatChunk,
    })
    return { ok: false, error: code }
  }

  let proc: ChildProcess
  try {
    proc = spawn(exe, argv, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: ccEnv,
    })
  } catch (err) {
    // Synchronous spawn throw (invalid argv/env shape — rare; most spawn
    // failures surface async via proc.on('error') below).
    _spawnFailureCount += 1
    _emitFailureTelemetry(
      'cc_spawn_failed',
      {
        stage: 'spawn_throw',
        code: (err as NodeJS.ErrnoException)?.code ?? null,
        errno: (err as NodeJS.ErrnoException)?.errno ?? null,
        error: err instanceof Error ? err.message : String(err),
        cliVersion: _getCliVersionSafe(),
        retryCount: _spawnFailureCount,
        exe_base: path.basename(exe),
      },
      conversationId,
    )
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  const sessionId = randomUUID()
  const session: CcSession = {
    sessionId,
    conversationId,
    proc,
    cwd,
    model,
    phase: 'spawning',
    stdoutBuffer: '',
    stderrBuffer: '',
    decoder: new TextDecoder('utf-8', { fatal: false }),
    pendingToolInput: new Map(),
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
  }
  sessions.set(sessionId, session)
  byConv.set(conversationId, sessionId)
  _trace('spawn', sessionId, 'argv', { exe, argv: redactArgv(argv), conversationId, model, cwd })
  // Swallow asynchronous EPIPE from a child that exits during a write.
  // The process error/exit handlers still own lifecycle reporting.
  if (proc.stdin && typeof proc.stdin.on === 'function') {
    proc.stdin.on('error', (err) => {
      _trace('stdin', sessionId, 'write_error_swallowed', {
        code: (err as NodeJS.ErrnoException)?.code ?? null,
        error: err.message,
      })
    })
  }

  proc.on('error', (err) => {
    session.phase = 'exited'
    _closeStderrLog(sessionId, {
      type: 'spawn_error',
      code: (err as NodeJS.ErrnoException).code ?? null,
    })

    // A spawn failure is authoritative evidence that the selected executable
    // is missing or unusable. Managed runtimes can clear their active pointer
    // and retry the explicitly configured signed feed; external executables
    // remain entirely user-managed.
    const code = (err as NodeJS.ErrnoException).code ?? ''
    const isBadBinary =
      code === 'ENOENT' || code === 'UNKNOWN' || code === 'ENOEXEC' || code === 'EFTYPE'

    // Report the already-observed failure only when diagnostics are opted in.
    _spawnFailureCount += 1
    _emitFailureTelemetry(
      'cc_spawn_failed',
      {
        stage: 'proc_error',
        code: code || null,
        errno: (err as NodeJS.ErrnoException).errno ?? null,
        error: err.message,
        cliVersion: _getCliVersionSafe(),
        retryCount: _spawnFailureCount,
        exe_base: path.basename(exe),
        isBadBinary,
      },
      conversationId,
    )

    if (isBadBinary && managedRuntime) {
      // Fire-and-forget; the progress broadcaster surfaces signed-feed recovery.
      void recoverFromMissingBinary().catch((re: unknown) => {
        const message = re instanceof Error ? re.message : String(re)
        console.warn(`[cc-wrapper] recoverFromMissingBinary failed: ${message}`)
      })
    }

    const userMessage = isBadBinary
      ? 'runtime_recovery_started'
      : `spawn_error:${err.message}`

    broadcast('cc:stream-event', {
      sessionId,
      event: { error: userMessage, done: true } satisfies FlatChunk,
    })
    broadcast('cc:session-exit', { sessionId, code: null, signal: null, error: err.message })
    sessions.delete(sessionId)
    if (byConv.get(conversationId) === sessionId) byConv.delete(conversationId)
  })

  proc.on('exit', (code, signal) => {
    _trace('exit', sessionId, 'code', { code, signal, stderrTail: session.stderrBuffer.slice(-500) })
    // Flush whatever remains in the decoder (final partial codepoint).
    const tail = session.decoder.decode()
    if (tail) session.stdoutBuffer += tail
    // Process exit is an implicit boundary for a final JSON event even when
    // the CLI omitted the trailing newline.
    if (session.stdoutBuffer.trim()) {
      session.stdoutBuffer += '\n'
      handleStdoutChunk(session, '')
    }
    session.phase = 'exited'
    // Classify only already-observed exit state after flushing buffered output.
    const exitedNonZero = typeof code === 'number' && code !== 0
    if (exitedNonZero && !session.lastEventType) {
      // No valid stream event means an early CLI or runtime failure rather than
      // an interrupted response.
      _spawnFailureCount += 1
      _emitFailureTelemetry(
        'cc_spawn_failed',
        {
          stage: 'early_exit',
          code,
          errno: null,
          signal: signal ?? null,
          cliVersion: _getCliVersionSafe(),
          retryCount: _spawnFailureCount,
          elapsed_ms: Date.now() - session.startedAt,
        },
        conversationId,
      )
    } else {
      const reasons: string[] = []
      if (session.sawApiError) reasons.push('stderr_api_error')
      if ((session.malformedStdoutLines ?? 0) > 0) reasons.push('stdout_json_parse_error')
      if (session.turnInFlight && !session.stopRequested) reasons.push('exit_mid_turn')
      // A requested stop is not an abnormal nonzero exit.
      if (exitedNonZero && !session.stopRequested) reasons.push('nonzero_exit')
      if (reasons.length > 0) {
        _emitFailureTelemetry(
          'cc_stream_abnormal_end',
          {
            reasons: reasons.join(','),
            lastEventType: session.lastEventType ?? null,
            exitCode: code,
            signal: signal ?? null,
            malformedLines: session.malformedStdoutLines ?? 0,
            turnInFlight: session.turnInFlight === true,
            cliVersion: _getCliVersionSafe(),
            elapsed_ms: Date.now() - session.startedAt,
          },
          conversationId,
        )
      }
    }
    _closeStderrLog(sessionId, {
      type: 'exit',
      code: code ?? null,
      signal: signal ?? null,
    })
    broadcast('cc:session-exit', { sessionId, code, signal })
    sessions.delete(sessionId)
    if (byConv.get(conversationId) === sessionId) byConv.delete(conversationId)
  })

  if (proc.stdout) {
    proc.stdout.on('data', (buf: Buffer) => {
      if (_diagnosticsEnabled()) _trace('stdout', sessionId, 'data', buf.toString('utf-8'))
      handleStdoutChunk(session, buf)
    })
  }
  // Opt-in diagnostics store structural summaries only; no raw subprocess
  // output, prompt, argument, executable path, or credential is persisted.
  _openStderrLog(sessionId, {
    pid: proc.pid,
    source: managedRuntime ? 'managed' : 'external',
  })
  if (proc.stderr) {
    proc.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString('utf-8')
      _trace('stderr', sessionId, 'data', text)
      // Record only the presence of a conventional API error marker; stderr
      // raw stderr remains in memory only for the lifetime of this session.
      if (!session.sawApiError && text.includes('API Error')) {
        session.sawApiError = true
      }
      session.stderrBuffer += text
      // Cap stderr to ~256 KB to avoid memory runaway on a misbehaving CLI.
      if (session.stderrBuffer.length > 256 * 1024) {
        session.stderrBuffer = session.stderrBuffer.slice(-128 * 1024)
      }
      _appendStderrSummary(sessionId, text)
    })
  }

  // Transition out of 'spawning' as soon as the process is alive. The first
  // `message_start` will naturally set 'streaming' via the send path.
  session.phase = 'idle'
  return { ok: true, sessionId }
}

/**
 * Resolve attachment bytes locally first. Network retrieval exists only when
 * the user supplies a URL template and enables the remote API opt-in; there is
 * no built-in host, route, or credential source.
 */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const PDF_EXT = new Set(['.pdf'])
const IMAGE_EXT = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
])
// Text-like extensions are embedded as UTF-8; other files use metadata.
const TEXT_EXT = new Set([
  '.txt', '.md', '.log', '.json', '.yaml', '.yml', '.csv', '.tsv',
  '.py', '.tex', '.svg', '.html', '.css', '.js', '.ts', '.tsx', '.vue', '.xml',
])

function _uploadIdFromRef(ref: AttachmentRef): string | null {
  const base = (ref.path || ref.sandbox_relpath || '').split(/[\\/]/).pop() || ''
  // Optional remote templates identify an attachment by a safe basename prefix.
  const m = base.match(/^([A-Za-z0-9]{6,32})_/)
  return m ? m[1] : null
}

async function _readRemoteAttachment(response: Response): Promise<Buffer | null> {
  const contentLengthRaw = response.headers.get('content-length')
  if (contentLengthRaw) {
    const contentLength = Number(contentLengthRaw)
    if (
      !Number.isSafeInteger(contentLength)
      || contentLength < 0
      || contentLength > MAX_ATTACHMENT_BYTES
    ) {
      return null
    }
  }
  if (!response.body) return null

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value)
    total += chunk.length
    if (total > MAX_ATTACHMENT_BYTES) {
      await reader.cancel('attachment_too_large')
      return null
    }
    chunks.push(chunk)
  }
  return total > 0 ? Buffer.concat(chunks, total) : null
}

async function _fetchAttachmentBytes(ref: AttachmentRef): Promise<Buffer | null> {
  const candidate = (ref.path || '').trim()
  if (candidate && path.isAbsolute(candidate)) {
    try {
      const info = fs.lstatSync(candidate)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ATTACHMENT_BYTES) {
        return null
      }
      const bytes = fs.readFileSync(candidate)
      return bytes.length <= MAX_ATTACHMENT_BYTES ? bytes : null
    } catch {
      // It may be an explicitly configured remote attachment reference.
    }
  }

  const uploadId = _uploadIdFromRef(ref)
  const template = (process.env.AWP_AGENT_ATTACHMENT_URL_TEMPLATE ?? '').trim()
  if (!uploadId || !template) return null
  if (process.env.AWP_AGENT_REMOTE_API_OPT_IN !== '1') return null
  if (!template.includes('{id}')) return null

  try {
    const url = new URL(template.replace('{id}', encodeURIComponent(uploadId)))
    const host = url.hostname.toLowerCase()
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null
    if (url.username || url.password) return null

    const headers: Record<string, string> = {}
    const token = (process.env.AWP_AGENT_ATTACHMENT_BEARER_TOKEN ?? '').trim()
    if (token) headers.authorization = `Bearer ${token}`
    const response = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) return null
    return await _readRemoteAttachment(response)
  } catch {
    return null
  }
}

interface ContentBlock {
  type: string
  text?: string
  source?: { type: string; media_type: string; data: string }
}

async function _buildAttachmentBlocks(
  attachments: AttachmentRef[] | undefined,
): Promise<ContentBlock[]> {
  if (!attachments || attachments.length === 0) return []
  const blocks: ContentBlock[] = []
  for (const ref of attachments) {
    const name = ref.filename || (ref.path || '').split(/[\\/]/).pop() || 'file'
    const ext = path.extname(name).toLowerCase()

    const bytes = await _fetchAttachmentBytes(ref)
    if (!bytes) {
      blocks.push({
        type: 'text',
        text: `[Attachment unavailable: ${name}]`,
      })
      continue
    }

    if (PDF_EXT.has(ext)) {
      blocks.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: bytes.toString('base64'),
        },
      })
    } else if (IMAGE_EXT.has(ext)) {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: IMAGE_EXT.get(ext)!,
          data: bytes.toString('base64'),
        },
      })
    } else if (TEXT_EXT.has(ext)) {
      // Decode text-like files as UTF-8 and retain a metadata fallback.
      let text: string
      try {
        text = bytes.toString('utf-8')
      } catch {
        text = `[binary, ${bytes.length} bytes, sha256=${ref.sha256 || '?'}]`
      }
      blocks.push({
        type: 'text',
        text: `<attached_file name="${name}">\n${text}\n</attached_file>`,
      })
    } else {
      // Preserve useful metadata for an unsupported binary extension.
      blocks.push({
        type: 'text',
        text: `[Attached binary file: ${name} (${bytes.length} bytes)]`,
      })
    }
  }
  return blocks
}

export async function sendMessage(opts: SendMessageOpts): Promise<{ ok: boolean; error?: string }> {
  const session = sessions.get(opts.sessionId)
  if (!session) return { ok: false, error: 'unknown_session' }
  if (session.phase === 'exited') return { ok: false, error: 'session_exited' }
  if (!session.proc.stdin || session.proc.stdin.destroyed) {
    return { ok: false, error: 'stdin_unavailable' }
  }

  // Resolve attachments before writing one complete user message.
  const attachBlocks = await _buildAttachmentBlocks(opts.attachments)
  const userContent: ContentBlock[] = [
    ...attachBlocks,
    { type: 'text', text: opts.content },
  ]

  // The configured stream-json protocol uses a role-wrapped user message.
  const msg = {
    type: 'user',
    message: {
      role: 'user',
      content: userContent,
    },
  }
  const line = JSON.stringify(msg) + '\n'
  _trace('stdin', opts.sessionId, 'write', line)
  try {
    const ok = session.proc.stdin.write(line)
    if (!ok) {
      // Note backpressure without dropping the already-buffered write.
      session.stderrBuffer += '[cc-wrapper] stdin backpressure\n'
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  session.phase = 'streaming'
  session.lastActivityAt = Date.now()
  // The turn remains in flight until a done chunk arrives.
  session.turnInFlight = true
  return { ok: true }
}

function hasProcessExited(session: CcSession): boolean {
  return (
    session.phase === 'exited'
    || typeof session.proc.exitCode === 'number'
    || typeof session.proc.signalCode === 'string'
  )
}

function waitForProcessExit(session: CcSession, timeoutMs: number): Promise<boolean> {
  if (hasProcessExited(session)) return Promise.resolve(true)

  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (exited: boolean): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      session.proc.off('exit', onExit)
      resolve(exited)
    }
    const onExit = (): void => finish(true)

    session.proc.once('exit', onExit)
    if (hasProcessExited(session)) {
      finish(true)
      return
    }
    timer = setTimeout(() => finish(false), timeoutMs)
  })
}

async function stopProcess(session: CcSession): Promise<{ ok: boolean }> {
  // Mark the following exit as requested before signaling the process.
  session.stopRequested = true

  // On Windows, ask the CLI to exit through its input protocol before signals.
  if (process.platform === 'win32' && session.proc.stdin && !session.proc.stdin.destroyed) {
    try {
      session.proc.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n')
    } catch {
      /* fall through to process signals */
    }
    if (await waitForProcessExit(session, WIN_SOFT_SHUTDOWN_MS)) return { ok: true }
  }

  try {
    session.proc.kill('SIGTERM')
  } catch {
    /* already dead */
  }

  if (!(await waitForProcessExit(session, STOP_GRACE_MS))) {
    try {
      session.proc.kill('SIGKILL')
    } catch {
      /* already dead */
    }
  }
  return { ok: true }
}

export function stopSession(opts: { sessionId: string }): Promise<{ ok: boolean }> {
  const session = sessions.get(opts.sessionId)
  if (!session || session.phase === 'exited') return Promise.resolve({ ok: true })
  if (!session.stopPromise) session.stopPromise = stopProcess(session)
  return session.stopPromise
}

export function getSessionStatus(opts: { sessionId: string }): SessionStatus {
  const session = sessions.get(opts.sessionId)
  if (!session) return { phase: 'exited' }
  return {
    phase: session.phase,
    pid: session.proc.pid,
    model: session.model,
    conversationId: session.conversationId,
  }
}

/**
 * Stop all live sessions during application shutdown. Each session first gets
 * the normal graceful-cancel path, followed by the bounded signal fallback.
 */
export async function stopAllSessions(): Promise<void> {
  const ids = Array.from(sessions.keys())
  if (ids.length === 0) return
  await Promise.all(ids.map((sessionId) => stopSession({ sessionId })))
}

// ---------------------------------------------------------------------------
// Focused-test helpers over module-local state.
// ---------------------------------------------------------------------------

/** @internal */
export function __resetForTests(): void {
  sessions.clear()
  byConv.clear()
  _stderrFiles.clear()
  ccEvents.removeAllListeners()
}

/** @internal */
export function __peekSession(sessionId: string): CcSession | undefined {
  return sessions.get(sessionId)
}

// ---------------------------------------------------------------------------
// IPC registration
// ---------------------------------------------------------------------------

/** Register the normal per-session IPC surface idempotently. */
export function registerCcIpc(): void {
  for (const ch of ['cc:start', 'cc:send-message', 'cc:stop', 'cc:status', 'cc:get-last-stderr-log']) {
    ipcMain.removeHandler(ch)
  }

  ipcMain.handle('cc:start', async (_evt, opts: StartSessionOpts) => startSession(opts))
  ipcMain.handle('cc:send-message', async (_evt, opts: SendMessageOpts) => sendMessage(opts))
  ipcMain.handle('cc:stop', async (_evt, opts: { sessionId: string }) => stopSession(opts))
  ipcMain.handle('cc:status', (_evt, opts: { sessionId: string }) => getSessionStatus(opts))
  // Return the most recent Agent CLI stderr log (path + tail). The renderer
  // can display this local diagnostic without uploading it anywhere.
  ipcMain.handle('cc:get-last-stderr-log', () => {
    const r = getMostRecentCcStderr()
    if (!r) return null
    // Cap content to last 16 KB so a runaway log doesn't bloat the IPC
    // payload. The full file is on disk at `r.path` if the user wants it.
    const tail = r.content.length > 16 * 1024 ? r.content.slice(-16 * 1024) : r.content
    return { path: r.path, content: tail, full_size: r.content.length }
  })
}
