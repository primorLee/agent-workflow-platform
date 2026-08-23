#!/usr/bin/env node

/**
 * Minimal AWP Agent CLI protocol adapter for OpenAI-compatible chat endpoints.
 *
 * This is intentionally a reference adapter, not a general agent framework. It
 * turns one real model endpoint into the long-lived JSONL subprocess contract
 * used by AWP Desktop. An exact opt-in can expose one bounded managed-task tool
 * so the complete Desktop -> model -> control plane -> worker path is testable.
 * Replace it with your own Agent CLI for richer planning, tools, and domain state.
 */

import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, platform, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const MAX_INPUT_LINE_BYTES = 32 * 1024 * 1024
const MAX_PROVIDER_BODY_BYTES = 8 * 1024 * 1024
const MAX_CONTROL_PLANE_BODY_BYTES = 2 * 1024 * 1024
const MAX_SESSION_BYTES = 4 * 1024 * 1024
const MAX_MESSAGES = 100
const MAX_MANAGED_TOOL_CALLS_PER_TURN = 4
const MANAGED_TASK_TERMINAL = new Set(['success', 'failed', 'error', 'cancelled'])
const MANAGED_TASK_STATUS = new Set(['pending', 'running', ...MANAGED_TASK_TERMINAL])

const MANAGED_TASK_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'awp_run_managed_task',
    description: 'Run one operator-allow-listed command on the configured trusted AWP worker and wait for its result. This is not sandboxed; use only for explicitly requested trusted execution.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['argv'],
      properties: {
        argv: {
          type: 'array',
          minItems: 1,
          maxItems: 32,
          items: { type: 'string', maxLength: 8192 },
        },
        timeout_seconds: { type: 'number', minimum: 1, maximum: 300, default: 60 },
      },
    },
  },
})

function parseArgs(argv) {
  const out = { model: '', resume: '' }
  const flagsWithValue = new Set([
    '--input-format',
    '--output-format',
    '--mcp-config',
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--model') {
      out.model = String(argv[index + 1] ?? '').trim()
      index += 1
    } else if (arg === '--resume') {
      out.resume = String(argv[index + 1] ?? '').trim()
      index += 1
    } else if (flagsWithValue.has(arg)) {
      index += 1
    } else if (arg === '--print' || arg === '--verbose') {
      // Accepted for compatibility with the AWP stream-json launcher.
    } else {
      throw new Error(`unsupported_argument:${arg}`)
    }
  }
  return out
}

function parseBoundedInteger(name, fallback, minimum, maximum) {
  const raw = String(process.env[name] ?? '').trim()
  if (!raw) return fallback
  if (!/^\d{1,9}$/u.test(raw)) throw new Error(`invalid_${name.toLowerCase()}`)
  const value = Number(raw)
  if (value < minimum || value > maximum) throw new Error(`invalid_${name.toLowerCase()}`)
  return value
}

function isLoopbackHostname(hostname) {
  const value = hostname.toLowerCase()
  return value === 'localhost' || value === '127.0.0.1' || value === '[::1]'
}

function chatCompletionsUrl() {
  const raw = String(
    process.env.AWP_REFERENCE_API_BASE_URL ?? 'http://127.0.0.1:11434/v1',
  ).trim()
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('invalid_api_base_url')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('api_base_url_must_not_contain_credentials_query_or_fragment')
  }
  const local = isLoopbackHostname(url.hostname)
  if (local) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('invalid_local_api_protocol')
    }
  } else {
    if (url.protocol !== 'https:') throw new Error('remote_api_requires_https')
    if (process.env.AWP_REFERENCE_REMOTE_API_OPT_IN !== '1') {
      throw new Error('remote_api_requires_explicit_opt_in')
    }
  }
  const pathname = url.pathname.replace(/\/+$/u, '')
  if (!pathname.endsWith('/chat/completions')) {
    url.pathname = `${pathname}/chat/completions`.replace(/^\/+/u, '/')
  }
  return url
}

function managedTaskConfig() {
  const enabled = process.env.AWP_REFERENCE_MANAGED_TASKS_OPT_IN === '1'
  const rawBase = String(process.env.AWP_REFERENCE_CONTROL_PLANE_URL ?? '').trim()
  const token = String(process.env.AWP_REFERENCE_CONTROL_PLANE_TOKEN ?? '')
  if (!enabled) {
    if (rawBase || token) throw new Error('managed_tasks_require_explicit_opt_in')
    return null
  }
  if (!rawBase || !token) throw new Error('managed_tasks_configuration_incomplete')
  let base
  try {
    base = new URL(rawBase)
  } catch {
    throw new Error('invalid_control_plane_url')
  }
  if (
    base.username
    || base.password
    || base.search
    || base.hash
    || (base.pathname !== '/' && base.pathname !== '')
  ) {
    throw new Error('invalid_control_plane_url')
  }
  const local = isLoopbackHostname(base.hostname)
  if (local) {
    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
      throw new Error('invalid_control_plane_protocol')
    }
  } else if (base.protocol !== 'https:') {
    throw new Error('remote_control_plane_requires_https')
  }
  if (
    token !== token.trim()
    || Buffer.byteLength(token, 'utf8') < 16
    || Buffer.byteLength(token, 'utf8') > 4096
    || /[\u0000-\u0020\u007f]/u.test(token)
  ) {
    throw new Error('invalid_control_plane_token')
  }
  return { base: base.origin, token }
}

function defaultStateDirectory() {
  const explicit = String(process.env.AWP_REFERENCE_STATE_DIR ?? '').trim()
  if (explicit) {
    if (!isAbsolute(explicit) || explicit.includes('\u0000')) throw new Error('invalid_state_directory')
    return resolve(explicit)
  }
  if (platform() === 'win32') {
    const base = process.env.LOCALAPPDATA || process.env.APPDATA || tmpdir()
    return resolve(base, 'AWP', 'reference-agent', 'sessions')
  }
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  return resolve(base, 'awp', 'reference-agent', 'sessions')
}

function validateSessionId(value) {
  if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(value)) throw new Error('invalid_session_id')
  return value
}

function sessionFile(stateDirectory, sessionId) {
  return join(stateDirectory, `${validateSessionId(sessionId)}.json`)
}

function isPrivateOwned(metadata, expectedMode) {
  if (platform() === 'win32') return true
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  return (
    (uid === undefined || metadata.uid === uid)
    && (metadata.mode & 0o777) === expectedMode
  )
}

async function validateStateDirectory(stateDirectory) {
  const absolute = resolve(stateDirectory)
  const root = parse(absolute).root
  const segments = absolute.slice(root.length).split(/[\\/]+/u).filter(Boolean)
  let current = root
  for (const segment of segments) {
    current = join(current, segment)
    const metadata = await lstat(current)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('unsafe_session_state_directory')
    }
  }
  const metadata = await lstat(absolute)
  if (!isPrivateOwned(metadata, 0o700)) throw new Error('unsafe_session_state_permissions')
}

async function canonicalStateDirectory(configured) {
  const configuredInfo = await lstat(configured)
  if (configuredInfo.isSymbolicLink() || !configuredInfo.isDirectory()) {
    throw new Error('unsafe_session_state_directory')
  }
  const canonical = await realpath(configured)
  await validateStateDirectory(canonical)
  return canonical
}

function validateSessionMetadata(metadata) {
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('unsafe_session_state_target')
  }
  if (!isPrivateOwned(metadata, 0o600)) throw new Error('unsafe_session_state_permissions')
  if (metadata.size > MAX_SESSION_BYTES) throw new Error('session_state_oversize')
}

function sameFileIdentity(before, opened) {
  return before.dev === opened.dev && before.ino === opened.ino
}

async function readBoundedSessionFile(file) {
  const before = await lstat(file)
  validateSessionMetadata(before)
  const handle = await open(file, fsConstants.O_RDONLY)
  try {
    const opened = await handle.stat()
    validateSessionMetadata(opened)
    if (!sameFileIdentity(before, opened)) throw new Error('session_state_identity_changed')
    const chunks = []
    let total = 0
    let position = 0
    while (total <= MAX_SESSION_BYTES) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_SESSION_BYTES + 1 - total))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      chunks.push(buffer.subarray(0, bytesRead))
      total += bytesRead
      position += bytesRead
    }
    if (total > MAX_SESSION_BYTES) throw new Error('session_state_oversize')
    return Buffer.concat(chunks, total)
  } finally {
    await handle.close()
  }
}

function validateStoredMessages(value) {
  if (!Array.isArray(value) || value.length > MAX_MESSAGES) throw new Error('invalid_session_messages')
  return value.map((message) => {
    if (!message || typeof message !== 'object') throw new Error('invalid_session_message')
    const role = message.role
    if (role !== 'user' && role !== 'assistant') throw new Error('invalid_session_role')
    const content = message.content
    if (typeof content !== 'string' && !Array.isArray(content)) {
      throw new Error('invalid_session_content')
    }
    return { role, content }
  })
}

async function loadSession(stateDirectory, requestedSessionId) {
  const sessionId = requestedSessionId ? validateSessionId(requestedSessionId) : randomUUID()
  if (!requestedSessionId) return { sessionId, messages: [] }
  const file = sessionFile(stateDirectory, sessionId)
  let bytes
  try {
    bytes = await readBoundedSessionFile(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return { sessionId, messages: [] }
    throw error
  }
  if (bytes.length > MAX_SESSION_BYTES) throw new Error('session_state_oversize')
  let parsed
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('invalid_session_state')
  }
  if (!parsed || parsed.version !== 1 || parsed.session_id !== sessionId) {
    throw new Error('invalid_session_state')
  }
  return { sessionId, messages: validateStoredMessages(parsed.messages) }
}

async function saveSession(stateDirectory, state) {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
  await validateStateDirectory(stateDirectory)
  const target = sessionFile(stateDirectory, state.sessionId)
  try {
    const info = await lstat(target)
    validateSessionMetadata(info)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    session_id: state.sessionId,
    messages: state.messages.slice(-MAX_MESSAGES),
  }), 'utf8')
  if (payload.length > MAX_SESSION_BYTES) throw new Error('session_state_oversize')
  const temporary = join(dirname(target), `.${state.sessionId}.${randomUUID()}.tmp`)
  await writeFile(temporary, payload, { flag: 'wx', mode: 0o600 })
  try {
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

function publicError(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/^[a-z0-9_:-]{1,160}$/iu.test(message)) return message
  return 'provider_request_failed'
}

function textFromInputBlock(block) {
  if (!block || typeof block !== 'object') return null
  if (block.type === 'text' && typeof block.text === 'string') {
    return { type: 'text', text: block.text }
  }
  if (
    block.type === 'image'
    && block.source?.type === 'base64'
    && typeof block.source.media_type === 'string'
    && typeof block.source.data === 'string'
  ) {
    return {
      type: 'image_url',
      image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
    }
  }
  if (block.type === 'document') {
    return { type: 'text', text: '[A document attachment was supplied but this reference adapter does not decode PDFs.]' }
  }
  return null
}

function userMessageFromLine(line) {
  if (Buffer.byteLength(line, 'utf8') > MAX_INPUT_LINE_BYTES) throw new Error('input_message_oversize')
  let value
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error('invalid_input_json')
  }
  if (!value || value.type !== 'user' || value.message?.role !== 'user') {
    throw new Error('invalid_input_message')
  }
  const rawContent = value.message.content
  if (typeof rawContent === 'string') return { role: 'user', content: rawContent }
  if (!Array.isArray(rawContent)) throw new Error('invalid_input_content')
  const content = rawContent.map(textFromInputBlock).filter(Boolean)
  if (content.length === 0) throw new Error('empty_input_content')
  if (content.every((item) => item.type === 'text')) {
    return { role: 'user', content: content.map((item) => item.text).join('\n') }
  }
  return { role: 'user', content }
}

function isShutdownLine(line) {
  try {
    const value = JSON.parse(line)
    return value?.type === 'shutdown'
  } catch {
    return false
  }
}

function extractContent(value) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((item) => {
    if (typeof item === 'string') return item
    if (item && typeof item === 'object' && typeof item.text === 'string') return item.text
    return ''
  }).join('')
}

function mergeProviderToolCalls(payload, pending) {
  const calls = Array.isArray(payload?.tool_calls) ? payload.tool_calls : []
  for (let position = 0; position < calls.length; position += 1) {
    const call = calls[position]
    if (!call || typeof call !== 'object') continue
    const index = Number.isInteger(call.index) && call.index >= 0 ? call.index : position
    const previous = pending.get(index) ?? { id: '', name: '', arguments: '' }
    if (typeof call.id === 'string' && call.id) previous.id = call.id
    if (typeof call.function?.name === 'string' && call.function.name) {
      const fragment = call.function.name
      if (!previous.name || fragment.startsWith(previous.name)) previous.name = fragment
      else if (!previous.name.endsWith(fragment)) previous.name += fragment
    }
    if (typeof call.function?.arguments === 'string') previous.arguments += call.function.arguments
    pending.set(index, previous)
  }
}

function finalizeProviderToolCalls(pending) {
  const finalized = [...pending.entries()].sort(([left], [right]) => left - right).map(([index, call]) => {
    const id = call.id || `call-${index}`
    if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(id)) throw new Error('provider_tool_call_id_invalid')
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(call.name)) {
      throw new Error('provider_tool_name_invalid')
    }
    if (Buffer.byteLength(call.arguments, 'utf8') > 64 * 1024) {
      throw new Error('provider_tool_arguments_oversize')
    }
    let input
    try {
      input = JSON.parse(call.arguments || '{}')
    } catch {
      throw new Error('provider_tool_arguments_invalid_json')
    }
    return { id, name: call.name, arguments: call.arguments || '{}', input }
  })
  if (new Set(finalized.map((call) => call.id)).size !== finalized.length) {
    throw new Error('provider_tool_call_id_duplicate')
  }
  return finalized
}

function parseProviderEvent(raw, pendingToolCalls) {
  let event
  try {
    event = JSON.parse(raw)
  } catch {
    throw new Error('invalid_provider_stream_json')
  }
  if (event?.error) throw new Error('provider_returned_error')
  const choice = Array.isArray(event?.choices) ? event.choices[0] : undefined
  const payload = choice?.delta ?? choice?.message
  mergeProviderToolCalls(payload, pendingToolCalls)
  const text = extractContent(payload?.content)
  const usage = event?.usage && typeof event.usage === 'object' ? event.usage : undefined
  return { text, usage, finishReason: choice?.finish_reason }
}

async function readLimitedJson(response, maximum = MAX_PROVIDER_BODY_BYTES) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('provider_response_body_missing')
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maximum) throw new Error('response_oversize')
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function requestControlPlaneJson(config, method, path, body) {
  if (!/^\/v1\/(?:tasks|tasks\/[0-9a-f-]+)$/u.test(path)) {
    throw new Error('invalid_control_plane_path')
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5_000)
  try {
    const response = await fetch(`${config.base}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
        'user-agent': 'awp-reference-agent-cli/0.1',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: controller.signal,
    })
    if (response.status >= 300 && response.status < 400) throw new Error('control_plane_redirect_rejected')
    if (!response.ok) throw new Error(`control_plane_http_${response.status}`)
    const contentType = String(response.headers.get('content-type') ?? '').toLowerCase()
    if (!contentType.includes('application/json')) throw new Error('control_plane_response_not_json')
    const raw = await readLimitedJson(response, MAX_CONTROL_PLANE_BODY_BYTES)
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('invalid_control_plane_response')
    }
    return value
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('control_plane_timeout')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function validateManagedTaskArgs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('managed_task_arguments_invalid')
  }
  const keys = Object.keys(value)
  if (keys.some((key) => key !== 'argv' && key !== 'timeout_seconds')) {
    throw new Error('managed_task_arguments_invalid')
  }
  const argv = value.argv
  if (
    !Array.isArray(argv)
    || argv.length < 1
    || argv.length > 32
    || argv.some((item) => typeof item !== 'string' || !item || item.length > 8192 || item.includes('\u0000'))
    || !/^[A-Za-z0-9._-]{1,128}$/u.test(argv[0])
  ) {
    throw new Error('managed_task_argv_invalid')
  }
  const totalBytes = argv.reduce((total, item) => total + Buffer.byteLength(item, 'utf8'), 0)
  if (totalBytes > 64 * 1024) throw new Error('managed_task_argv_oversize')
  const timeoutSeconds = value.timeout_seconds === undefined ? 60 : Number(value.timeout_seconds)
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) {
    throw new Error('managed_task_timeout_invalid')
  }
  return { argv, timeoutSeconds }
}

async function runManagedTask(config, rawArgs, sessionId, turnIdentity, toolCallId) {
  const { argv, timeoutSeconds } = validateManagedTaskArgs(rawArgs)
  const digest = createHash('sha256')
    .update(`${sessionId}\u0000${turnIdentity}\u0000${toolCallId}\u0000`, 'utf8')
    .update(JSON.stringify({ argv, timeout_seconds: timeoutSeconds }), 'utf8')
    .digest('hex')
  const created = await requestControlPlaneJson(config, 'POST', '/v1/tasks', {
    task_type: 'command',
    payload: { argv },
    idempotency_key: `awp-reference-agent:${digest}`,
  })
  const taskId = String(created.id ?? '')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(taskId)) {
    throw new Error('invalid_control_plane_task_id')
  }
  const deadline = Date.now() + Math.round(timeoutSeconds * 1000)
  while (Date.now() < deadline) {
    const task = await requestControlPlaneJson(config, 'GET', `/v1/tasks/${taskId}`)
    const status = String(task.status ?? '')
    if (!MANAGED_TASK_STATUS.has(status)) throw new Error('invalid_control_plane_task_status')
    if (MANAGED_TASK_TERMINAL.has(status)) {
      const result = task.result && typeof task.result === 'object' ? task.result : {}
      const output = result.output && typeof result.output === 'object' ? result.output : {}
      return {
        task_id: taskId,
        status,
        exit_code: Number.isInteger(output.exit_code) ? output.exit_code : null,
        stdout: typeof output.stdout === 'string' ? output.stdout.slice(0, 64 * 1024) : '',
        stderr: typeof output.stderr === 'string' ? output.stderr.slice(0, 64 * 1024) : '',
      }
    }
    await new Promise((done) => setTimeout(done, 500))
  }
  return { task_id: taskId, status: 'timeout', exit_code: null, stdout: '', stderr: '' }
}

async function streamProviderResponse(response, onText) {
  const contentType = String(response.headers.get('content-type') ?? '').toLowerCase()
  const pendingToolCalls = new Map()
  if (!contentType.includes('text/event-stream')) {
    const raw = await readLimitedJson(response)
    const parsed = parseProviderEvent(raw, pendingToolCalls)
    if (parsed.text) onText(parsed.text)
    return { usage: parsed.usage, toolCalls: finalizeProviderToolCalls(pendingToolCalls) }
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error('provider_response_body_missing')
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let buffer = ''
  let observedBytes = 0
  let usage

  const consumeEvent = (block) => {
    const data = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim()
    if (!data || data === '[DONE]') return
    const parsed = parseProviderEvent(data, pendingToolCalls)
    if (parsed.text) onText(parsed.text)
    if (parsed.usage) usage = parsed.usage
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    observedBytes += value.length
    if (observedBytes > MAX_PROVIDER_BODY_BYTES) throw new Error('provider_response_oversize')
    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split(/\r?\n\r?\n/u)
    buffer = blocks.pop() ?? ''
    for (const block of blocks) consumeEvent(block)
  }
  buffer += decoder.decode()
  if (buffer.trim()) consumeEvent(buffer)
  return { usage, toolCalls: finalizeProviderToolCalls(pendingToolCalls) }
}

function normalizeUsage(value) {
  if (!value || typeof value !== 'object') return undefined
  const input = Number(value.prompt_tokens ?? value.input_tokens)
  const output = Number(value.completion_tokens ?? value.output_tokens)
  const usage = {}
  if (Number.isFinite(input) && input >= 0) usage.input_tokens = input
  if (Number.isFinite(output) && output >= 0) usage.output_tokens = output
  return Object.keys(usage).length > 0 ? usage : undefined
}

function mergeUsage(total, current) {
  const normalized = normalizeUsage(current)
  if (!normalized) return total
  return {
    input_tokens: (total?.input_tokens ?? 0) + (normalized.input_tokens ?? 0),
    output_tokens: (total?.output_tokens ?? 0) + (normalized.output_tokens ?? 0),
  }
}

async function requestProviderOnce({ endpoint, apiToken, model, messages, timeoutMs, tools }) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const headers = {
    accept: 'text/event-stream, application/json',
    'content-type': 'application/json',
    'user-agent': 'awp-reference-agent-cli/0.1',
  }
  if (apiToken) headers.authorization = `Bearer ${apiToken}`
  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(tools.length > 0 ? { tools } : {}),
      }),
      redirect: 'manual',
      signal: controller.signal,
    })
    if (response.status >= 300 && response.status < 400) throw new Error('provider_redirect_rejected')
    if (!response.ok) throw new Error(`provider_http_${response.status}`)
    let assistantText = ''
    emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    const streamed = await streamProviderResponse(response, (text) => {
      assistantText += text
      if (Buffer.byteLength(assistantText, 'utf8') > MAX_PROVIDER_BODY_BYTES) {
        throw new Error('provider_text_oversize')
      }
      emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
    })
    emit({ type: 'content_block_stop', index: 0 })
    return { assistantText, usage: streamed.usage, toolCalls: streamed.toolCalls }
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('provider_timeout')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function completeTurn({ endpoint, apiToken, model, messages, timeoutMs, managedTasks, sessionId }) {
  const workingMessages = [...messages]
  const turnIdentity = createHash('sha256').update(JSON.stringify(messages), 'utf8').digest('hex')
  let totalUsage
  let managedToolCalls = 0
  for (let round = 0; round < 4; round += 1) {
    const response = await requestProviderOnce({
      endpoint,
      apiToken,
      model,
      messages: workingMessages,
      timeoutMs,
      tools: managedTasks ? [MANAGED_TASK_TOOL] : [],
    })
    totalUsage = mergeUsage(totalUsage, response.usage)
    if (response.toolCalls.length === 0) {
      if (!response.assistantText) throw new Error('provider_returned_empty_text')
      return { assistantText: response.assistantText, usage: totalUsage }
    }
    if (!managedTasks) throw new Error('provider_requested_unavailable_tool')
    managedToolCalls += response.toolCalls.length
    if (managedToolCalls > MAX_MANAGED_TOOL_CALLS_PER_TURN) {
      throw new Error('managed_tool_call_limit')
    }

    const openAiToolCalls = response.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }))
    workingMessages.push({
      role: 'assistant',
      content: response.assistantText || null,
      tool_calls: openAiToolCalls,
    })

    emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: response.toolCalls.map((call) => ({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.input,
        })),
      },
      session_id: sessionId,
    })

    for (const call of response.toolCalls) {
      let toolResult
      if (call.name !== 'awp_run_managed_task') {
        toolResult = { error: 'unknown_managed_tool' }
      } else {
        try {
          toolResult = await runManagedTask(
            managedTasks,
            call.input,
            sessionId,
            turnIdentity,
            call.id,
          )
        } catch (error) {
          toolResult = { error: publicError(error) }
        }
      }
      workingMessages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.name,
        content: JSON.stringify(toolResult),
      })
    }
  }
  throw new Error('managed_tool_round_limit')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const configuredModel = args.model || String(process.env.AWP_REFERENCE_MODEL ?? '').trim()
  if (!configuredModel || configuredModel.length > 256 || /[\u0000-\u001f\u007f]/u.test(configuredModel)) {
    throw new Error('model_required')
  }
  const endpoint = chatCompletionsUrl()
  const apiToken = String(process.env.AWP_REFERENCE_API_TOKEN ?? '')
  if (
    apiToken
    && (
      apiToken !== apiToken.trim()
      || Buffer.byteLength(apiToken, 'utf8') > 4096
      || /[\u0000-\u0020\u007f]/u.test(apiToken)
    )
  ) throw new Error('invalid_api_token')
  const managedTasks = managedTaskConfig()
  const timeoutMs = parseBoundedInteger('AWP_REFERENCE_TIMEOUT_MS', 120_000, 1_000, 600_000)
  const configuredStateDirectory = defaultStateDirectory()
  await mkdir(configuredStateDirectory, { recursive: true, mode: 0o700 })
  const stateDirectory = await canonicalStateDirectory(configuredStateDirectory)
  await access(stateDirectory, fsConstants.R_OK | fsConstants.W_OK)
  const state = await loadSession(stateDirectory, args.resume)
  const systemPrompt = String(process.env.AWP_REFERENCE_SYSTEM_PROMPT ?? '').trim()
  if (
    Buffer.byteLength(systemPrompt, 'utf8') > 256 * 1024
    || systemPrompt.includes('\u0000')
  ) throw new Error('invalid_system_prompt')
  let initialized = false

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (isShutdownLine(line)) break
    try {
      const userMessage = userMessageFromLine(line)
      if (!initialized) {
        initialized = true
        emit({
          type: 'system',
          subtype: 'init',
          session_id: state.sessionId,
          model: configuredModel,
          cwd: process.cwd(),
          tools: managedTasks ? ['awp_run_managed_task'] : [],
        })
      }
      const requestMessages = [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...state.messages,
        userMessage,
      ]
      const result = await completeTurn({
        endpoint,
        apiToken,
        model: configuredModel,
        messages: requestMessages,
        timeoutMs,
        managedTasks,
        sessionId: state.sessionId,
      })
      state.messages.push(userMessage, { role: 'assistant', content: result.assistantText })
      if (state.messages.length > MAX_MESSAGES) state.messages = state.messages.slice(-MAX_MESSAGES)
      await saveSession(stateDirectory, state)
      emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: state.sessionId,
        result: result.assistantText,
        usage: result.usage,
      })
    } catch (error) {
      emit({
        type: 'result',
        subtype: 'error',
        is_error: true,
        session_id: state.sessionId,
        result: publicError(error),
      })
    }
  }
}

main().catch((error) => {
  emit({
    type: 'result',
    subtype: 'startup_error',
    is_error: true,
    result: publicError(error),
  })
  process.exitCode = 1
})
