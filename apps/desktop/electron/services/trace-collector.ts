/**
 * Local opt-in trace collector for desktop workflow diagnostics.
 *
 * The module is inert unless AWP_ENABLE_LOCAL_TRACE is exactly `1`. When
 * enabled, it records bounded JSONL events under the application data
 * directory and rotates the local file. It never uploads, authenticates, or
 * starts a background timer.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

import { getAwpDir } from '../utils/config'
import { logError } from '../utils/logger'

const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_BACKUP_FILES = 3
const MAX_EVENT_PAYLOAD_BYTES = 256 * 1024
const MAX_EMITS_PER_KIND = 10
const MAX_TRACE_DEPTH = 6
const MAX_TRACE_OBJECT_KEYS = 100
const MAX_TRACE_ARRAY_ITEMS = 50
const MAX_TRACE_STRING_CHARS = 4_096
const REDACTED = '[REDACTED]'

export interface TraceEvent {
  event_id: string
  conv_id?: string
  correlation_id?: string
  source: 'desktop' | 'agent_vm'
  kind: string
  seq?: number
  ts: number
  payload: Record<string, unknown>
}

export function isLocalTraceEnabled(): boolean {
  return process.env.AWP_ENABLE_LOCAL_TRACE === '1'
}

function tracesDir(): string {
  return path.join(getAwpDir(), 'traces')
}

function currentFile(): string {
  return path.join(tracesDir(), 'current.jsonl')
}

function ensureTracesDir(): boolean {
  if (!isLocalTraceEnabled()) return false
  try {
    fs.mkdirSync(tracesDir(), { recursive: true })
    return true
  } catch (error) {
    logError('local trace directory creation failed', error)
    return false
  }
}

function newEventId(): string {
  const ms = Date.now().toString(16).padStart(16, '0')
  const rand = randomUUID().replace(/-/g, '').slice(0, 12)
  return ms + rand
}

function rotateIfNeeded(): void {
  if (!isLocalTraceEnabled()) return
  try {
    const activeFile = currentFile()
    if (!fs.existsSync(activeFile) || fs.statSync(activeFile).size < MAX_FILE_BYTES) return

    const backupFile = `${activeFile}.${Date.now()}-${randomUUID().slice(0, 8)}.bak`
    fs.renameSync(activeFile, backupFile)
    const backups = fs.readdirSync(tracesDir())
      .filter((name) => name.startsWith('current.jsonl.') && name.endsWith('.bak'))
      .sort()
    while (backups.length > MAX_BACKUP_FILES) {
      const oldest = backups.shift()
      if (!oldest) break
      try { fs.unlinkSync(path.join(tracesDir(), oldest)) } catch { /* best effort */ }
    }
  } catch (error) {
    logError('local trace rotation failed', error)
  }
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '')
  return [
    'token',
    'password',
    'passwd',
    'secret',
    'credential',
    'authorization',
    'cookie',
    'apikey',
    'privatekey',
  ].some((term) => normalized.includes(term))
}

function scrubTraceString(value: string): string | Record<string, unknown> {
  const privateKeyMarker = ['-----BEGIN ', 'PRIVATE KEY-----'].join('')
  if (value.includes(privateKeyMarker)) return REDACTED

  let scrubbed = value
    .replace(/\bBearer\s+[^\s,;]+/giu, `Bearer ${REDACTED}`)
    .replace(/\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, REDACTED)
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, REDACTED)
    .replace(/\b[A-Za-z0-9_-]{48,}\b/gu, REDACTED)
    .replace(/([?&][^=&#\s]{1,64}=)[^&#\s]*/gu, `$1${REDACTED}`)

  if (scrubbed.length > MAX_TRACE_STRING_CHARS) {
    scrubbed = scrubbed.slice(0, MAX_TRACE_STRING_CHARS)
    return { _truncated_from_chars: value.length, head: scrubbed }
  }
  return scrubbed
}

function scrubTraceValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value == null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'string') return scrubTraceString(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value !== 'object') return `[${typeof value}]`
  if (depth >= MAX_TRACE_DEPTH) return '[MAX_DEPTH]'
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)

  try {
    if (value instanceof Error) {
      return {
        name: scrubTraceString(value.name),
        message: scrubTraceString(value.message),
      }
    }
    if (Array.isArray(value)) {
      const output = value
        .slice(0, MAX_TRACE_ARRAY_ITEMS)
        .map((entry) => scrubTraceValue(entry, depth + 1, seen))
      if (value.length > MAX_TRACE_ARRAY_ITEMS) {
        output.push({ _truncated_items: value.length - MAX_TRACE_ARRAY_ITEMS })
      }
      return output
    }

    const output: Record<string, unknown> = {}
    const entries = Object.entries(value as Record<string, unknown>)
    for (const [key, entry] of entries.slice(0, MAX_TRACE_OBJECT_KEYS)) {
      output[key] = isSensitiveKey(key)
        ? REDACTED
        : scrubTraceValue(entry, depth + 1, seen)
    }
    if (entries.length > MAX_TRACE_OBJECT_KEYS) {
      output._truncated_keys = entries.length - MAX_TRACE_OBJECT_KEYS
    }
    return output
  } finally {
    seen.delete(value)
  }
}

/** Append one bounded event to the local JSONL file when explicitly enabled. */
export function appendTraceEvent(event: TraceEvent): void {
  if (!isLocalTraceEnabled() || !ensureTracesDir()) return
  try {
    rotateIfNeeded()
    const sanitizedEvent: TraceEvent = {
      ...event,
      kind: String(scrubTraceString(event.kind)),
      conv_id: event.conv_id ? String(scrubTraceString(event.conv_id)) : undefined,
      correlation_id: event.correlation_id
        ? String(scrubTraceString(event.correlation_id))
        : undefined,
      payload: scrubTraceValue(event.payload) as Record<string, unknown>,
    }
    let body = JSON.stringify(sanitizedEvent)
    if (Buffer.byteLength(body, 'utf8') > MAX_EVENT_PAYLOAD_BYTES) {
      body = JSON.stringify({
        ...sanitizedEvent,
        payload: {
          _truncated_from_bytes: Buffer.byteLength(body, 'utf8'),
          _kind_was: sanitizedEvent.kind,
          summary: 'payload exceeded local trace cap',
        },
      } satisfies TraceEvent)
    }
    fs.appendFileSync(currentFile(), `${body}\n`, 'utf8')
  } catch (error) {
    logError('local trace append failed', error)
  }
}
/** Record a local desktop event when the operator explicitly opted in. */
export function recordEvent(
  kind: string,
  payload: Record<string, unknown>,
  opts?: { convId?: string; correlationId?: string },
): void {
  if (!isLocalTraceEnabled()) return
  appendTraceEvent({
    event_id: newEventId(),
    conv_id: opts?.convId,
    correlation_id: opts?.correlationId,
    source: 'desktop',
    kind,
    ts: Date.now() / 1000,
    payload,
  })
}

const emitCountByKind = new Map<string, number>()
const sequenceByConversation = new Map<string, number>()

/** Record at most ten local events of a kind per process session. */
export function recordEventCapped(
  kind: string,
  payload: Record<string, unknown>,
  opts?: { convId?: string; correlationId?: string },
): void {
  if (!isLocalTraceEnabled()) return
  try {
    const count = (emitCountByKind.get(kind) ?? 0) + 1
    if (count > MAX_EMITS_PER_KIND) return
    emitCountByKind.set(kind, count)
    recordEvent(kind, { ...payload, emit_seq: count }, opts)
  } catch {
    /* Diagnostics must never affect the caller. */
  }
}

/** @internal Test-only reset for process-lifetime counters. */
export function __resetEmitCapsForTests(): void {
  emitCountByKind.clear()
  sequenceByConversation.clear()
}

function nextSequence(conversationId?: string): number {
  const key = conversationId ?? '_'
  const next = (sequenceByConversation.get(key) ?? 0) + 1
  sequenceByConversation.set(key, next)
  return next
}

/**
 * Wrap an async tool call with local start/end/error events. When local trace
 * is disabled, this delegates directly without inspecting arguments/results.
 */
export async function wrapDispatch<T>(
  tool: string,
  args: Record<string, unknown>,
  fn: () => Promise<T>,
  convId?: string,
): Promise<T> {
  if (!isLocalTraceEnabled()) return fn()

  const correlationId = randomUUID()
  const startMs = Date.now()
  appendTraceEvent({
    event_id: newEventId(),
    conv_id: convId,
    correlation_id: correlationId,
    source: 'desktop',
    kind: 'desktop.tool.start',
    seq: nextSequence(convId),
    ts: startMs / 1000,
    payload: { tool, args: scrubTraceValue(args) },
  })

  try {
    const result = await fn()
    appendTraceEvent({
      event_id: newEventId(),
      conv_id: convId,
      correlation_id: correlationId,
      source: 'desktop',
      kind: 'desktop.tool.end',
      seq: nextSequence(convId),
      ts: Date.now() / 1000,
      payload: {
        tool,
        duration_ms: Date.now() - startMs,
        result: scrubTraceValue(result),
      },
    })
    return result
  } catch (error) {
    appendTraceEvent({
      event_id: newEventId(),
      conv_id: convId,
      correlation_id: correlationId,
      source: 'desktop',
      kind: 'desktop.tool.error',
      seq: nextSequence(convId),
      ts: Date.now() / 1000,
      payload: {
        tool,
        duration_ms: Date.now() - startMs,
        error: scrubTraceValue(error),
      },
    })
    throw error
  }
}
