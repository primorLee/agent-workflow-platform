/**
 * Private discovery lock for the localhost awp-ide MCP endpoint.
 *
 * Electron startup passes its authoritative userData directory explicitly.
 * Ambient directory overrides are intentionally unsupported because a
 * bearer token must never be written to an ambient, caller-selected path.
 *
 * This module never scans or removes another process's locks. A lock is
 * removed only when this module instance created it and its root marker,
 * path, ownership, permissions, identity, and exact payload still match.
 */

import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { assertPathHasNoRedirectComponents } from '../../utils/canonical-path'

const ROOT_DIR_NAME = 'ide'
const ROOT_MARKER_NAME = '.awp-ide-root.json'
const ROOT_MARKER_SCHEMA = 'awp-ide-lock-root'
const LOCK_SCHEMA = 'awp-ide-lock'
const ROOT_MARKER_MAX_BYTES = 1_024
const LOCK_FILE_MAX_BYTES = 16 * 1_024
const LOCK_ID_PATTERN = /^[a-f0-9]{32}$/
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const LOCK_BASENAME_PATTERN = /^lock-([1-9][0-9]*)-([a-f0-9]{32})\.json$/
const NOFOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0

const ROOT_MARKER = Object.freeze({
  schema: ROOT_MARKER_SCHEMA,
  version: 1,
})

export interface IdeLockPayload {
  schema: typeof LOCK_SCHEMA
  version: 1
  lock_id: string
  pid: number
  host: string
  port: number
  token: string
  url: string
  started_at: string
  desktop_version: string
}

export type IdeLockInput = Omit<IdeLockPayload, 'schema' | 'version' | 'lock_id'>

interface OwnedLockRecord {
  appDataRoot: string
  path: string
  serialized: string
}

const ownedLocks = new Map<string, OwnedLockRecord>()

/** Standalone fallback. Electron production passes app.getPath('userData'). */
export function defaultAppDataRoot(): string {
  const channel = (process.env.AWP_CHANNEL ?? '').trim().toLowerCase()
  if (process.env.NODE_ENV === 'development') return join(homedir(), '.awp-dev')
  if (channel === 'insiders') return join(homedir(), '.awp-insiders')
  return join(homedir(), '.awp')
}

export function ideDir(appDataRoot = defaultAppDataRoot()): string {
  return join(validateAppDataRoot(appDataRoot), ROOT_DIR_NAME)
}

/**
 * Create or validate the dedicated 0700 lock root and fixed-schema marker.
 * Existing unmarked or unsafe directories are never adopted or repaired.
 */
export function ensureIdeDir(appDataRoot = defaultAppDataRoot()): string {
  const canonicalAppRoot = validateAppDataRoot(appDataRoot)
  const dir = join(canonicalAppRoot, ROOT_DIR_NAME)
  assertContained(canonicalAppRoot, dir)

  let created = false
  try {
    assertSafeDirectory(lstatSync(dir), 'ide_lock_root')
  } catch (error) {
    if (!isMissing(error)) throw error
    mkdirSync(dir, { mode: 0o700 })
    if (process.platform !== 'win32') chmodSync(dir, 0o700)
    created = true
    assertSafeDirectory(lstatSync(dir), 'ide_lock_root')
  }

  assertCanonicalPath(dir, 'ide_lock_root')
  const markerPath = join(dir, ROOT_MARKER_NAME)
  if (created) {
    createExclusivePrivateFile(markerPath, JSON.stringify(ROOT_MARKER) + '\n')
  }
  validateRootMarker(dir)
  return dir
}

/** Crypto-strong 32-byte token, base64url encoded for an HTTP header. */
export function mintAuthToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Create one unpredictable exclusive lock and remember it as owned by this
 * process/module instance. No existing path is overwritten.
 */
export function writeLockFile(
  input: IdeLockInput,
  appDataRoot = defaultAppDataRoot(),
): string {
  validateLockInput(input)
  const root = ensureIdeDir(appDataRoot)

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const lockId = randomBytes(16).toString('hex')
    const payload: IdeLockPayload = {
      schema: LOCK_SCHEMA,
      version: 1,
      lock_id: lockId,
      ...input,
    }
    const path = join(root, `lock-${input.pid}-${lockId}.json`)
    assertOwnedLockPath(root, path, input.pid, lockId)
    const serialized = JSON.stringify(payload, null, 2) + '\n'
    try {
      createExclusivePrivateFile(path, serialized)
    } catch (error) {
      if (isAlreadyExists(error)) continue
      throw error
    }
    ownedLocks.set(pathKey(path), {
      appDataRoot: validateAppDataRoot(appDataRoot),
      path,
      serialized,
    })
    return path
  }
  throw new Error('ide_lock_random_name_collision')
}

/**
 * Delete only a lock recorded as ours, after revalidating every invariant.
 * Unknown, stale, corrupt, replaced, or symlinked paths remain untouched.
 */
export function deleteLockFile(lockPath: string): boolean {
  if (typeof lockPath !== 'string' || !isAbsolute(lockPath)) return false
  const key = pathKey(lockPath)
  const record = ownedLocks.get(key)
  if (!record || !samePath(record.path, lockPath)) return false

  const root = validateExistingIdeDir(record.appDataRoot)
  const match = LOCK_BASENAME_PATTERN.exec(basename(record.path))
  if (!match || Number(match[1]) !== process.pid) return false
  assertOwnedLockPath(root, record.path, process.pid, match[2])

  let pathStat: Stats
  try {
    pathStat = lstatSync(record.path)
  } catch (error) {
    if (isMissing(error)) {
      ownedLocks.delete(key)
      return false
    }
    throw error
  }
  assertSafePrivateFile(pathStat, 'ide_lock_file')

  const { text, stat: openStat } = readPrivateFile(record.path, LOCK_FILE_MAX_BYTES)
  if (!sameFileIdentity(pathStat, openStat) || text !== record.serialized) return false
  const parsed = parseLockPayload(text)
  if (!parsed || parsed.pid !== process.pid || parsed.lock_id !== match[2]) return false

  // Node has no portable unlinkat(fd). The 0700 parent and immediate identity
  // recheck are the strongest portable guard; hostile same-user processes are
  // outside this discovery lock's security boundary.
  const finalStat = lstatSync(record.path)
  assertSafePrivateFile(finalStat, 'ide_lock_file')
  if (!sameFileIdentity(openStat, finalStat)) return false
  unlinkSync(record.path)
  ownedLocks.delete(key)
  return true
}

function validateAppDataRoot(appDataRoot: string): string {
  if (typeof appDataRoot !== 'string' || !appDataRoot.trim() || !isAbsolute(appDataRoot)) {
    throw new Error('ide_app_data_root_must_be_absolute')
  }
  const root = resolve(appDataRoot)
  const stat = lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('ide_app_data_root_not_directory')
  }
  assertCurrentOwner(stat, 'ide_app_data_root')
  assertCanonicalPath(root, 'ide_app_data_root')
  return root
}

function validateExistingIdeDir(appDataRoot: string): string {
  const appRoot = validateAppDataRoot(appDataRoot)
  const root = join(appRoot, ROOT_DIR_NAME)
  assertContained(appRoot, root)
  assertSafeDirectory(lstatSync(root), 'ide_lock_root')
  assertCanonicalPath(root, 'ide_lock_root')
  validateRootMarker(root)
  return root
}

function validateRootMarker(root: string): void {
  const markerPath = join(root, ROOT_MARKER_NAME)
  assertContained(root, markerPath)
  const { text } = readPrivateFile(markerPath, ROOT_MARKER_MAX_BYTES)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('ide_lock_root_marker_invalid')
  }
  if (!isPlainRecord(parsed)) throw new Error('ide_lock_root_marker_invalid')
  const keys = Object.keys(parsed).sort()
  if (
    keys.length !== 2
    || keys[0] !== 'schema'
    || keys[1] !== 'version'
    || parsed.schema !== ROOT_MARKER_SCHEMA
    || parsed.version !== 1
  ) {
    throw new Error('ide_lock_root_marker_invalid')
  }
}

function validateLockInput(input: IdeLockInput): void {
  if (!Number.isSafeInteger(input.pid) || input.pid !== process.pid) {
    throw new Error('ide_lock_pid_must_match_process')
  }
  if (!isSemanticLoopback(input.host)) throw new Error('ide_lock_host_not_loopback')
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new Error('ide_lock_port_invalid')
  }
  if (!TOKEN_PATTERN.test(input.token)) throw new Error('ide_lock_token_invalid')
  if (typeof input.started_at !== 'string' || !Number.isFinite(Date.parse(input.started_at))) {
    throw new Error('ide_lock_started_at_invalid')
  }
  if (
    typeof input.desktop_version !== 'string'
    || input.desktop_version.length < 1
    || input.desktop_version.length > 128
  ) {
    throw new Error('ide_lock_desktop_version_invalid')
  }

  let parsed: URL
  try {
    parsed = new URL(input.url)
  } catch {
    throw new Error('ide_lock_url_invalid')
  }
  if (
    parsed.protocol !== 'http:'
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.pathname !== '/mcp'
    || parsed.port !== String(input.port)
    || !isSemanticLoopback(parsed.hostname)
    || normalizeHost(parsed.hostname) !== normalizeHost(input.host)
  ) {
    throw new Error('ide_lock_url_invalid')
  }
}

function parseLockPayload(text: string): IdeLockPayload | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isPlainRecord(value)) return null
  const keys = Object.keys(value).sort()
  const expected = [
    'desktop_version',
    'host',
    'lock_id',
    'pid',
    'port',
    'schema',
    'started_at',
    'token',
    'url',
    'version',
  ]
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return null
  if (value.schema !== LOCK_SCHEMA || value.version !== 1) return null
  if (typeof value.lock_id !== 'string' || !LOCK_ID_PATTERN.test(value.lock_id)) return null
  try {
    validateLockInput(value as unknown as IdeLockInput)
  } catch {
    return null
  }
  return value as unknown as IdeLockPayload
}

function createExclusivePrivateFile(path: string, contents: string): void {
  if (Buffer.byteLength(contents, 'utf8') > LOCK_FILE_MAX_BYTES) {
    throw new Error('ide_private_file_too_large')
  }
  let fd: number | null = null
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    )
    if (process.platform !== 'win32') fchmodSync(fd, 0o600)
    assertSafePrivateFile(fstatSync(fd), 'ide_private_file')
    const bytes = Buffer.from(contents, 'utf8')
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, null)
      if (written <= 0) throw new Error('ide_private_file_short_write')
      offset += written
    }
    fsyncSync(fd)
    assertSafePrivateFile(fstatSync(fd), 'ide_private_file')
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function readPrivateFile(path: string, maxBytes: number): { text: string; stat: Stats } {
  let fd: number | null = null
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW)
    const before = fstatSync(fd)
    assertSafePrivateFile(before, 'ide_private_file')
    if (before.size < 0 || before.size > maxBytes) throw new Error('ide_private_file_too_large')
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null)
      if (count <= 0) break
      offset += count
    }
    if (offset !== bytes.length) throw new Error('ide_private_file_short_read')
    const after = fstatSync(fd)
    assertSafePrivateFile(after, 'ide_private_file')
    if (!sameFileIdentity(before, after)) throw new Error('ide_private_file_changed')
    return { text: bytes.toString('utf8'), stat: after }
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function assertSafeDirectory(stat: Stats, label: string): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label}_unsafe_type`)
  assertCurrentOwner(stat, label)
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700) {
    throw new Error(`${label}_unsafe_permissions`)
  }
}

function assertSafePrivateFile(stat: Stats, label: string): void {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}_unsafe_type`)
  assertCurrentOwner(stat, label)
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) {
    throw new Error(`${label}_unsafe_permissions`)
  }
}

function assertCurrentOwner(stat: Stats, label: string): void {
  if (typeof process.getuid !== 'function') return
  if (stat.uid !== process.getuid()) throw new Error(`${label}_wrong_owner`)
}

function assertCanonicalPath(path: string, label: string): void {
  assertPathHasNoRedirectComponents(path, `${label}_symlinked`)
}

function assertContained(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('ide_lock_path_escape')
}

function assertOwnedLockPath(root: string, path: string, pid: number, lockId: string): void {
  assertContained(root, path)
  if (!LOCK_ID_PATTERN.test(lockId) || basename(path) !== `lock-${pid}-${lockId}.json`) {
    throw new Error('ide_lock_path_invalid')
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
}

function isSemanticLoopback(host: string): boolean {
  const value = normalizeHost(host)
  if (value === '::1') return true
  const match = /^127\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/.exec(value)
  return Boolean(match && match.slice(1).every((part) => Number(part) <= 255))
}

function normalizeHost(host: string): string {
  const value = host.trim().toLowerCase()
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function pathKey(path: string): string {
  const value = resolve(path)
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'EEXIST'
}
