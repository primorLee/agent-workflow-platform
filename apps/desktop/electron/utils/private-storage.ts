/**
 * Hardened app-owned private storage.
 *
 * Callers pass the authoritative Electron userData root. This module creates
 * one marked 0700 `private` directory beneath it and refuses to adopt an
 * unmarked, redirected, symlinked, or incorrectly owned tree. Files are read
 * through no-follow descriptors with size/identity checks and are replaced by
 * same-directory, fsynced, exclusive temporary files.
 */

import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs'
import { basename, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { assertPathHasNoRedirectComponents } from './canonical-path'

const PRIVATE_ROOT_NAME = 'private'
const ROOT_MARKER_NAME = '.awp-private-root.json'
const ROOT_MARKER_SCHEMA = 'awp-private-storage-root'
const ROOT_MARKER_MAX_BYTES = 1_024
const PRIVATE_BASENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const PRIVATE_SUBDIR_RE = /^[a-z][a-z0-9-]{0,31}$/u
const NOFOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0

const ROOT_MARKER = Object.freeze({ schema: ROOT_MARKER_SCHEMA, version: 1 })

export type PrivateFileMode = 0o600 | 0o644

export interface PrivateFileRead {
  buffer: Buffer
  path: string
  stat: Stats
}

export function getPrivateStorageRoot(appDataRoot: string): string {
  return join(validateAppDataRoot(appDataRoot, false), PRIVATE_ROOT_NAME)
}

export function getPrivateStoragePath(appDataRoot: string, subdir: string, filename: string): string {
  validateSubdir(subdir)
  validateFilename(filename)
  const appRoot = validateAppDataRoot(appDataRoot, false)
  const root = join(appRoot, PRIVATE_ROOT_NAME)
  const dir = join(root, subdir)
  const target = join(dir, filename)
  assertContained(appRoot, root)
  assertContained(root, dir)
  assertContained(dir, target)
  return target
}

/** Create or validate the marked private root and one fixed-name subdirectory. */
export function ensurePrivateStorageSubdir(appDataRoot: string, subdir: string): string {
  validateSubdir(subdir)
  const appRoot = validateAppDataRoot(appDataRoot, true)
  const root = join(appRoot, PRIVATE_ROOT_NAME)
  assertContained(appRoot, root)

  let rootCreated = false
  try {
    assertPrivateDirectory(lstatSync(root), 'private_storage_root')
  } catch (error) {
    if (!isMissing(error)) throw error
    mkdirSync(root, { mode: 0o700 })
    if (process.platform !== 'win32') chmodSync(root, 0o700)
    rootCreated = true
    assertPrivateDirectory(lstatSync(root), 'private_storage_root')
  }
  assertCanonicalPath(root, 'private_storage_root')

  const markerPath = join(root, ROOT_MARKER_NAME)
  if (rootCreated) {
    createExclusiveFileAtPath(
      markerPath,
      Buffer.from(`${JSON.stringify(ROOT_MARKER)}\n`, 'utf8'),
      0o600,
      ROOT_MARKER_MAX_BYTES,
    )
  }
  validateRootMarker(root)

  const dir = join(root, subdir)
  assertContained(root, dir)
  try {
    assertPrivateDirectory(lstatSync(dir), 'private_storage_subdir')
  } catch (error) {
    if (!isMissing(error)) throw error
    mkdirSync(dir, { mode: 0o700 })
    if (process.platform !== 'win32') chmodSync(dir, 0o700)
    assertPrivateDirectory(lstatSync(dir), 'private_storage_subdir')
  }
  assertCanonicalPath(dir, 'private_storage_subdir')
  return dir
}

/** Read a private file without creating directories. Missing is `null`. */
export function readPrivateFileIfExists(
  appDataRoot: string,
  subdir: string,
  filename: string,
  maxBytes: number,
  mode: PrivateFileMode = 0o600,
): PrivateFileRead | null {
  validateSizeCap(maxBytes)
  const dir = locateExistingPrivateSubdir(appDataRoot, subdir)
  if (!dir) return null
  validateFilename(filename)
  const target = join(dir, filename)
  assertContained(dir, target)
  try {
    return readVerifiedFileAtPath(target, maxBytes, mode)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

/** Create a new fixed file. Existing paths are never adopted or replaced. */
export function createExclusivePrivateFile(
  appDataRoot: string,
  subdir: string,
  filename: string,
  contents: Buffer | string,
  maxBytes: number,
  mode: PrivateFileMode = 0o600,
): string {
  validateSizeCap(maxBytes)
  validateFilename(filename)
  const dir = ensurePrivateStorageSubdir(appDataRoot, subdir)
  const target = join(dir, filename)
  assertContained(dir, target)
  createExclusiveFileAtPath(target, toBuffer(contents), mode, maxBytes)
  syncDirectoryBestEffort(dir)
  return target
}

/** Replace a verified file using an exclusive, fsynced same-directory temp. */
export function atomicWritePrivateFile(
  appDataRoot: string,
  subdir: string,
  filename: string,
  contents: Buffer | string,
  maxBytes: number,
  mode: PrivateFileMode = 0o600,
): string {
  validateSizeCap(maxBytes)
  validateFilename(filename)
  const bytes = toBuffer(contents)
  if (bytes.length > maxBytes) throw new Error('private_file_too_large')
  const dir = ensurePrivateStorageSubdir(appDataRoot, subdir)
  const target = join(dir, filename)
  assertContained(dir, target)

  const previous = readExistingIdentity(target, maxBytes, mode)
  const temp = join(dir, `.${filename}.${randomBytes(16).toString('hex')}.tmp`)
  assertContained(dir, temp)
  let tempIdentity: Stats | null = null
  try {
    createExclusiveFileAtPath(temp, bytes, mode, maxBytes)
    tempIdentity = lstatSync(temp)

    const current = readExistingIdentity(target, maxBytes, mode)
    if (previous === null) {
      if (current !== null) throw new Error('private_file_created_during_replace')
    } else if (current === null || !sameFileIdentity(previous, current)) {
      throw new Error('private_file_replaced_during_write')
    }

    renameWithBoundedRetry(temp, target)
    tempIdentity = null
    const committed = readVerifiedFileAtPath(target, maxBytes, mode)
    if (!committed.buffer.equals(bytes)) throw new Error('private_file_commit_mismatch')
    syncDirectoryBestEffort(dir)
    return target
  } finally {
    if (tempIdentity !== null) removeOwnedTemp(temp, tempIdentity)
  }
}

/** Remove only a verified private file. Missing is an idempotent false. */
export function removePrivateFile(
  appDataRoot: string,
  subdir: string,
  filename: string,
  maxBytes: number,
  mode: PrivateFileMode = 0o600,
): boolean {
  const found = readPrivateFileIfExists(appDataRoot, subdir, filename, maxBytes, mode)
  if (!found) return false
  const finalStat = lstatSync(found.path)
  assertPrivateFile(finalStat, 'private_file', mode)
  if (!sameFileIdentity(found.stat, finalStat)) throw new Error('private_file_replaced_before_remove')
  unlinkSync(found.path)
  syncDirectoryBestEffort(resolve(found.path, '..'))
  return true
}

function locateExistingPrivateSubdir(appDataRoot: string, subdir: string): string | null {
  validateSubdir(subdir)
  const appRoot = validateAppDataRoot(appDataRoot, false)
  const root = join(appRoot, PRIVATE_ROOT_NAME)
  assertContained(appRoot, root)
  try {
    assertPrivateDirectory(lstatSync(root), 'private_storage_root')
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  assertCanonicalPath(root, 'private_storage_root')
  validateRootMarker(root)

  const dir = join(root, subdir)
  assertContained(root, dir)
  try {
    assertPrivateDirectory(lstatSync(dir), 'private_storage_subdir')
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  assertCanonicalPath(dir, 'private_storage_subdir')
  return dir
}

function validateRootMarker(root: string): void {
  const marker = join(root, ROOT_MARKER_NAME)
  assertContained(root, marker)
  const { buffer } = readVerifiedFileAtPath(marker, ROOT_MARKER_MAX_BYTES, 0o600)
  let parsed: unknown
  try {
    parsed = JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new Error('private_storage_marker_invalid')
  }
  if (!isPlainRecord(parsed)) throw new Error('private_storage_marker_invalid')
  const keys = Object.keys(parsed).sort()
  if (
    keys.length !== 2
    || keys[0] !== 'schema'
    || keys[1] !== 'version'
    || parsed.schema !== ROOT_MARKER_SCHEMA
    || parsed.version !== 1
  ) {
    throw new Error('private_storage_marker_invalid')
  }
}

function validateAppDataRoot(appDataRoot: string, create: boolean): string {
  if (typeof appDataRoot !== 'string' || !appDataRoot.trim() || !isAbsolute(appDataRoot)) {
    throw new Error('private_app_data_root_must_be_absolute')
  }
  const root = resolve(appDataRoot)
  if (samePath(root, parse(root).root)) throw new Error('private_app_data_root_too_broad')
  if (create && !existsSync(root)) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') chmodSync(root, 0o700)
  }
  if (!existsSync(root)) return root
  const stat = lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('private_app_data_root_unsafe_type')
  assertCurrentOwner(stat, 'private_app_data_root')
  assertCanonicalPath(root, 'private_app_data_root')
  return root
}

function readExistingIdentity(target: string, maxBytes: number, mode: PrivateFileMode): Stats | null {
  try {
    return readVerifiedFileAtPath(target, maxBytes, mode).stat
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

function createExclusiveFileAtPath(
  target: string,
  bytes: Buffer,
  mode: PrivateFileMode,
  maxBytes: number,
): void {
  if (bytes.length > maxBytes) throw new Error('private_file_too_large')
  let fd: number | null = null
  try {
    fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, mode)
    if (process.platform !== 'win32') fchmodSync(fd, mode)
    assertPrivateFile(fstatSync(fd), 'private_file', mode)
    writeAll(fd, bytes)
    fsyncSync(fd)
    assertPrivateFile(fstatSync(fd), 'private_file', mode)
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function readVerifiedFileAtPath(
  target: string,
  maxBytes: number,
  mode: PrivateFileMode,
): PrivateFileRead {
  const beforePath = lstatSync(target)
  assertPrivateFile(beforePath, 'private_file', mode)
  assertCanonicalPath(target, 'private_file')
  let fd: number | null = null
  try {
    fd = openSync(target, constants.O_RDONLY | NOFOLLOW)
    const before = fstatSync(fd)
    assertPrivateFile(before, 'private_file', mode)
    if (!sameFileIdentity(beforePath, before)) throw new Error('private_file_changed_before_read')
    if (before.size < 0 || before.size > maxBytes) throw new Error('private_file_too_large')
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null)
      if (count <= 0) break
      offset += count
    }
    if (offset !== bytes.length) throw new Error('private_file_short_read')
    const after = fstatSync(fd)
    assertPrivateFile(after, 'private_file', mode)
    if (!sameFileIdentity(before, after)) throw new Error('private_file_changed_during_read')
    const finalPath = lstatSync(target)
    assertPrivateFile(finalPath, 'private_file', mode)
    if (!sameFileIdentity(after, finalPath)) throw new Error('private_file_replaced_after_read')
    return { buffer: bytes, path: target, stat: finalPath }
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset, null)
    if (count <= 0) throw new Error('private_file_short_write')
    offset += count
  }
}

function renameWithBoundedRetry(source: string, target: string): void {
  const delays = [0, 10, 25, 50]
  let lastError: unknown
  for (const delay of delays) {
    if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay)
    try {
      renameSync(source, target)
      return
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error
    }
  }
  throw lastError
}

function removeOwnedTemp(target: string, identity: Stats): void {
  try {
    const current = lstatSync(target)
    if (!sameFileIdentity(identity, current)) return
    if (!current.isFile() || current.isSymbolicLink()) return
    unlinkSync(target)
  } catch {
    // Best-effort cleanup of this call's exclusive unpredictable temp only.
  }
}

function syncDirectoryBestEffort(dir: string): void {
  let fd: number | null = null
  try {
    fd = openSync(dir, constants.O_RDONLY)
    fsyncSync(fd)
  } catch {
    // Windows and some network filesystems do not support directory fsync.
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function assertPrivateDirectory(stat: Stats, label: string): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label}_unsafe_type`)
  assertCurrentOwner(stat, label)
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700) {
    throw new Error(`${label}_unsafe_permissions`)
  }
}

function assertPrivateFile(stat: Stats, label: string, mode: PrivateFileMode): void {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}_unsafe_type`)
  assertCurrentOwner(stat, label)
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== mode) {
    throw new Error(`${label}_unsafe_permissions`)
  }
}

function assertCurrentOwner(stat: Stats, label: string): void {
  if (typeof process.getuid !== 'function') return
  if (stat.uid !== process.getuid()) throw new Error(`${label}_wrong_owner`)
}

function assertCanonicalPath(target: string, label: string): void {
  assertPathHasNoRedirectComponents(target, `${label}_redirected`)
}

function assertContained(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('private_storage_path_escape')
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const stripped = value.replace(/^\\\\\?\\/u, '')
    return process.platform === 'win32' ? stripped.toLowerCase() : stripped
  }
  return normalize(resolve(left)) === normalize(resolve(right))
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  if (left.dev !== right.dev || left.ino !== right.ino) return false
  if (left.ino !== 0 || right.ino !== 0) return true
  return left.size === right.size && left.birthtimeMs === right.birthtimeMs && left.mtimeMs === right.mtimeMs
}

function validateSubdir(value: string): void {
  if (!PRIVATE_SUBDIR_RE.test(value)) throw new Error('private_storage_subdir_invalid')
}

function validateFilename(value: string): void {
  if (!PRIVATE_BASENAME_RE.test(value) || basename(value) !== value || value.includes('..')) {
    throw new Error('private_storage_filename_invalid')
  }
}

function validateSizeCap(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 16 * 1024 * 1024) {
    throw new Error('private_storage_size_cap_invalid')
  }
}

function toBuffer(value: Buffer | string): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
