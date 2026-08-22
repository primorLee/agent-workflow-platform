/** Strict, main-process-only access to two legacy plaintext auth files. */

import { randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs'
import { basename, isAbsolute, join, parse, relative, resolve } from 'node:path'

const ALLOWED_FILES = new Set(['api_token', 'auth.json'])
const NOFOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0

export interface LegacyAuthFile {
  path: string
  buffer: Buffer
  stat: Stats
}

export function readLegacyAuthFile(
  appDataRoot: string,
  filename: 'api_token' | 'auth.json',
  maxBytes = 64 * 1024,
): LegacyAuthFile | null {
  const root = validateRoot(appDataRoot)
  validateFilename(filename)
  const target = join(root, filename)
  assertContained(root, target)
  try {
    return readVerified(target, maxBytes)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null
    throw error
  }
}

export function removeLegacyAuthFile(record: LegacyAuthFile): void {
  const current = lstatSync(record.path)
  assertPrivateRegularFile(current)
  if (!sameIdentity(record.stat, current)) throw new Error('legacy_auth_file_replaced')
  unlinkSync(record.path)
}

export function replaceLegacyAuthFile(record: LegacyAuthFile, contents: string): void {
  const bytes = Buffer.from(contents, 'utf8')
  if (bytes.length > 64 * 1024) throw new Error('legacy_auth_replacement_too_large')
  const dir = resolve(record.path, '..')
  const temp = join(dir, `.auth-migration-${randomBytes(16).toString('hex')}.tmp`)
  assertContained(dir, temp)
  let tempStat: Stats | null = null
  try {
    createExclusive(temp, bytes)
    tempStat = lstatSync(temp)
    const current = lstatSync(record.path)
    assertPrivateRegularFile(current)
    if (!sameIdentity(record.stat, current)) throw new Error('legacy_auth_file_replaced')
    renameWithRetry(temp, record.path)
    tempStat = null
    readVerified(record.path, 64 * 1024)
  } finally {
    if (tempStat !== null) {
      try {
        const current = lstatSync(temp)
        if (sameIdentity(tempStat, current) && current.isFile() && !current.isSymbolicLink()) {
          unlinkSync(temp)
        }
      } catch {
        // Remove only this call's exclusive temporary file, best effort.
      }
    }
  }
}

function readVerified(target: string, maxBytes: number): LegacyAuthFile {
  const pathStat = lstatSync(target)
  assertPrivateRegularFile(pathStat)
  if (!samePath(realpathSync.native(target), resolve(target))) throw new Error('legacy_auth_file_redirected')
  let fd: number | null = null
  try {
    fd = openSync(target, constants.O_RDONLY | NOFOLLOW)
    const before = fstatSync(fd)
    assertPrivateRegularFile(before)
    if (!sameIdentity(pathStat, before)) throw new Error('legacy_auth_file_changed')
    if (before.size < 0 || before.size > maxBytes) throw new Error('legacy_auth_file_too_large')
    const buffer = Buffer.alloc(before.size)
    let offset = 0
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null)
      if (count <= 0) break
      offset += count
    }
    if (offset !== buffer.length) throw new Error('legacy_auth_file_short_read')
    const after = fstatSync(fd)
    if (!sameIdentity(before, after)) throw new Error('legacy_auth_file_changed')
    return { path: target, buffer, stat: after }
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function createExclusive(target: string, bytes: Buffer): void {
  let fd: number | null = null
  try {
    fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600)
    if (process.platform !== 'win32') fchmodSync(fd, 0o600)
    assertPrivateRegularFile(fstatSync(fd))
    let offset = 0
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset, null)
      if (count <= 0) throw new Error('legacy_auth_file_short_write')
      offset += count
    }
    fsyncSync(fd)
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function validateRoot(value: string): string {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value)) {
    throw new Error('legacy_auth_root_invalid')
  }
  const root = resolve(value)
  if (samePath(root, parse(root).root)) throw new Error('legacy_auth_root_too_broad')
  const stat = lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('legacy_auth_root_unsafe')
  assertOwner(stat)
  if (!samePath(realpathSync.native(root), root)) throw new Error('legacy_auth_root_redirected')
  return root
}

function validateFilename(value: string): void {
  if (!ALLOWED_FILES.has(value) || basename(value) !== value) throw new Error('legacy_auth_filename_invalid')
}

function assertPrivateRegularFile(stat: Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('legacy_auth_file_unsafe')
  assertOwner(stat)
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) {
    throw new Error('legacy_auth_file_permissions')
  }
}

function assertOwner(stat: Stats): void {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('legacy_auth_wrong_owner')
  }
}

function assertContained(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('legacy_auth_path_escape')
}

function renameWithRetry(source: string, target: string): void {
  const delays = [0, 10, 25, 50]
  let last: unknown
  for (const delay of delays) {
    if (delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay)
    try {
      renameSync(source, target)
      return
    } catch (error) {
      last = error
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error
    }
  }
  throw last
}

function sameIdentity(left: Stats, right: Stats): boolean {
  if (left.dev !== right.dev || left.ino !== right.ino) return false
  if (left.ino !== 0 || right.ino !== 0) return true
  return left.size === right.size && left.birthtimeMs === right.birthtimeMs && left.mtimeMs === right.mtimeMs
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const stripped = value.replace(/^\\\\\?\\/u, '')
    return process.platform === 'win32' ? stripped.toLowerCase() : stripped
  }
  return normalize(resolve(left)) === normalize(resolve(right))
}
