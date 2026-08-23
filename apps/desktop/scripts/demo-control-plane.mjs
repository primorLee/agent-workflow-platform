import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8787
const DEFAULT_MODEL = 'awp-demo'
const PUBLIC_VERSION = '0.1.0'
const DEMO_TOKEN_HEADER = 'x-awp-demo-token'
const ALLOWED_REQUEST_HEADERS = new Set([
  'accept',
  'authorization',
  'content-type',
  'x-awp-capabilities',
  'x-awp-client-version',
  'x-awp-demo-token',
  'x-csrf-token',
])
const RESERVED_IDS = new Set(['__proto__', 'prototype', 'constructor'])

export const DEMO_LIMITS = Object.freeze({
  artifactBytes: 8 * 1024 * 1024,
  artifacts: 32,
  conversations: 32,
  jsonBytes: 2 * 1024 * 1024,
  messageBytes: 64 * 1024,
  messages: 256,
  messagesPerConversation: 64,
  multipartBytes: 8 * 1024 * 1024 + 64 * 1024,
  stateBytes: 4 * 1024 * 1024,
  totalArtifactBytes: 32 * 1024 * 1024,
})

const STATIC_DEMO_ROUTES = new Set([
  'GET /health',
  'GET /api/health',
  'GET /v1/health/ready',
  'GET /v1/maintenance',
  'GET /v1/changelog',
  'GET /api/chat/models',
  'GET /v1/chat/history',
  'POST /v1/chat/completions',
  'POST /v1/chat/upload',
  'GET /v1/chat/artifacts',
  'GET /v1/activity/events',
  'GET /v1/activity/stream',
])
const HOSTED_AUTH_DEMO_ROUTES = new Set([
  'GET /v1/auth/validate',
  'POST /v1/auth/login',
  'POST /v1/auth/register',
  'POST /v1/auth/logout',
])
const DYNAMIC_DEMO_ROUTES = [
  { method: 'GET', pattern: /^\/v1\/chat\/history\/[^/]+$/u },
  { method: 'PATCH', pattern: /^\/v1\/chat\/history\/[^/]+$/u },
  { method: 'DELETE', pattern: /^\/v1\/chat\/history\/[^/]+$/u },
  { method: 'POST', pattern: /^\/v1\/chat\/history\/[^/]+\/messages$/u },
  { method: 'GET', pattern: /^\/v1\/chat\/artifacts\/[^/]+\/download$/u },
]

export function isDemoRouteImplemented(method, pathname, options = {}) {
  const normalizedMethod = String(method || '').toUpperCase()
  if (options.hostedAuthEnabled === true && HOSTED_AUTH_DEMO_ROUTES.has(normalizedMethod + ' ' + pathname)) return true
  if (STATIC_DEMO_ROUTES.has(normalizedMethod + ' ' + pathname)) return true
  return DYNAMIC_DEMO_ROUTES.some((route) => route.method === normalizedMethod && route.pattern.test(pathname))
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const isoNow = () => new Date().toISOString()
const byteLength = (value) => Buffer.byteLength(String(value), 'utf8')

function requestError(statusCode, code, expectedBoundary = true) {
  const error = new Error(code)
  error.statusCode = statusCode
  error.code = code
  error.expectedBoundary = expectedBoundary
  return error
}

function emptyState() {
  return {
    version: 1,
    conversations: Object.create(null),
    artifacts: Object.create(null),
  }
}

function baseHeaders(corsHeaders = {}, extra = {}) {
  return {
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-site',
    'X-Content-Type-Options': 'nosniff',
    ...corsHeaders,
    ...extra,
  }
}

function sendJson(res, status, value, corsHeaders = {}, extraHeaders = {}) {
  const body = JSON.stringify(value)
  res.writeHead(status, baseHeaders(corsHeaders, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  }))
  res.end(body)
}

function safeErrorBody(status) {
  if (status === 400) return { error: 'invalid request' }
  if (status === 401) return { error: 'unauthorized' }
  if (status === 403) return { error: 'forbidden' }
  if (status === 404) return { error: 'not found' }
  if (status === 413) return { error: 'capacity exceeded' }
  if (status === 415) return { error: 'unsupported media type' }
  if (status === 422) return { error: 'stored demo state is invalid' }
  return { error: 'local demo runtime error' }
}

function hasUnsafeText(value) {
  return typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || /[\u0000-\u001f\u007f\\]/u.test(value)
}

export function normalizeDemoHost(value) {
  if (hasUnsafeText(value)) throw requestError(400, 'invalid_demo_host')
  const normalized = value.toLowerCase()
  if (normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1') return normalized
  throw requestError(400, 'demo_host_must_be_loopback')
}

function normalizeDemoPort(value) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw requestError(400, 'invalid_demo_port')
  return port
}

function normalizeLoopbackOrigin(value) {
  if (hasUnsafeText(value) || value.includes('%')) throw requestError(400, 'invalid_demo_origin')
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw requestError(400, 'invalid_demo_origin')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw requestError(400, 'invalid_demo_origin')
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw requestError(400, 'invalid_demo_origin')
  }
  const hostname = parsed.hostname.toLowerCase()
  if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '[::1]') {
    throw requestError(400, 'invalid_demo_origin')
  }
  return parsed.origin
}

function normalizeAllowedOrigins(values) {
  if (values === undefined) return new Set()
  if (!Array.isArray(values)) throw requestError(400, 'invalid_allowed_origins')
  return new Set(values.map(normalizeLoopbackOrigin))
}

function originPolicy(rawOrigin, allowedOrigins) {
  if (rawOrigin === undefined) return { kind: 'none', headers: {} }
  if (rawOrigin === 'null') {
    return { kind: 'electron', headers: { 'Access-Control-Allow-Origin': 'null', Vary: 'Origin' } }
  }
  let origin
  try {
    origin = normalizeLoopbackOrigin(rawOrigin)
  } catch {
    return { kind: 'denied', headers: {} }
  }
  if (!allowedOrigins.has(origin)) return { kind: 'denied', headers: {} }
  return { kind: 'browser', headers: { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } }
}

function tokenDigest(value) {
  return createHash('sha256').update(value, 'utf8').digest()
}

function requestHasDemoToken(req, expectedDigest) {
  const value = req.headers[DEMO_TOKEN_HEADER]
  if (typeof value !== 'string' || value.length > 512) return false
  return timingSafeEqual(tokenDigest(value), expectedDigest)
}

function parseRequestUrl(raw) {
  if (
    typeof raw !== 'string'
    || !raw.startsWith('/')
    || raw.startsWith('//')
    || raw.includes('#')
    || /[\u0000-\u001f\u007f\\]/u.test(raw)
  ) {
    throw requestError(400, 'invalid_request_target')
  }
  try {
    return new URL(raw, 'http://127.0.0.1')
  } catch {
    throw requestError(400, 'invalid_request_target')
  }
}

function preflightHeaders(req, path, allowedOrigins, hostedAuthEnabled) {
  const origin = originPolicy(req.headers.origin, allowedOrigins)
  if (origin.kind === 'none' || origin.kind === 'denied') throw requestError(403, 'cors_origin_denied')
  const requestedMethod = String(req.headers['access-control-request-method'] || '').toUpperCase()
  if (!isDemoRouteImplemented(requestedMethod, path, { hostedAuthEnabled })) {
    throw requestError(404, 'preflight_route_not_found')
  }
  const requestedHeaders = String(req.headers['access-control-request-headers'] || '')
    .split(',')
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean)
  if (requestedHeaders.some((header) => !ALLOWED_REQUEST_HEADERS.has(header))) {
    throw requestError(403, 'cors_header_denied')
  }
  if (path !== '/health' && !requestedHeaders.includes(DEMO_TOKEN_HEADER)) {
    throw requestError(403, 'demo_token_header_required')
  }
  return baseHeaders(origin.headers, {
    'Access-Control-Allow-Methods': requestedMethod,
    'Access-Control-Allow-Headers': requestedHeaders.join(', '),
    'Access-Control-Max-Age': '600',
  })
}

async function readBody(req, maxBytes) {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) throw requestError(413, 'body_limit')
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw requestError(413, 'body_limit')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function assertNoDangerousKeys(value) {
  const stack = [{ value, depth: 0 }]
  let visited = 0
  while (stack.length) {
    const current = stack.pop()
    if (++visited > 20_000 || current.depth > 20) throw requestError(400, 'structure_limit')
    if (!current.value || typeof current.value !== 'object') continue
    if (Array.isArray(current.value)) {
      for (const entry of current.value) stack.push({ value: entry, depth: current.depth + 1 })
      continue
    }
    for (const [key, entry] of Object.entries(current.value)) {
      if (RESERVED_IDS.has(key.toLowerCase())) throw requestError(400, 'reserved_object_key')
      stack.push({ value: entry, depth: current.depth + 1 })
    }
  }
}

async function readJson(req, maxBytes = DEMO_LIMITS.jsonBytes) {
  const body = await readBody(req, maxBytes)
  if (body.length === 0) return {}
  const parsed = JSON.parse(body.toString('utf8'))
  assertNoDangerousKeys(parsed)
  return parsed
}

function validateOpaqueId(value, label = 'identifier') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) {
    throw requestError(400, 'invalid_' + label)
  }
  if (RESERVED_IDS.has(value.toLowerCase())) throw requestError(400, 'reserved_' + label)
  return value
}

function optionalOpaqueId(value, label) {
  if (value === undefined || value === null || value === '') return undefined
  return validateOpaqueId(String(value), label)
}

function decodeOpaqueSegment(value, label) {
  if (typeof value !== 'string' || value.includes('%')) throw requestError(400, 'invalid_' + label)
  return validateOpaqueId(value, label)
}

function validateUploadFilename(value) {
  const filename = String(value || '')
  if (!filename || filename.length > 128 || byteLength(filename) > 255) throw requestError(400, 'invalid_filename')
  if (filename === '.' || filename === '..' || /[/\\:\u0000-\u001f\u007f]/u.test(filename)) {
    throw requestError(400, 'invalid_filename')
  }
  if (/^[ .]|[ .]$/u.test(filename) || !/^[\p{L}\p{N} ._()+\-\[\]]+$/u.test(filename)) {
    throw requestError(400, 'invalid_filename')
  }
  const stem = filename.split('.')[0].toUpperCase()
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem)) throw requestError(400, 'reserved_filename')
  return filename
}

function normalizeContentType(value) {
  const contentType = String(value || '')
  return /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u.test(contentType)
    ? contentType
    : 'application/octet-stream'
}

async function readMultipartUpload(req) {
  const contentType = String(req.headers['content-type'] || '')
  if (!/^multipart\/form-data\s*;/iu.test(contentType) || !/\bboundary=/iu.test(contentType)) {
    throw requestError(415, 'multipart_required')
  }
  const body = await readBody(req, DEMO_LIMITS.multipartBytes)
  let form
  try {
    form = await new Response(body, { headers: { 'content-type': contentType } }).formData()
  } catch {
    throw requestError(400, 'malformed_multipart')
  }
  const entries = [...form.entries()]
  if (entries.some(([name]) => name !== 'file' && name !== 'conversation_id')) {
    throw requestError(400, 'unsupported_form_field')
  }
  const fileEntries = entries.filter(([name]) => name === 'file')
  const conversationEntries = entries.filter(([name]) => name === 'conversation_id')
  if (fileEntries.length !== 1 || conversationEntries.length > 1) throw requestError(400, 'invalid_file_count')
  const file = fileEntries[0][1]
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
    throw requestError(400, 'invalid_file_part')
  }
  if (file.size > DEMO_LIMITS.artifactBytes) throw requestError(413, 'artifact_limit')
  const bytes = Buffer.from(await file.arrayBuffer())
  if (bytes.length > DEMO_LIMITS.artifactBytes) throw requestError(413, 'artifact_limit')
  return {
    bytes,
    contentType: normalizeContentType(file.type),
    conversationId: optionalOpaqueId(conversationEntries[0]?.[1], 'conversation_id'),
    filename: validateUploadFilename(file.name),
  }
}
function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertAllowedKeys(value, allowed, status) {
  if (!isPlainRecord(value)) throw requestError(status, 'invalid_state_shape')
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw requestError(status, 'unknown_state_field')
  }
}

function validateText(value, maxBytes, status, label, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || byteLength(value) > maxBytes) {
    throw requestError(status, 'invalid_' + label)
  }
  return value
}

function validateTimestamp(value, status) {
  const timestamp = validateText(value, 80, status, 'timestamp')
  if (!Number.isFinite(Date.parse(timestamp))) throw requestError(status, 'invalid_timestamp')
  return timestamp
}

function cloneMetadata(value, status) {
  if (value === undefined) return undefined
  if (!isPlainRecord(value)) throw requestError(status, 'invalid_metadata')
  let serialized
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw requestError(status, 'invalid_metadata')
  }
  if (byteLength(serialized) > 16 * 1024) throw requestError(status, 'metadata_limit')
  const copy = JSON.parse(serialized)
  try {
    assertNoDangerousKeys(copy)
  } catch {
    throw requestError(status, 'invalid_metadata')
  }
  return copy
}

const MESSAGE_KEYS = new Set(['id', 'role', 'content', 'created_at', 'model', 'metadata'])
const CONVERSATION_KEYS = new Set([
  'conversation_id',
  'title',
  'created_at',
  'updated_at',
  'model',
  'cc_session_id',
  'messages',
])
const ARTIFACT_KEYS = new Set([
  'id',
  'filename',
  'size_bytes',
  'content_type',
  'created_at',
  'conversation_id',
  'sha256',
  'storage_name',
])
const STATE_KEYS = new Set(['version', 'conversations', 'artifacts'])

function canonicalMessage(value, status, requireAllFields = true) {
  assertAllowedKeys(value, MESSAGE_KEYS, status)
  if (!['user', 'assistant', 'system'].includes(value.role)) throw requestError(status, 'invalid_message_role')
  const id = value.id === undefined && !requireAllFields
    ? randomUUID()
    : validateOpaqueId(value.id, 'message_id')
  const content = validateText(value.content, DEMO_LIMITS.messageBytes, status, 'message_content', true)
  const createdAt = value.created_at === undefined && !requireAllFields
    ? isoNow()
    : validateTimestamp(value.created_at, status)
  const model = value.model === undefined
    ? undefined
    : validateText(String(value.model), 128, status, 'model')
  const metadata = cloneMetadata(value.metadata, status)
  return {
    id,
    role: value.role,
    content,
    created_at: createdAt,
    ...(model ? { model } : {}),
    ...(metadata ? { metadata } : {}),
  }
}

function validateState(raw, status) {
  try {
    assertNoDangerousKeys(raw)
  } catch {
    throw requestError(status, 'invalid_state_keys')
  }
  assertAllowedKeys(raw, STATE_KEYS, status)
  if (raw.version !== 1 || !isPlainRecord(raw.conversations) || !isPlainRecord(raw.artifacts)) {
    throw requestError(status, 'invalid_state_shape')
  }

  const conversationKeys = Object.keys(raw.conversations)
  const artifactKeys = Object.keys(raw.artifacts)
  if (conversationKeys.length > DEMO_LIMITS.conversations) throw requestError(status, 'conversation_limit')
  if (artifactKeys.length > DEMO_LIMITS.artifacts) throw requestError(status, 'artifact_count_limit')

  const conversations = Object.create(null)
  let totalMessages = 0
  for (const mapId of conversationKeys) {
    const id = validateOpaqueId(mapId, 'conversation_id')
    const value = raw.conversations[mapId]
    assertAllowedKeys(value, CONVERSATION_KEYS, status)
    if (value.conversation_id !== id || !Array.isArray(value.messages)) {
      throw requestError(status, 'invalid_conversation')
    }
    if (value.messages.length > DEMO_LIMITS.messagesPerConversation) {
      throw requestError(status, 'conversation_message_limit')
    }
    totalMessages += value.messages.length
    if (totalMessages > DEMO_LIMITS.messages) throw requestError(status, 'message_count_limit')
    const messages = value.messages.map((message) => canonicalMessage(message, status, true))
    conversations[id] = {
      conversation_id: id,
      title: validateText(value.title, 512, status, 'conversation_title'),
      created_at: validateTimestamp(value.created_at, status),
      updated_at: validateTimestamp(value.updated_at, status),
      model: validateText(value.model, 128, status, 'model'),
      cc_session_id: validateOpaqueId(value.cc_session_id, 'session_id'),
      messages,
    }
  }

  const artifacts = Object.create(null)
  let totalArtifactBytes = 0
  for (const mapId of artifactKeys) {
    const id = validateOpaqueId(mapId, 'artifact_id')
    const value = raw.artifacts[mapId]
    assertAllowedKeys(value, ARTIFACT_KEYS, status)
    if (
      value.id !== id
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)
      || value.storage_name !== id + '.bin'
    ) {
      throw requestError(status, 'invalid_artifact_identity')
    }
    const size = Number(value.size_bytes)
    if (!Number.isSafeInteger(size) || size < 0 || size > DEMO_LIMITS.artifactBytes) {
      throw requestError(status, 'invalid_artifact_size')
    }
    totalArtifactBytes += size
    if (totalArtifactBytes > DEMO_LIMITS.totalArtifactBytes) throw requestError(status, 'artifact_bytes_limit')
    if (!/^[0-9a-f]{64}$/u.test(value.sha256)) throw requestError(status, 'invalid_artifact_hash')
    artifacts[id] = {
      id,
      filename: validateUploadFilename(value.filename),
      size_bytes: size,
      content_type: normalizeContentType(value.content_type),
      created_at: validateTimestamp(value.created_at, status),
      ...(value.conversation_id
        ? { conversation_id: validateOpaqueId(value.conversation_id, 'conversation_id') }
        : {}),
      sha256: value.sha256,
      storage_name: value.storage_name,
    }
  }

  const canonical = { version: 1, conversations, artifacts }
  const serialized = JSON.stringify(canonical)
  if (byteLength(serialized) > DEMO_LIMITS.stateBytes) throw requestError(status, 'state_size_limit')
  return canonical
}

function artifactStoragePath(root, storageName) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.bin$/iu.test(storageName)) {
    throw requestError(422, 'invalid_artifact_storage')
  }
  const candidate = resolve(root, storageName)
  const child = relative(root, candidate)
  if (!child || child.startsWith('..') || isAbsolute(child)) throw requestError(422, 'artifact_containment')
  return candidate
}

function createStore(stateFile) {
  let writeQueue = Promise.resolve()

  async function load() {
    try {
      const entry = await lstat(stateFile)
      if (entry.isSymbolicLink() || !entry.isFile() || entry.size > DEMO_LIMITS.stateBytes) {
        throw requestError(422, 'invalid_state_file')
      }
      const parsed = JSON.parse(await readFile(stateFile, 'utf8'))
      return validateState(parsed, 422)
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyState()
      if (error instanceof SyntaxError) throw requestError(422, 'invalid_state_json')
      throw error
    }
  }

  async function save(rawState) {
    const state = validateState(rawState, 413)
    const serialized = JSON.stringify(state, null, 2) + '\n'
    if (byteLength(serialized) > DEMO_LIMITS.stateBytes) throw requestError(413, 'state_size_limit')
    await mkdir(dirname(stateFile), { recursive: true })
    try {
      const existing = await lstat(stateFile)
      if (existing.isSymbolicLink() || !existing.isFile()) throw requestError(422, 'invalid_state_file')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const temporaryPath = stateFile + '.' + process.pid + '.' + randomUUID() + '.tmp'
    try {
      await writeFile(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temporaryPath, stateFile)
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {})
    }
  }

  async function update(mutator) {
    let result
    const operation = writeQueue.then(async () => {
      const state = await load()
      result = await mutator(state)
      await save(state)
    })
    writeQueue = operation.catch(() => {})
    await operation
    return result
  }

  return { load, update }
}

function publicArtifact(artifact) {
  return {
    id: artifact.id,
    filename: artifact.filename,
    size: artifact.size_bytes,
    size_bytes: artifact.size_bytes,
    content_type: artifact.content_type,
    created_at: artifact.created_at,
    ...(artifact.conversation_id ? { conversation_id: artifact.conversation_id } : {}),
    sha256: artifact.sha256,
    download_url: '/v1/chat/artifacts/' + artifact.id + '/download',
  }
}

function titleFromMessages(messages) {
  const first = messages.find((message) => message && message.role === 'user' && typeof message.content === 'string')
  const compact = first?.content?.replace(/\s+/gu, ' ').trim()
  return compact ? compact.slice(0, 56) : 'Demo conversation'
}

function demoReply(lastUserText, conversationId) {
  const prompt = String(lastUserText || '').trim()
  return [
    'Demo mode is active.',
    '',
    '- Your message arrived through the production SSE adapter: **' + (prompt || 'hello') + '**',
    '- This reply is emitted as multiple real stream events.',
    '- Conversation ' + conversationId + ' is persisted locally and survives a restart.',
    '',
    'Set VITE_AWP_CHAT_ADAPTER_URL to connect the same UI to another chat-compatible adapter.',
  ].join('\n')
}

function appendUnique(conversation, rawMessage) {
  const message = canonicalMessage({
    id: rawMessage.id,
    role: rawMessage.role,
    content: rawMessage.content,
    created_at: rawMessage.created_at,
    ...(rawMessage.model ? { model: rawMessage.model } : {}),
    ...(rawMessage.metadata ? { metadata: rawMessage.metadata } : {}),
  }, 400, false)
  const duplicate = conversation.messages.find((existing) =>
    existing.id === message.id
    || (existing.role === message.role && existing.content === message.content),
  )
  if (duplicate) return duplicate
  if (conversation.messages.length >= DEMO_LIMITS.messagesPerConversation) {
    throw requestError(413, 'conversation_message_limit')
  }
  conversation.messages.push(message)
  conversation.updated_at = isoNow()
  if (conversation.title === 'Demo conversation' && message.role === 'user') {
    conversation.title = titleFromMessages([message])
  }
  return message
}

function createConversation(state, requestedId, model, messages = []) {
  const id = requestedId ? validateOpaqueId(requestedId, 'conversation_id') : randomUUID()
  if (Object.hasOwn(state.conversations, id)) return state.conversations[id]
  if (Object.keys(state.conversations).length >= DEMO_LIMITS.conversations) {
    throw requestError(413, 'conversation_limit')
  }
  const now = isoNow()
  const conversation = {
    conversation_id: id,
    title: titleFromMessages(messages),
    created_at: now,
    updated_at: now,
    model: model ? validateText(String(model), 128, 400, 'model') : DEFAULT_MODEL,
    cc_session_id: 'demo-session-' + randomUUID(),
    messages: [],
  }
  state.conversations[id] = conversation
  return conversation
}

function toHistory(conversation) {
  return {
    conversation_id: conversation.conversation_id,
    title: conversation.title,
    created_at: conversation.created_at,
    message_count: conversation.messages.length,
  }
}

function writeSse(res, value) {
  if (!res.destroyed && !res.writableEnded) {
    res.write('data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n\n')
  }
}

function parseBoundedInteger(value, fallback, maximum) {
  if (value === null || value === '') return fallback
  if (!/^\d{1,9}$/u.test(value)) throw requestError(400, 'invalid_query_integer')
  return Math.min(Number(value), maximum)
}
export async function startDemoControlPlane(options = {}) {
  const host = normalizeDemoHost(options.host ?? process.env.AWP_DEMO_HOST ?? DEFAULT_HOST)
  const port = normalizeDemoPort(options.port ?? process.env.AWP_DEMO_PORT ?? DEFAULT_PORT)
  const stateFile = resolve(options.stateFile || process.env.AWP_DEMO_DATA_FILE || '.demo-data/sessions.json')
  const hostedAuthOptIn = options.hostedAuthOptIn ?? process.env.AWP_HOSTED_AUTH_OPT_IN ?? '0'
  const hostedAuthEnabled = hostedAuthOptIn === '1'
  const modelId = String(options.modelId ?? process.env.AWP_DEMO_MODEL ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL
  const modelName = String(options.modelName ?? process.env.AWP_DEMO_MODEL_NAME ?? 'AWP Local Demo').trim() || modelId
  const modelDescription = String(
    options.modelDescription
      ?? process.env.AWP_DEMO_MODEL_DESCRIPTION
      ?? 'Deterministic local model for UI and workflow demonstrations',
  ).trim()
  const allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins)
  const demoToken = randomBytes(32).toString('base64url')
  const expectedTokenDigest = tokenDigest(demoToken)
  const store = createStore(stateFile)
  const artifactRoot = resolve(dirname(stateFile), 'attachments')

  await store.load()

  const server = createServer(async (req, res) => {
    let corsHeaders = {}
    try {
      const url = parseRequestUrl(req.url || '/')
      const path = url.pathname
      const origin = originPolicy(req.headers.origin, allowedOrigins)
      if (origin.kind === 'denied') throw requestError(403, 'cors_origin_denied')
      corsHeaders = origin.headers

      if (req.method === 'OPTIONS') {
        const headers = preflightHeaders(req, path, allowedOrigins, hostedAuthEnabled)
        res.writeHead(204, headers)
        res.end()
        return
      }

      if (!isDemoRouteImplemented(req.method, path, { hostedAuthEnabled })) {
        sendJson(res, 404, safeErrorBody(404), corsHeaders)
        return
      }

      const isPublicHealth = req.method === 'GET' && path === '/health'
      if (!isPublicHealth && !requestHasDemoToken(req, expectedTokenDigest)) {
        sendJson(res, 401, safeErrorBody(401), corsHeaders)
        return
      }

      if (req.method === 'GET' && (path === '/health' || path === '/api/health' || path === '/v1/health/ready')) {
        sendJson(res, 200, { status: 'ok', version: 'demo' }, corsHeaders)
        return
      }


      if (req.method === 'GET' && path === '/v1/maintenance') {
        sendJson(res, 200, { enabled: false, message: '', updated_at: null }, corsHeaders)
        return
      }

      if (req.method === 'GET' && path === '/v1/changelog') {
        sendJson(res, 200, [{
          version: PUBLIC_VERSION,
          title: 'Local-first public preview',
          body: 'Durable chat sessions, strict local artifacts, and production-style SSE are enabled in demo mode.',
          published_at: '2026-08-22T00:00:00.000Z',
        }], corsHeaders)
        return
      }


      if (req.method === 'GET' && path === '/api/chat/models') {
        sendJson(res, 200, [{
          id: modelId,
          name: modelName,
          provider: 'local',
          description: modelDescription,
        }], corsHeaders)
        return
      }

      if (req.method === 'POST' && path === '/v1/chat/upload') {
        const upload = await readMultipartUpload(req)
        let destination
        let renamed = false
        let artifact
        try {
          artifact = await store.update(async (state) => {
            const artifacts = Object.values(state.artifacts)
            const totalBytes = artifacts.reduce((sum, item) => sum + item.size_bytes, 0)
            if (
              artifacts.length >= DEMO_LIMITS.artifacts
              || totalBytes + upload.bytes.length > DEMO_LIMITS.totalArtifactBytes
            ) {
              throw requestError(413, 'artifact_capacity')
            }

            const id = randomUUID()
            const storageName = id + '.bin'
            destination = artifactStoragePath(artifactRoot, storageName)
            try {
              await lstat(destination)
              throw requestError(500, 'artifact_collision', false)
            } catch (error) {
              if (error?.code !== 'ENOENT') throw error
            }

            const temporaryPath = destination + '.' + process.pid + '.' + randomUUID() + '.tmp'
            await mkdir(artifactRoot, { recursive: true })
            try {
              await writeFile(temporaryPath, upload.bytes, { flag: 'wx', mode: 0o600 })
              await rename(temporaryPath, destination)
              renamed = true
            } finally {
              await rm(temporaryPath, { force: true }).catch(() => {})
            }

            const created = {
              id,
              filename: upload.filename,
              size_bytes: upload.bytes.length,
              content_type: upload.contentType,
              created_at: isoNow(),
              ...(upload.conversationId ? { conversation_id: upload.conversationId } : {}),
              sha256: createHash('sha256').update(upload.bytes).digest('hex'),
              storage_name: storageName,
            }
            state.artifacts[id] = created
            return created
          })
        } catch (error) {
          if (renamed && destination) await rm(destination, { force: true }).catch(() => {})
          throw error
        }

        sendJson(res, 200, {
          path: artifact.id,
          filename: artifact.filename,
          size: artifact.size_bytes,
          sandbox_relpath: 'attachments/' + artifact.id,
          sha256: artifact.sha256,
        }, corsHeaders)
        return
      }

      if (req.method === 'GET' && path === '/v1/chat/artifacts') {
        const conversationId = optionalOpaqueId(url.searchParams.get('conversation_id'), 'conversation_id')
        const limit = parseBoundedInteger(url.searchParams.get('limit'), 100, 100)
        const state = await store.load()
        const artifacts = Object.values(state.artifacts)
          .filter((artifact) => !conversationId || artifact.conversation_id === conversationId)
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
          .slice(0, limit)
          .map(publicArtifact)
        sendJson(res, 200, { artifacts }, corsHeaders)
        return
      }

      const artifactDownloadMatch = path.match(/^\/v1\/chat\/artifacts\/([^/]+)\/download$/u)
      if (req.method === 'GET' && artifactDownloadMatch) {
        const id = decodeOpaqueSegment(artifactDownloadMatch[1], 'artifact_id')
        const state = await store.load()
        if (!Object.hasOwn(state.artifacts, id)) {
          sendJson(res, 404, { error: 'artifact not found' }, corsHeaders)
          return
        }
        const artifact = state.artifacts[id]
        const artifactPath = artifactStoragePath(artifactRoot, artifact.storage_name)
        const entry = await lstat(artifactPath)
        if (entry.isSymbolicLink() || !entry.isFile() || entry.size > DEMO_LIMITS.artifactBytes) {
          throw requestError(422, 'invalid_artifact_file')
        }
        const bytes = await readFile(artifactPath)
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        if (bytes.length !== artifact.size_bytes || sha256 !== artifact.sha256) {
          throw requestError(422, 'artifact_integrity')
        }
        const fallbackName = 'artifact-' + id + '.bin'
        res.writeHead(200, baseHeaders(corsHeaders, {
          'Content-Type': artifact.content_type,
          'Content-Length': bytes.length,
          'Content-Disposition': 'attachment; filename="' + fallbackName + '"; filename*=UTF-8' + "''" + encodeURIComponent(artifact.filename),
        }))
        res.end(bytes)
        return
      }
      if (req.method === 'GET' && path === '/v1/chat/history') {
        const state = await store.load()
        const offset = parseBoundedInteger(url.searchParams.get('offset'), 0, DEMO_LIMITS.conversations)
        const limit = parseBoundedInteger(url.searchParams.get('limit'), 100, DEMO_LIMITS.conversations)
        const rows = Object.values(state.conversations)
          .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
          .slice(offset, offset + limit)
          .map(toHistory)
        sendJson(res, 200, rows, corsHeaders)
        return
      }

      const messageMatch = path.match(/^\/v1\/chat\/history\/([^/]+)\/messages$/u)
      if (req.method === 'POST' && messageMatch) {
        const id = decodeOpaqueSegment(messageMatch[1], 'conversation_id')
        const body = await readJson(req)
        const result = await store.update((state) => {
          const conversation = createConversation(state, id, body.model, [body])
          const message = appendUnique(conversation, {
            id: body.message_id,
            role: body.role,
            content: body.content,
            ...(body.model ? { model: body.model } : {}),
            ...(body.metadata ? { metadata: body.metadata } : {}),
          })
          return { ok: true, message_id: message.id, conversation_id: id }
        })
        sendJson(res, 200, result, corsHeaders)
        return
      }

      const historyMatch = path.match(/^\/v1\/chat\/history\/([^/]+)$/u)
      if (historyMatch) {
        const id = decodeOpaqueSegment(historyMatch[1], 'conversation_id')
        if (req.method === 'GET') {
          const state = await store.load()
          if (!Object.hasOwn(state.conversations, id)) {
            sendJson(res, 404, { error: 'conversation not found' }, corsHeaders)
            return
          }
          const conversation = state.conversations[id]
          sendJson(res, 200, {
            messages: conversation.messages.map(({ role, content, metadata }) => ({
              role,
              content,
              ...(metadata ? { metadata } : {}),
            })),
            model: conversation.model,
            updated_at: conversation.updated_at,
            cc_session_id: conversation.cc_session_id,
          }, corsHeaders)
          return
        }
        if (req.method === 'PATCH') {
          const body = await readJson(req)
          const updated = await store.update((state) => {
            if (!Object.hasOwn(state.conversations, id)) return false
            const conversation = state.conversations[id]
            if (body.cc_session_id !== undefined) {
              conversation.cc_session_id = validateOpaqueId(body.cc_session_id, 'session_id')
            }
            conversation.updated_at = isoNow()
            return true
          })
          sendJson(res, updated ? 200 : 404, updated ? { ok: true } : { error: 'conversation not found' }, corsHeaders)
          return
        }
        if (req.method === 'DELETE') {
          const deleted = await store.update((state) => {
            if (!Object.hasOwn(state.conversations, id)) return false
            delete state.conversations[id]
            return true
          })
          sendJson(res, 200, { deleted, conversation_id: id }, corsHeaders)
          return
        }
      }

      if (req.method === 'POST' && path === '/v1/chat/completions') {
        const body = await readJson(req)
        const incoming = Array.isArray(body.messages) ? body.messages : []
        if (incoming.length > 32) throw requestError(413, 'request_message_limit')
        const requestedId = optionalOpaqueId(body.conversation_id, 'conversation_id')
        const prepared = await store.update((state) => {
          const conversation = createConversation(state, requestedId, body.model, incoming)
          for (const message of incoming) appendUnique(conversation, message)
          const lastUser = [...incoming].reverse().find((message) => message && message.role === 'user')
          const content = demoReply(lastUser?.content, conversation.conversation_id)
          appendUnique(conversation, { role: 'assistant', content, model: body.model || DEFAULT_MODEL })
          return {
            conversationId: conversation.conversation_id,
            sessionId: conversation.cc_session_id,
            content,
          }
        })

        res.writeHead(200, baseHeaders(corsHeaders, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          Connection: 'keep-alive',
          'X-Conversation-Id': prepared.conversationId,
        }))
        res.flushHeaders?.()
        writeSse(res, {
          type: 'message_start',
          conversation_id: prepared.conversationId,
          cc_session_id: prepared.sessionId,
        })
        await sleep(20)
        writeSse(res, { type: 'cc_status', tool: 'DemoRuntime', label: 'Streaming from the local demo runtime' })
        for (const chunk of prepared.content.match(/.{1,28}(?:\s|$)|.{1,28}/gu) || [prepared.content]) {
          await sleep(10)
          writeSse(res, { delta: chunk, conversation_id: prepared.conversationId })
        }
        writeSse(res, '[DONE]')
        res.end()
        return
      }

      if (req.method === 'GET' && path === '/v1/activity/events') {
        sendJson(res, 200, { events: [] }, corsHeaders)
        return
      }

      if (req.method === 'GET' && path === '/v1/activity/stream') {
        res.writeHead(200, baseHeaders(corsHeaders, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          Connection: 'keep-alive',
        }))
        res.write(': local demo activity stream\n\n')
        const heartbeat = setInterval(() => {
          if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n')
        }, 15_000)
        req.on('close', () => clearInterval(heartbeat))
        return
      }

      if (req.method === 'GET' && path === '/v1/auth/validate') {
        sendJson(res, 200, { valid: true, customer_id: 'demo', email: 'demo@example.invalid' }, corsHeaders)
        return
      }
      if (req.method === 'POST' && (path === '/v1/auth/login' || path === '/v1/auth/register')) {
        await readJson(req)
        sendJson(res, 200, { api_key: 'demo-local-only', customer_id: 'demo' }, corsHeaders)
        return
      }
      if (req.method === 'POST' && path === '/v1/auth/logout') {
        await readJson(req)
        sendJson(res, 200, { ok: true }, corsHeaders)
        return
      }

      sendJson(res, 500, safeErrorBody(500), corsHeaders)
    } catch (error) {
      const candidate = Number(error?.statusCode || (error instanceof SyntaxError ? 400 : 500))
      const status = [400, 401, 403, 404, 413, 415, 422].includes(candidate) ? candidate : 500
      if (status === 500 && !error?.expectedBoundary) {
        const code = typeof error?.code === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(error.code)
          ? error.code
          : 'internal_error'
        console.error('[demo-control-plane] request failed with code ' + code)
      }
      if (!res.headersSent) sendJson(res, status, safeErrorBody(status), corsHeaders)
      else res.destroy()
    }
  })

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, host, () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })

  const address = server.address()
  const boundPort = typeof address === 'object' && address ? address.port : port
  const displayHost = host === '::1' ? '[::1]' : host
  const runtime = {
    server,
    host,
    port: boundPort,
    stateFile,
    hostedAuthEnabled,
    url: 'http://' + displayHost + ':' + boundPort,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose())
      server.closeAllConnections?.()
    }),
  }
  Object.defineProperty(runtime, 'token', {
    value: demoToken,
    enumerable: false,
    configurable: false,
    writable: false,
  })
  return runtime
}

async function runFromCli() {
  const runtime = await startDemoControlPlane()
  console.log('[AWP demo] local adapter ready at ' + runtime.url)
  console.log('[AWP demo] durable local state is enabled')

  const shutdown = async () => {
    await runtime.close()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runFromCli().catch((error) => {
    const code = typeof error?.code === 'string' ? error.code : 'startup_failed'
    console.error('[AWP demo] failed with code ' + code)
    process.exitCode = 1
  })
}
