/** Strict TOFU host-key verification backed by app-owned private storage. */
import { createHash } from 'node:crypto'
import { BrowserWindow } from 'electron'
import { getAwpDir } from '../utils/config'
import { log } from '../utils/logger'
import {
  atomicWritePrivateFile,
  createExclusivePrivateFile,
  getPrivateStoragePath,
  readPrivateFileIfExists,
} from '../utils/private-storage'

const STORE_SUBDIR = 'ssh'
const STORE_FILE = 'known-hosts.json'
const STORE_SCHEMA = 'awp-known-hosts'
const STORE_VERSION = 1
const STORE_MAX_BYTES = 128 * 1024
const STORE_MAX_ENTRIES = 512
const HOST_REFERENCE_RE = /^[0-9a-f]{64}$/u
const FINGERPRINT_RE = /^[0-9a-f]{64}$/u
const RESERVED_NAMES = new Set(['__proto__', 'prototype', 'constructor'])

interface KnownHostsStore {
  schema: typeof STORE_SCHEMA
  version: typeof STORE_VERSION
  entries: Record<string, string>
}

interface LoadedStore {
  store: KnownHostsStore
  exists: boolean
}

export function getKnownHostsPath(): string {
  return getPrivateStoragePath(getAwpDir(), STORE_SUBDIR, STORE_FILE)
}

export function isKnownHostId(value: unknown): value is string {
  return typeof value === 'string' && HOST_REFERENCE_RE.test(value)
}

/** Opaque stable reference: endpoint details never cross the renderer IPC boundary. */
export function createKnownHostId(host: string, port: number | string | undefined): string {
  const normalizedHost = normalizeHost(host)
  const normalizedPort = normalizePort(port)
  return createHash('sha256').update(`${normalizedHost}:${normalizedPort}`, 'utf8').digest('hex')
}

export function verifyHostKey(
  hostId: string,
  key: Buffer,
  opts?: { notifyOnMismatch?: boolean },
): boolean {
  if (!isKnownHostId(hostId) || !Buffer.isBuffer(key) || key.length < 16 || key.length > 16 * 1024) {
    log('[ssh-known-hosts] verification_rejected reason=invalid_input')
    return false
  }
  const received = createHash('sha256').update(key).digest('hex')
  let loaded: LoadedStore
  try {
    loaded = loadKnownHosts()
  } catch (error) {
    log(`[ssh-known-hosts] verification_rejected reason=${errorKind(error)}`)
    return false
  }
  const stored = loaded.store.entries[hostId]
  if (!stored) {
    if (Object.keys(loaded.store.entries).length >= STORE_MAX_ENTRIES) {
      log('[ssh-known-hosts] verification_rejected reason=entry_limit')
      return false
    }
    loaded.store.entries[hostId] = received
    try {
      persistKnownHosts(loaded)
      log('[ssh-known-hosts] tofu_saved=true')
      return true
    } catch (error) {
      log(`[ssh-known-hosts] verification_rejected reason=${errorKind(error)}`)
      return false
    }
  }
  if (stored === received) return true
  log('[ssh-known-hosts] verification_rejected reason=host_key_mismatch')
  if (opts?.notifyOnMismatch !== false) notifyHostKeyMismatch(hostId, stored, received)
  return false
}

export function makeHostVerifier(
  host: string,
  port: number | string | undefined,
): (key: Buffer) => boolean {
  let hostId: string | null = null
  try {
    hostId = createKnownHostId(host, port)
  } catch {
    // The returned verifier remains fail-closed for an invalid endpoint.
  }
  return (key: Buffer) => hostId !== null && verifyHostKey(hostId, key)
}

/** Remove exactly one existing opaque host reference. */
export function clearKnownHost(hostId: string): number {
  if (!isKnownHostId(hostId)) throw new Error('invalid_host_reference')
  const loaded = loadKnownHosts()
  if (!loaded.exists || !Object.prototype.hasOwnProperty.call(loaded.store.entries, hostId)) return 0
  delete loaded.store.entries[hostId]
  persistKnownHosts(loaded)
  return 1
}

export function notifyHostKeyMismatch(hostId: string, stored: string, received: string): void {
  if (!isKnownHostId(hostId) || !FINGERPRINT_RE.test(stored) || !FINGERPRINT_RE.test(received)) return
  const payload = {
    hostId,
    stored_fp: stored.slice(0, 12),
    received_fp: received.slice(0, 12),
  }
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    try {
      window.webContents.send('transport:host-key-mismatch', payload)
    } catch {
      log('[ssh-known-hosts] mismatch_notification_failed=true')
    }
  }
}

function loadKnownHosts(): LoadedStore {
  const file = readPrivateFileIfExists(
    getAwpDir(),
    STORE_SUBDIR,
    STORE_FILE,
    STORE_MAX_BYTES,
    0o600,
  )
  if (!file) return { store: emptyStore(), exists: false }
  let raw: unknown
  try {
    raw = JSON.parse(file.buffer.toString('utf8'))
  } catch {
    throw new Error('known_hosts_invalid_json')
  }
  return { store: validateStore(raw), exists: true }
}

function validateStore(value: unknown): KnownHostsStore {
  if (!isPlainRecord(value)) throw new Error('known_hosts_invalid_schema')
  if (!hasExactKeys(value, ['entries', 'schema', 'version'])) throw new Error('known_hosts_invalid_schema')
  if (value.schema !== STORE_SCHEMA || value.version !== STORE_VERSION || !isPlainRecord(value.entries)) {
    throw new Error('known_hosts_invalid_schema')
  }
  const source = value.entries
  const keys = Object.keys(source)
  if (keys.length > STORE_MAX_ENTRIES) throw new Error('known_hosts_entry_limit')
  const entries = Object.create(null) as Record<string, string>
  for (const hostId of keys) {
    if (RESERVED_NAMES.has(hostId) || !isKnownHostId(hostId)) throw new Error('known_hosts_invalid_host_reference')
    const fingerprint = source[hostId]
    if (typeof fingerprint !== 'string' || !FINGERPRINT_RE.test(fingerprint)) {
      throw new Error('known_hosts_invalid_fingerprint')
    }
    entries[hostId] = fingerprint
  }
  return { schema: STORE_SCHEMA, version: STORE_VERSION, entries }
}

function persistKnownHosts(loaded: LoadedStore): void {
  const payload = Buffer.from(`${JSON.stringify(loaded.store)}\n`, 'utf8')
  if (payload.length > STORE_MAX_BYTES) throw new Error('known_hosts_too_large')
  if (loaded.exists) {
    atomicWritePrivateFile(getAwpDir(), STORE_SUBDIR, STORE_FILE, payload, STORE_MAX_BYTES, 0o600)
  } else {
    createExclusivePrivateFile(getAwpDir(), STORE_SUBDIR, STORE_FILE, payload, STORE_MAX_BYTES, 0o600)
    loaded.exists = true
  }
}

function emptyStore(): KnownHostsStore {
  return { schema: STORE_SCHEMA, version: STORE_VERSION, entries: Object.create(null) as Record<string, string> }
}

function normalizeHost(value: string): string {
  if (typeof value !== 'string' || value !== value.trim() || value.length < 1 || value.length > 253) {
    throw new Error('invalid_host')
  }
  if (/\s|[\\/@?#]|[\u0000-\u001f\u007f]/u.test(value)) throw new Error('invalid_host')
  const normalized = value.toLowerCase()
  if (RESERVED_NAMES.has(normalized)) throw new Error('invalid_host')
  if (normalized.includes(':')) {
    if (!/^[0-9a-f:]+$/u.test(normalized) || !normalized.includes('::') && normalized.split(':').length !== 8) {
      throw new Error('invalid_host')
    }
  } else if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(normalized)) {
    throw new Error('invalid_host')
  }
  return normalized
}

function normalizePort(value: number | string | undefined): number {
  const port = value === undefined ? 22 : typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('invalid_port')
  return port
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function errorKind(error: unknown): string {
  if (error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/u.test(error.message)) return error.message
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/u.test(code) ? code.toLowerCase() : 'storage_error'
}