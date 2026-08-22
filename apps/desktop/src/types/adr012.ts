/**
 * ADR-012 Phase 2 — shared types for the Desktop compatible Agent CLI surface.
 *
 * Purpose (T-A041): catch agent-hallucination / drift bugs at typecheck
 * time. Two concrete iter-6/7 bugs that this module would have caught:
 *
 *   • **Iter 6**: `preload.ts` omitted one of the `cc_*` exposeInMainWorld
 *     keys. The renderer hit `TypeError: api.cc_send_message is not a
 *     function`. If preload had annotated the literal with
 *     `satisfies DesktopElectronApi`, the missing key would have been
 *     a compile error at preload.ts instead of a runtime crash.
 *
 *   • **Iter 7**: `ELECTRON_RUN_AS_NODE` was never forwarded on the CC
 *     spawn env. A strict `CcStartOpts` / `CcSpawnEnv` contract surfaces
 *     the missing field on the call-site instead of in production
 *     machine.
 *
 * Type ownership note:
 *
 *   The canonical shapes below are owned by the main-process modules:
 *     - CcStartOpts / CcStartResult / CcSendMessageOpts / CcStatusResult /
 *       SessionPhase / FlatChunk     → electron/cc/cc-wrapper.ts
 *     - LatestVersionResponse / StatusSnapshot
 *                                    → electron/cc/cc-runtime-updater.ts
 *
 *   We **duplicate** (rather than import) them here because the renderer
 *   tsconfig (tsconfig.app.json) intentionally doesn't include the
 *   electron/ tree. Importing into src/ would drag Node + electron type
 *   resolution into the renderer build and surface unrelated strictness
 *   violations. The main-process sources `import type` from this file to
 *   guarantee the two sides stay in lockstep — see
 *   `electron/cc/cc-wrapper.ts` and `electron/preload.ts`.
 *
 *   Drift guard: if the shapes diverge, the `satisfies` annotation in
 *   preload.ts will fail to typecheck under tsconfig.electron.json
 *   because the main-process imports the duplicated types from this
 *   module. That's the agent-hallucination safety net.
 */

import type { DesktopBridge } from './bridge'

// ---------------------------------------------------------------------------
// Session lifecycle (mirror of electron/cc/cc-wrapper.ts exports)
// ---------------------------------------------------------------------------

export type SessionPhase = 'spawning' | 'idle' | 'streaming' | 'exited'

export interface CcStartOpts {
  conversationId: string
  cwd?: string
  model?: string
  /**
   * Optional CC native session id to resume. When set, cc-wrapper passes
   * `--resume <id>` to the configured Agent CLI so its prompt
   * cache and JSONL history stay intact across thread switches / app
   * restarts. Persisted per-thread by chat store; the first stream event
   * (message_start) emits `cc_session_id` which the store captures for the
   * NEXT resume.
   */
  ccSessionId?: string
}

export interface CcStartResult {
  ok: boolean
  sessionId?: string
  error?: string
}

export interface CcSendMessageOpts {
  sessionId: string
  content: string
  /**
   * Reserved for Phase 2 file/image attachments. Kept open-shaped
   * (`unknown[]`) on the renderer side because the renderer threads
   * its own `UploadedFileRef` instances through here; the main-process
   * cc-wrapper normalises them before forwarding to CC. Narrowing
   * happens at the main/wire boundary, not at the renderer callsite.
   */
  attachments?: unknown[]
}

export interface CcSendMessageResult {
  ok: boolean
  error?: string
}

export interface CcStopResult {
  ok: boolean
  error?: string
}

export interface CcStatusResult {
  phase: SessionPhase | 'unknown'
  pid?: number
  model?: string
  conversationId?: string
}

// ---------------------------------------------------------------------------
// Stream flat-chunk (the internal translated shape consumed by chat.ts)
// ---------------------------------------------------------------------------

/**
 * Flat chunk shape consumed by `src/stores/chat.ts::_ingestChunk`. The
 * main-process cc-wrapper translates adapter stream events into
 * this shape so the CC-local and cloud-proxied paths hit the same
 * switchboard.
 *
 * All fields are optional — a given chunk carries only the subset
 * relevant to the event (e.g. `{ delta }` for text, `{ done: true }` for
 * `message_stop`, `{ error }` for failure).
 */
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
   * CC native session id, set on the first `message_start` event after a
   * cc-wrapper spawn. Renderer captures this and stores it per-thread so
   * subsequent cc_start calls can pass `--resume <id>` to keep the
   * runtime prompt cache warm and the JSONL history intact.
   */
  cc_session_id?: string
}

/**
 * Narrow an arbitrary IPC payload to `FlatChunk`. The main-process
 * cc-wrapper always emits this shape, but renderer-side handlers receive
 * `unknown` so a misbehaving build or a future main-process refactor
 * can't silently corrupt downstream state.
 *
 * Returns `true` if every known field, when present, has its declared
 * type. Absent fields always pass (FlatChunk fields are all optional).
 */
export function isFlatChunk(x: unknown): x is FlatChunk {
  if (!x || typeof x !== 'object') return false
  const r = x as Record<string, unknown>
  if (r.type !== undefined && typeof r.type !== 'string') return false
  if (r.delta !== undefined && typeof r.delta !== 'string') return false
  if (r.conversation_id !== undefined && typeof r.conversation_id !== 'string') return false
  if (r.model !== undefined && typeof r.model !== 'string') return false
  if (r.label !== undefined && typeof r.label !== 'string') return false
  if (r.tool !== undefined && typeof r.tool !== 'string') return false
  if (r.done !== undefined && typeof r.done !== 'boolean') return false
  if (r.error !== undefined && typeof r.error !== 'string') return false
  if (r.cc_session_id !== undefined && typeof r.cc_session_id !== 'string') return false
  return true
}

// ---------------------------------------------------------------------------
// IPC channel envelopes
// ---------------------------------------------------------------------------

/** Envelope for the `cc:stream-event` IPC channel. */
export interface CcStreamEventPayload {
  sessionId: string
  event: FlatChunk
}

/** Envelope for the `cc:session-exit` IPC channel. */
export interface CcSessionExitPayload {
  sessionId: string
  code: number | null
  /** `NodeJS.Signals` on main; string on wire after IPC serialization. */
  signal: string | null
  error?: string
}

// ---------------------------------------------------------------------------
// CC runtime updater (mirror of electron/cc/cc-runtime-updater.ts)
// ---------------------------------------------------------------------------

export interface RuntimeArtifact {
  kind: 'executable'
  url: string
  sha256: string
  bytes?: number
}

export interface LatestVersionResponse {
  version: string
  channel: 'stable' | 'insiders' | 'dev'
  min_desktop_version?: string
  artifacts: Record<string, RuntimeArtifact>
}

export interface StatusSnapshot {
  currentVersion: string | null
  lastCheckMs: number
  lastUpdateMs: number
  updating: boolean
  available: boolean
  source: 'external' | 'managed' | 'disabled'
}

export interface CcRuntimeCheckResult {
  updated: boolean
  from?: string
  to?: string
  error?: string
}

// ---------------------------------------------------------------------------
// MCP config renderer (mirror of electron/cc/mcp-config-renderer.ts)
// ---------------------------------------------------------------------------
// The full preload surface — satisfies target for electron/preload.ts
// ---------------------------------------------------------------------------

/**
 * Every method exposed on `window.electronAPI` by `electron/preload.ts`.
 * Extends `DesktopBridge` so we stay compatible with legacy pywebview
 * callers that type-check against the bridge surface. Adds the ADR-012
 * CC subprocess + CC-runtime-updater methods on top.
 *
 * preload.ts annotates its `contextBridge.exposeInMainWorld` literal
 * with `satisfies DesktopElectronApi` so:
 *
 *   1. A missing `cc_*` key → compile error (prevents iter-6 regression).
 *   2. A typo in a method name → compile error.
 *   3. A signature drift between preload and renderer consumers → compile
 *      error at whichever side gets out of sync.
 */
export interface DesktopElectronApi extends DesktopBridge {
  // ---- CC subprocess lifecycle (T-A014) ----
  cc_start(opts: CcStartOpts): Promise<CcStartResult>
  cc_send_message(opts: CcSendMessageOpts): Promise<CcSendMessageResult>
  cc_stop(opts: { sessionId: string }): Promise<CcStopResult>
  cc_status(opts: { sessionId: string }): Promise<CcStatusResult>
  cc_on_stream_event(cb: (payload: CcStreamEventPayload) => void): () => void
  cc_on_session_exit(cb: (payload: CcSessionExitPayload) => void): () => void
  // 2026-05-19 — fetch the most recent CC subprocess stderr log so the
  // renderer error-bubble can show a "show diagnostic" affordance when the
  // CC process crashes with cc_error_during_execution and similar.
  cc_get_last_stderr_log(): Promise<{ path: string; content: string; full_size: number } | null>

  // ---- CC runtime updater (T-A015) ----
  cc_runtime_status(): Promise<StatusSnapshot>
  cc_runtime_check_now(): Promise<CcRuntimeCheckResult>
  cc_runtime_force_update(): Promise<CcRuntimeCheckResult>
  // ADR-012 Phase 2 IPC mystery fix (2026-04-26).
  cc_runtime_get_cli_path(): Promise<string | null>

  // 1.7.43 — cold-start UX. Renderer subscribes to push events + has a
  // one-shot snapshot getter for newly-mounted views.
  on_cc_runtime_progress(cb: (info: {
    stage: 'idle' | 'downloading' | 'verifying' | 'staging' | 'done' | 'error'
    bytesDownloaded: number
    bytesTotal: number
    version: string | null
    error?: string
  }) => void): () => void
  cc_runtime_progress(): Promise<{
    stage: 'idle' | 'downloading' | 'verifying' | 'staging' | 'done' | 'error'
    bytesDownloaded: number
    bytesTotal: number
    version: string | null
    error?: string
  }>


  // ---- Real awp-ide MCP renderer events ----
  awp_ide_on_notify_user(cb: (payload: { message: string; level: 'info' | 'success' | 'warning' | 'error'; duration_ms: number }) => void): () => void
  awp_ide_on_focus_artifact(cb: (payload: { artifactId: string }) => void): () => void  // Invoke a registered generic desktop MCP tool from the renderer.
  awp_ide_call_tool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }>
}
