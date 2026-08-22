/**
 * Provider-neutral Agent CLI runtime adapter.
 *
 * The public build never contacts a runtime service by default. Users can
 * either point AWP_AGENT_CLI_EXECUTABLE at an existing local CLI, or explicitly
 * configure a signed runtime feed with:
 *
 *   AWP_AGENT_RUNTIME_MANIFEST_URL=https://...
 *   AWP_AGENT_RUNTIME_PUBLIC_KEY=<base64 Ed25519 SPKI public key>
 *
 * The feed returns an envelope whose `signed` field is the base64 encoding of
 * the exact manifest bytes and whose `signature` field is a detached Ed25519
 * signature over those bytes. The signed manifest pins the artifact URL and
 * SHA-256. Artifacts are raw executables only: this adapter deliberately does
 * not extract archives, follow links, run installers, patch resources, or
 * rename an upstream product.
 */

import path from 'node:path'
import {
  chmodSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import {
  createHash,
  createPublicKey,
  randomUUID,
  verify as verifySignature,
} from 'node:crypto'
import { once } from 'node:events'
import { getAwpDir } from '../utils/config'
import { log } from '../utils/logger'

export type Channel = 'stable' | 'insiders' | 'dev'

export interface RuntimeArtifact {
  kind: 'executable'
  url: string
  sha256: string
  bytes?: number
}

export interface LatestVersionResponse {
  version: string
  channel: Channel
  min_desktop_version?: string
  artifacts: Record<string, RuntimeArtifact>
}

export interface UpdateResult {
  updated: boolean
  from?: string
  to?: string
  error?: string
}

export interface EnsureResult {
  installed: boolean
  version: string | null
  error?: string
}

export interface StatusSnapshot {
  currentVersion: string | null
  lastCheckMs: number
  lastUpdateMs: number
  updating: boolean
  available?: boolean
  source?: 'external' | 'managed' | 'disabled'
}

interface VersionMeta {
  current_version: string | null
  current_dir: string | null
  last_check_ms: number
  last_update_ms: number
}

interface SignedEnvelope {
  signed: string
  signature: string
}

export type RuntimeProgressStage =
  | 'idle'
  | 'downloading'
  | 'verifying'
  | 'staging'
  | 'done'
  | 'error'

export interface RuntimeProgress {
  stage: RuntimeProgressStage
  bytesDownloaded: number
  bytesTotal: number
  version: string | null
  error?: string
}

const VERSION_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z](?:[0-9A-Za-z.-]{0,62}[0-9A-Za-z])?)?$/
const HASH_RE = /^[a-f0-9]{64}$/i
const ARTIFACT_DIR_RE = /^[0-9A-Za-z.-]{1,80}--[a-f0-9]{12}$/
const PARTIAL_DIR_RE = /^\.[0-9A-Za-z.-]{1,80}--[a-f0-9]{12}\.partial-[a-f0-9-]{36}$/i
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const MAX_MANIFEST_BYTES = 256 * 1024
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024
const STAGED_RENAME_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800, 1_600] as const

let _updating = false
let _progress: RuntimeProgress = {
  stage: 'idle',
  bytesDownloaded: 0,
  bytesTotal: 0,
  version: null,
}
let _progressBroadcast: ((progress: RuntimeProgress) => void) | null = null
type StagedRenameOperation = (source: string, target: string) => void
let _stagedRenameOperation: StagedRenameOperation = renameSync
interface VerifiedManagedRuntime {
  configId: string
  path: string
  version: string
}
let _verifiedManagedRuntime: VerifiedManagedRuntime | null = null

export function _isUpdating(): boolean {
  return _updating
}

export function resetUpdaterStateForTests(): void {
  _updating = false
  _stagedRenameOperation = renameSync
  _verifiedManagedRuntime = null
  _progress = {
    stage: 'idle',
    bytesDownloaded: 0,
    bytesTotal: 0,
    version: null,
  }
  _progressBroadcast = null
}

/** @internal Deterministic fault injection for staged-activation tests. */
export function setStagedRenameOperationForTests(
  operation: StagedRenameOperation | null,
): void {
  _stagedRenameOperation = operation ?? renameSync
}

export function setProgressBroadcast(fn: (progress: RuntimeProgress) => void): void {
  _progressBroadcast = fn
}

export function getProgress(): RuntimeProgress {
  return { ..._progress }
}

function setProgress(patch: Partial<RuntimeProgress>): void {
  _progress = { ..._progress, ...patch }
  try {
    _progressBroadcast?.({ ..._progress })
  } catch {
    // A closing renderer must never break an install already in progress.
  }
}

export function getRuntimeDir(): string {
  return path.resolve(getAwpDir(), 'agent-runtime')
}

function getVersionsDir(): string {
  return resolveWithin(getRuntimeDir(), 'versions')
}

function getMetaPath(): string {
  return resolveWithin(getRuntimeDir(), 'version.json')
}

function executableBasename(): string {
  return process.platform === 'win32' ? 'runtime.exe' : 'runtime'
}

function platformKey(): string {
  return `${process.platform}-${process.arch}`
}

function resolveWithin(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(resolvedRoot, ...segments)
  const relative = path.relative(resolvedRoot, target)
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('runtime_path_outside_root')
  }
  return target
}

function assertManagedDirectory(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const info = lstatSync(dir)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('runtime_directory_is_link_or_not_directory')
  }
}

function assertContained(root: string, target: string): void {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  const relative = path.relative(resolvedRoot, resolvedTarget)
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('runtime_path_outside_root')
  }
}

function safeRemoveContained(root: string, target: string): void {
  assertContained(root, target)
  if (!existsSync(target)) return
  const info = lstatSync(target)
  if (info.isSymbolicLink()) {
    rmSync(target, { force: true })
    return
  }
  rmSync(target, { recursive: info.isDirectory(), force: true })
}

function isTransientSharingViolation(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}

async function promoteStagedDirectory(
  root: string,
  source: string,
  target: string,
): Promise<void> {
  assertContained(root, source)
  assertContained(root, target)

  for (let attempt = 0; ; attempt += 1) {
    assertManagedDirectory(root)
    const sourceInfo = lstatSync(source)
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
      throw new Error('runtime_staging_link_detected')
    }
    // Never replace an existing version directory, even on platforms whose
    // rename primitive permits replacing an empty destination directory.
    if (existsSync(target)) throw new Error('runtime_immutable_version_conflict')

    try {
      _stagedRenameOperation(source, target)
      return
    } catch (error) {
      if (
        !isTransientSharingViolation(error)
        || attempt >= STAGED_RENAME_RETRY_DELAYS_MS.length
      ) {
        throw error
      }
      await new Promise((resolve) => {
        setTimeout(resolve, STAGED_RENAME_RETRY_DELAYS_MS[attempt])
      })
    }
  }
}

function validateVersion(version: unknown): string {
  if (typeof version !== 'string' || version.length > 80 || !VERSION_RE.test(version)) {
    throw new Error('invalid_runtime_version')
  }
  return version
}

function validateHash(hash: unknown): string {
  if (typeof hash !== 'string' || !HASH_RE.test(hash)) {
    throw new Error('invalid_runtime_sha256')
  }
  return hash.toLowerCase()
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`unexpected_${label}_field`)
  }
  for (const key of required) {
    if (!(key in value)) throw new Error(`missing_${label}_field`)
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid_${label}`)
  }
  return value as Record<string, unknown>
}

function decodeBase64(value: unknown, label: string, maxBytes: number): Buffer {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new Error(`invalid_${label}_base64`)
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length === 0 || decoded.length > maxBytes) {
    throw new Error(`invalid_${label}_size`)
  }
  return decoded
}

function parsePinnedPublicKey() {
  const raw = (process.env.AWP_AGENT_RUNTIME_PUBLIC_KEY ?? '').trim()
  if (!raw) throw new Error('runtime_public_key_unconfigured')
  let key
  try {
    if (raw.includes('BEGIN PUBLIC KEY')) {
      key = createPublicKey(raw)
    } else {
      const der = decodeBase64(raw, 'public_key', 16 * 1024)
      key = createPublicKey({ key: der, format: 'der', type: 'spki' })
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('invalid_')) throw error
    throw new Error('invalid_runtime_public_key')
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('runtime_public_key_must_be_ed25519')
  }
  return key
}

function parseArtifact(value: unknown): RuntimeArtifact {
  const record = asRecord(value, 'artifact')
  exactKeys(record, ['kind', 'url', 'sha256', 'bytes'], ['kind', 'url', 'sha256'], 'artifact')
  if (record.kind !== 'executable') throw new Error('unsupported_artifact_kind')
  if (typeof record.url !== 'string') throw new Error('invalid_artifact_url')
  const sha256 = validateHash(record.sha256)
  let bytes: number | undefined
  if (record.bytes !== undefined) {
    if (
      typeof record.bytes !== 'number'
      || !Number.isSafeInteger(record.bytes)
      || record.bytes <= 0
      || record.bytes > MAX_ARTIFACT_BYTES
    ) {
      throw new Error('invalid_artifact_size')
    }
    bytes = record.bytes
  }
  return { kind: 'executable', url: record.url, sha256, bytes }
}

function parseSignedManifest(bytes: Buffer, channel: Channel): LatestVersionResponse {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf-8'))
  } catch {
    throw new Error('invalid_signed_manifest_json')
  }
  const record = asRecord(parsed, 'signed_manifest')
  exactKeys(
    record,
    ['version', 'channel', 'min_desktop_version', 'artifacts'],
    ['version', 'channel', 'artifacts'],
    'signed_manifest',
  )
  const version = validateVersion(record.version)
  if (record.channel !== channel) throw new Error('runtime_channel_mismatch')
  const minDesktop =
    record.min_desktop_version === undefined
      ? undefined
      : validateVersion(record.min_desktop_version)
  const artifactRecords = asRecord(record.artifacts, 'artifacts')
  const artifacts: Record<string, RuntimeArtifact> = {}
  for (const [key, value] of Object.entries(artifactRecords)) {
    if (!/^(win32|darwin|linux)-(x64|arm64)$/.test(key)) {
      throw new Error('invalid_artifact_platform')
    }
    artifacts[key] = parseArtifact(value)
  }
  if (Object.keys(artifacts).length === 0) throw new Error('missing_runtime_artifacts')
  return {
    version,
    channel,
    min_desktop_version: minDesktop,
    artifacts,
  }
}

function runtimeManifestUrl(): URL {
  const raw = (process.env.AWP_AGENT_RUNTIME_MANIFEST_URL ?? '').trim()
  if (!raw) throw new Error('runtime_manifest_unconfigured')
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('invalid_runtime_manifest_url')
  }
  if (parsed.protocol !== 'https:') throw new Error('runtime_manifest_requires_https')
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error('invalid_runtime_manifest_url')
  }
  return parsed
}

function validateManagedRuntimeConfiguration(): string {
  const manifest = runtimeManifestUrl()
  const channel = resolveChannel()
  parsePinnedPublicKey()
  const pin = (process.env.AWP_AGENT_RUNTIME_PUBLIC_KEY ?? '').trim()
  return createHash('sha256')
    .update(manifest.href)
    .update('\0')
    .update(channel)
    .update('\0')
    .update(pin)
    .digest('hex')
}

function isManagedRuntimeExplicitlyConfigured(): boolean {
  try {
    validateManagedRuntimeConfiguration()
    return true
  } catch {
    return false
  }
}

function validateArtifactUrl(raw: string, manifestUrl: URL): URL {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('invalid_artifact_url')
  }
  if (parsed.protocol !== 'https:') throw new Error('runtime_artifact_requires_https')
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error('invalid_artifact_url')
  }
  if (parsed.origin !== manifestUrl.origin) {
    const optIn = process.env.AWP_AGENT_RUNTIME_CROSS_ORIGIN_OPT_IN === '1'
    const configured = (process.env.AWP_AGENT_RUNTIME_ARTIFACT_ORIGINS ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    const allowed = configured.some((origin) => {
      try {
        return new URL(origin).origin === parsed.origin
      } catch {
        return false
      }
    })
    if (!optIn || !allowed) throw new Error('runtime_artifact_origin_not_allowed')
  }
  return parsed
}

function resolveChannel(): Channel {
  const raw = (process.env.AWP_AGENT_RUNTIME_CHANNEL ?? 'stable').trim().toLowerCase()
  return raw === 'insiders' || raw === 'dev' ? raw : 'stable'
}

function getDesktopVersion(): string {
  try {
    const electron = require('electron') as { app?: { getVersion?: () => string } }
    const version = electron.app?.getVersion?.()
    if (typeof version === 'string' && VERSION_RE.test(version)) return version
  } catch {
    // Unit tests and non-Electron callers use the package version fallback.
  }
  try {
    const pkg = JSON.parse(
      readFileSync(path.resolve(__dirname, '..', '..', '..', 'package.json'), 'utf-8'),
    ) as { version?: unknown }
    return typeof pkg.version === 'string' && VERSION_RE.test(pkg.version)
      ? pkg.version
      : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function semverCore(version: string): [number, number, number] {
  const core = version.split('-', 1)[0].split('.').map(Number)
  return [core[0] ?? 0, core[1] ?? 0, core[2] ?? 0]
}

function versionLessThan(a: string, b: string): boolean {
  const left = semverCore(a)
  const right = semverCore(b)
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i]
  }
  return false
}

function emptyMeta(): VersionMeta {
  return {
    current_version: null,
    current_dir: null,
    last_check_ms: 0,
    last_update_ms: 0,
  }
}

function readMeta(): VersionMeta | null {
  try {
    const file = getMetaPath()
    if (!existsSync(file)) return null
    const parsed = asRecord(JSON.parse(readFileSync(file, 'utf-8')), 'runtime_meta')
    const version =
      parsed.current_version === null ? null : validateVersion(parsed.current_version)
    const dir =
      parsed.current_dir === null
        ? null
        : typeof parsed.current_dir === 'string' && ARTIFACT_DIR_RE.test(parsed.current_dir)
          ? parsed.current_dir
          : (() => { throw new Error('invalid_runtime_meta_dir') })()
    if ((version === null) !== (dir === null)) throw new Error('invalid_runtime_meta_pair')
    return {
      current_version: version,
      current_dir: dir,
      last_check_ms:
        typeof parsed.last_check_ms === 'number' && Number.isFinite(parsed.last_check_ms)
          ? parsed.last_check_ms
          : 0,
      last_update_ms:
        typeof parsed.last_update_ms === 'number' && Number.isFinite(parsed.last_update_ms)
          ? parsed.last_update_ms
          : 0,
    }
  } catch {
    return null
  }
}

function writeMeta(meta: VersionMeta): void {
  const runtimeDir = getRuntimeDir()
  assertManagedDirectory(runtimeDir)
  const target = getMetaPath()
  const temp = resolveWithin(runtimeDir, `.version.${randomUUID()}.tmp`)
  try {
    writeFileSync(temp, JSON.stringify(meta, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
      flag: 'wx',
    })
    renameSync(temp, target)
  } finally {
    try {
      if (existsSync(temp)) safeRemoveContained(runtimeDir, temp)
    } catch {
      // A complete destination may already have been promoted.
    }
  }
}

function configuredExternalExecutable(): string | null {
  const raw = (process.env.AWP_AGENT_CLI_EXECUTABLE ?? '').trim()
  if (!raw) return null
  if (!path.isAbsolute(raw)) return null
  const resolved = path.resolve(raw)
  try {
    const info = lstatSync(resolved)
    return info.isFile() && !info.isSymbolicLink() ? resolved : null
  } catch {
    return null
  }
}

function managedExecutablePath(meta: VersionMeta): string | null {
  if (!meta.current_dir || !meta.current_version) return null
  if (!ARTIFACT_DIR_RE.test(meta.current_dir)) return null
  try {
    const versionsDir = getVersionsDir()
    assertManagedDirectory(versionsDir)
    const versionDir = resolveWithin(versionsDir, meta.current_dir)
    const dirInfo = lstatSync(versionDir)
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) return null
    const executable = resolveWithin(versionDir, executableBasename())
    const fileInfo = lstatSync(executable)
    return fileInfo.isFile() && !fileInfo.isSymbolicLink() ? executable : null
  } catch {
    return null
  }
}

function currentVerifiedManagedRuntime(): VerifiedManagedRuntime | null {
  let configId: string
  try {
    configId = validateManagedRuntimeConfiguration()
  } catch {
    return null
  }
  const verified = _verifiedManagedRuntime
  if (!verified || verified.configId !== configId) return null
  try {
    const info = lstatSync(verified.path)
    return info.isFile() && !info.isSymbolicLink() ? verified : null
  } catch {
    return null
  }
}

async function verifyManagedRuntime(
  meta: VersionMeta,
  manifest: LatestVersionResponse,
  artifact: RuntimeArtifact,
  configId: string,
): Promise<string | null> {
  const expectedDir = `${manifest.version}--${artifact.sha256.slice(0, 12)}`
  if (meta.current_version !== manifest.version || meta.current_dir !== expectedDir) return null
  const executable = managedExecutablePath(meta)
  if (!executable) return null
  if (await sha256OfFile(executable) !== artifact.sha256.toLowerCase()) return null
  _verifiedManagedRuntime = { configId, path: executable, version: manifest.version }
  return executable
}

export function getCliPath(): string | null {
  const external = configuredExternalExecutable()
  if (external) return external
  return currentVerifiedManagedRuntime()?.path ?? null
}

export function getCurrentVersion(): string | null {
  return currentVerifiedManagedRuntime()?.version ?? null
}

async function readResponseBytesLimited(
  response: Response,
  maxBytes: number,
  tooLargeError: string,
  emptyError: string,
): Promise<Buffer> {
  const contentLengthRaw = response.headers.get('content-length')
  if (contentLengthRaw) {
    const contentLength = Number(contentLengthRaw)
    if (
      !Number.isSafeInteger(contentLength)
      || contentLength < 0
      || contentLength > maxBytes
    ) {
      throw new Error(tooLargeError)
    }
  }
  if (!response.body) throw new Error(emptyError)

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value)
    total += chunk.length
    if (total > maxBytes) {
      await reader.cancel(tooLargeError)
      throw new Error(tooLargeError)
    }
    chunks.push(chunk)
  }
  if (total === 0) throw new Error(emptyError)
  return Buffer.concat(chunks, total)
}

export async function fetchLatestVersion(
  channel: Channel = resolveChannel(),
): Promise<LatestVersionResponse> {
  const manifestUrl = runtimeManifestUrl()
  const key = parsePinnedPublicKey()
  const response = await fetch(manifestUrl, {
    method: 'GET',
    redirect: 'error',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`runtime_manifest_http_${response.status}`)
  const text = (
    await readResponseBytesLimited(
      response,
      MAX_MANIFEST_BYTES,
      'runtime_manifest_too_large',
      'runtime_manifest_empty',
    )
  ).toString('utf-8')

  let envelopeValue: unknown
  try {
    envelopeValue = JSON.parse(text)
  } catch {
    throw new Error('invalid_runtime_manifest_envelope')
  }
  const envelopeRecord = asRecord(envelopeValue, 'runtime_manifest_envelope')
  exactKeys(envelopeRecord, ['signed', 'signature'], ['signed', 'signature'], 'envelope')
  const envelope: SignedEnvelope = {
    signed: String(envelopeRecord.signed),
    signature: String(envelopeRecord.signature),
  }
  const signedBytes = decodeBase64(envelope.signed, 'signed_manifest', MAX_MANIFEST_BYTES)
  const signature = decodeBase64(envelope.signature, 'signature', 1024)
  if (!verifySignature(null, signedBytes, key, signature)) {
    throw new Error('runtime_manifest_signature_invalid')
  }

  const manifest = parseSignedManifest(signedBytes, channel)
  const artifact = manifest.artifacts[platformKey()]
  if (!artifact) throw new Error('runtime_artifact_platform_unavailable')
  validateArtifactUrl(artifact.url, manifestUrl)
  return manifest
}

async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  const handle = await import('node:fs/promises').then((module) => module.open(file, 'r'))
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

async function downloadExecutable(
  artifact: RuntimeArtifact,
  manifestUrl: URL,
  destination: string,
  version: string,
): Promise<void> {
  const url = validateArtifactUrl(artifact.url, manifestUrl)
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(5 * 60_000),
  })
  if (!response.ok) throw new Error(`runtime_artifact_http_${response.status}`)
  if (!response.body) throw new Error('runtime_artifact_empty_body')

  const contentLengthRaw = response.headers.get('content-length')
  const contentLength = contentLengthRaw ? Number(contentLengthRaw) : 0
  if (
    contentLengthRaw
    && (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > MAX_ARTIFACT_BYTES)
  ) {
    throw new Error('invalid_runtime_content_length')
  }
  if (artifact.bytes !== undefined && contentLength && artifact.bytes !== contentLength) {
    throw new Error('runtime_content_length_mismatch')
  }

  setProgress({
    stage: 'downloading',
    bytesDownloaded: 0,
    bytesTotal: artifact.bytes ?? contentLength,
    version,
    error: undefined,
  })

  const output = createWriteStream(destination, { flags: 'wx', mode: 0o700 })
  let outputFailure: Error | null = null
  const outputClosed = new Promise<void>((resolve) => {
    output.once('close', resolve)
  })
  // Attach from creation time so an asynchronous open/write failure can never
  // become an unhandled stream error.
  output.on('error', (error) => {
    outputFailure = error
  })

  const hash = createHash('sha256')
  const reader = response.body.getReader()
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (outputFailure) throw outputFailure
      if (done) break
      const chunk = Buffer.from(value)
      total += chunk.length
      if (total > MAX_ARTIFACT_BYTES || (artifact.bytes !== undefined && total > artifact.bytes)) {
        await reader.cancel('runtime_artifact_too_large')
        throw new Error('runtime_artifact_too_large')
      }
      hash.update(chunk)
      if (!output.write(chunk)) await once(output, 'drain')
      if (outputFailure) throw outputFailure
      setProgress({ bytesDownloaded: total })
    }
    output.end()
    // Writable finish can precede the underlying Windows file handle closing.
    // Directory activation must wait for close, otherwise rename can fail EPERM.
    await outputClosed
    if (outputFailure) throw outputFailure
  } catch (error) {
    output.destroy()
    await outputClosed
    throw error
  }

  if (artifact.bytes !== undefined && total !== artifact.bytes) {
    throw new Error('runtime_artifact_size_mismatch')
  }
  if (total === 0) throw new Error('runtime_artifact_empty')
  setProgress({ stage: 'verifying', bytesDownloaded: total })
  const actual = hash.digest('hex')
  if (actual !== artifact.sha256) throw new Error('runtime_artifact_sha256_mismatch')
}

async function installVersion(
  manifest: LatestVersionResponse,
  manifestUrl: URL,
): Promise<void> {
  const version = validateVersion(manifest.version)
  const artifact = manifest.artifacts[platformKey()]
  if (!artifact) throw new Error('runtime_artifact_platform_unavailable')
  const sha = validateHash(artifact.sha256)
  const versionsDir = getVersionsDir()
  assertManagedDirectory(getRuntimeDir())
  assertManagedDirectory(versionsDir)

  const artifactDirName = `${version}--${sha.slice(0, 12)}`
  if (!ARTIFACT_DIR_RE.test(artifactDirName)) throw new Error('invalid_runtime_artifact_dir')
  const finalDir = resolveWithin(versionsDir, artifactDirName)
  const finalExe = resolveWithin(finalDir, executableBasename())

  if (existsSync(finalDir)) {
    const dirInfo = lstatSync(finalDir)
    const fileInfo = existsSync(finalExe) ? lstatSync(finalExe) : null
    if (
      !dirInfo.isDirectory()
      || dirInfo.isSymbolicLink()
      || !fileInfo?.isFile()
      || fileInfo.isSymbolicLink()
      || await sha256OfFile(finalExe) !== sha
    ) {
      throw new Error('runtime_immutable_version_conflict')
    }
  } else {
    const partialName = `.${artifactDirName}.partial-${randomUUID()}`
    const partialDir = resolveWithin(versionsDir, partialName)
    const partialExe = resolveWithin(partialDir, executableBasename())
    mkdirSync(partialDir, { recursive: false })
    try {
      await downloadExecutable(artifact, manifestUrl, partialExe, version)
      const partialInfo = lstatSync(partialDir)
      const executableInfo = lstatSync(partialExe)
      if (
        !partialInfo.isDirectory()
        || partialInfo.isSymbolicLink()
        || !executableInfo.isFile()
        || executableInfo.isSymbolicLink()
      ) {
        throw new Error('runtime_staging_link_detected')
      }
      try {
        chmodSync(partialExe, 0o700)
      } catch {
        // Windows executable ACLs are inherited from the user-data directory.
      }
      setProgress({ stage: 'staging' })
      await promoteStagedDirectory(versionsDir, partialDir, finalDir)
    } finally {
      try {
        if (existsSync(partialDir)) safeRemoveContained(versionsDir, partialDir)
      } catch {
        // Leave a uniquely named, never-active staging dir for later cleanup.
      }
    }
  }

  const previous = readMeta() ?? emptyMeta()
  writeMeta({
    current_version: version,
    current_dir: artifactDirName,
    last_check_ms: Date.now(),
    last_update_ms: Date.now(),
  })
  if (previous.current_dir && previous.current_dir !== artifactDirName) {
    // Retained until pruneOldVersions; an in-flight old process can finish.
  }
}

export async function checkAndUpdate(
  opts: { force?: boolean } = {},
): Promise<UpdateResult> {
  const external = configuredExternalExecutable()
  if (external) return { updated: false }
  if (_updating) return { updated: false, error: 'runtime_update_in_progress' }

  let manifestUrl: URL
  let configId: string
  try {
    manifestUrl = runtimeManifestUrl()
    configId = validateManagedRuntimeConfiguration()
  } catch (error) {
    return { updated: false, error: error instanceof Error ? error.message : String(error) }
  }

  const previous = readMeta() ?? emptyMeta()
  if (
    !opts.force
    && currentVerifiedManagedRuntime()
    && Date.now() - previous.last_check_ms < CHECK_INTERVAL_MS
  ) {
    return { updated: false }
  }

  _updating = true
  try {
    const channel = resolveChannel()
    const manifest = await fetchLatestVersion(channel)

    // A configured managed executable is usable only after this process has
    // verified the current signed manifest and the on-disk artifact hash.
    _verifiedManagedRuntime = null

    if (
      manifest.min_desktop_version
      && versionLessThan(getDesktopVersion(), manifest.min_desktop_version)
    ) {
      writeMeta({ ...previous, last_check_ms: Date.now() })
      return { updated: false, error: 'desktop_too_old' }
    }

    const artifact = manifest.artifacts[platformKey()]
    if (!artifact) return { updated: false, error: 'runtime_artifact_platform_unavailable' }
    const expectedDir = `${manifest.version}--${artifact.sha256.slice(0, 12)}`
    if (
      !opts.force
      && previous.current_version === manifest.version
      && previous.current_dir === expectedDir
      && await verifyManagedRuntime(previous, manifest, artifact, configId)
    ) {
      writeMeta({ ...previous, last_check_ms: Date.now() })
      return { updated: false }
    }

    await installVersion(manifest, manifestUrl)
    const installed = readMeta()
    const verified = installed
      ? await verifyManagedRuntime(installed, manifest, artifact, configId)
      : null
    if (!verified) throw new Error('runtime_post_install_verification_failed')

    pruneOldVersions(2)
    setProgress({
      stage: 'done',
      bytesDownloaded: artifact.bytes ?? _progress.bytesDownloaded,
      bytesTotal: artifact.bytes ?? _progress.bytesTotal,
      version: manifest.version,
      error: undefined,
    })
    return {
      updated: true,
      from: previous.current_version ?? undefined,
      to: manifest.version,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    setProgress({ stage: 'error', error: message })
    log(`[agent-runtime-updater] update failed: ${message}`)
    return { updated: false, error: message }
  } finally {
    _updating = false
  }
}

export async function ensureInstalled(): Promise<EnsureResult> {
  if (configuredExternalExecutable()) {
    return { installed: true, version: null }
  }
  try {
    validateManagedRuntimeConfiguration()
  } catch (error) {
    return {
      installed: false,
      version: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const result = await checkAndUpdate({ force: false })
  const verified = currentVerifiedManagedRuntime()
  return {
    installed: Boolean(verified),
    version: verified?.version ?? null,
    error: verified ? undefined : result.error ?? 'runtime_install_failed',
  }
}

export function recoverFromMissingBinary(): Promise<UpdateResult> {
  if (configuredExternalExecutable()) {
    return Promise.resolve({ updated: false, error: 'external_runtime_unavailable' })
  }
  try {
    validateManagedRuntimeConfiguration()
  } catch (error) {
    return Promise.resolve({
      updated: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  _verifiedManagedRuntime = null
  const previous = readMeta() ?? emptyMeta()
  writeMeta({
    current_version: null,
    current_dir: null,
    last_check_ms: previous.last_check_ms,
    last_update_ms: previous.last_update_ms,
  })
  return checkAndUpdate({ force: true })
}
export function pruneOldVersions(keep = 2): void {
  const versionsDir = getVersionsDir()
  if (!existsSync(versionsDir)) return
  assertManagedDirectory(versionsDir)
  const active = readMeta()?.current_dir ?? null
  const entries = readdirSync(versionsDir, { withFileTypes: true })

  // Staging names are generated by this adapter. They are never executable and
  // never count against the retained immutable-version budget.
  for (const entry of entries.filter((candidate) => PARTIAL_DIR_RE.test(candidate.name))) {
    try {
      safeRemoveContained(versionsDir, resolveWithin(versionsDir, entry.name))
    } catch (error) {
      log(
        `[agent-runtime-updater] staging cleanup skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  const candidates = entries
    .filter((entry) => entry.name !== active && ARTIFACT_DIR_RE.test(entry.name))
    .map((entry) => {
      const target = resolveWithin(versionsDir, entry.name)
      let mtime = 0
      try {
        mtime = statSync(target).mtimeMs
      } catch {
        // Broken links and inaccessible entries sort oldest and are removed safely.
      }
      return { target, mtime }
    })
    .sort((a, b) => b.mtime - a.mtime)

  const retainedInactive = Math.max(0, keep - (active ? 1 : 0))
  for (const candidate of candidates.slice(retainedInactive)) {
    try {
      safeRemoveContained(versionsDir, candidate.target)
    } catch (error) {
      log(
        `[agent-runtime-updater] prune skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
}

export function getStatusSnapshot(): StatusSnapshot {
  const externalRequested = Boolean((process.env.AWP_AGENT_CLI_EXECUTABLE ?? '').trim())
  const externalAvailable = Boolean(configuredExternalExecutable())
  const managedConfigured = isManagedRuntimeExplicitlyConfigured()
  const meta = managedConfigured ? readMeta() ?? emptyMeta() : emptyMeta()
  const verified = managedConfigured ? currentVerifiedManagedRuntime() : null
  return {
    currentVersion: verified?.version ?? null,
    lastCheckMs: managedConfigured ? meta.last_check_ms : 0,
    lastUpdateMs: managedConfigured ? meta.last_update_ms : 0,
    updating: _updating,
    available: externalRequested ? externalAvailable : Boolean(verified),
    source: externalRequested
      ? 'external'
      : managedConfigured
        ? 'managed'
        : 'disabled',
  }
}