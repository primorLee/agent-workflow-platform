import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'

const state = vi.hoisted(() => ({ awpDir: '' }))
vi.mock('../../utils/config', () => ({
  getAwpDir: () => state.awpDir,
}))
vi.mock('../../utils/logger', () => ({ log: vi.fn() }))
vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3' },
}))

import {
  checkAndUpdate,
  ensureInstalled,
  fetchLatestVersion,
  getCliPath,
  getCurrentVersion,
  getRuntimeDir,
  getStatusSnapshot,
  pruneOldVersions,
  recoverFromMissingBinary,
  resetUpdaterStateForTests,
  setStagedRenameOperationForTests,
} from '../cc-runtime-updater'

const ENV_KEYS = [
  'AWP_AGENT_CLI_EXECUTABLE',
  'AWP_AGENT_RUNTIME_MANIFEST_URL',
  'AWP_AGENT_RUNTIME_PUBLIC_KEY',
  'AWP_AGENT_RUNTIME_CHANNEL',
  'AWP_AGENT_RUNTIME_CROSS_ORIGIN_OPT_IN',
  'AWP_AGENT_RUNTIME_ARTIFACT_ORIGINS',
] as const

let temp = ''

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key]
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function signedEnvelope(
  payload: unknown,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
): string {
  const signed = Buffer.from(JSON.stringify(payload), 'utf-8')
  return JSON.stringify({
    signed: signed.toString('base64'),
    signature: sign(null, signed, privateKey).toString('base64'),
  })
}

function configureSigningKey() {
  const pair = generateKeyPairSync('ed25519')
  process.env.AWP_AGENT_RUNTIME_PUBLIC_KEY = (
    pair.publicKey.export({ format: 'der', type: 'spki' }) as Buffer
  ).toString('base64')
  return pair
}

function manifestFor(
  version: string,
  bytes: Buffer,
  url = 'https://updates.example.test/runtime.bin',
): Record<string, unknown> {
  return {
    version,
    channel: 'stable',
    artifacts: {
      [`${process.platform}-${process.arch}`]: {
        kind: 'executable',
        url,
        sha256: sha256(bytes),
        bytes: bytes.length,
      },
    },
  }
}

function stubSignedFeed(
  payload: unknown,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  artifactBytes = Buffer.from('runtime-test-bytes'),
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url === 'https://updates.example.test/manifest.json') {
      return new Response(signedEnvelope(payload, privateKey), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://updates.example.test/runtime.bin') {
      return new Response(artifactBytes as unknown as BodyInit, {
        status: 200,
        headers: { 'content-length': String(artifactBytes.length) },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  temp = mkdtempSync(path.join(tmpdir(), 'awp-runtime-test-'))
  state.awpDir = temp
  clearEnv()
  resetUpdaterStateForTests()
})

afterEach(() => {
  clearEnv()
  vi.unstubAllGlobals()
  resetUpdaterStateForTests()
  rmSync(temp, { recursive: true, force: true })
})

describe('runtime updater safe defaults', () => {
  it('is completely disabled when neither a local executable nor manifest is configured', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    expect(getCliPath()).toBeNull()
    await expect(ensureInstalled()).resolves.toEqual({
      installed: false,
      version: null,
      error: 'runtime_manifest_unconfigured',
    })
    await expect(checkAndUpdate()).resolves.toEqual({
      updated: false,
      error: 'runtime_manifest_unconfigured',
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(getStatusSnapshot()).toMatchObject({
      available: false,
      source: 'disabled',
      updating: false,
    })
  })

  it('ignores legacy managed state until this process verifies its signed manifest and artifact', async () => {
    const runtimeDir = getRuntimeDir()
    const currentDir = `9.9.9--${'a'.repeat(12)}`
    const versionDir = path.join(runtimeDir, 'versions', currentDir)
    const executable = path.join(versionDir, process.platform === 'win32' ? 'runtime.exe' : 'runtime')
    mkdirSync(versionDir, { recursive: true })
    writeFileSync(executable, 'legacy-managed-runtime', 'utf-8')
    const metaPath = path.join(runtimeDir, 'version.json')
    const metadata = JSON.stringify({
      current_version: '9.9.9',
      current_dir: currentDir,
      last_check_ms: 123,
      last_update_ms: 456,
    })
    writeFileSync(metaPath, metadata, 'utf-8')

    expect(getCliPath()).toBeNull()
    expect(getCurrentVersion()).toBeNull()
    expect(getStatusSnapshot()).toMatchObject({
      currentVersion: null,
      lastCheckMs: 0,
      lastUpdateMs: 0,
      available: false,
      source: 'disabled',
    })
    await expect(recoverFromMissingBinary()).resolves.toEqual({
      updated: false,
      error: 'runtime_manifest_unconfigured',
    })
    expect(readFileSync(metaPath, 'utf-8')).toBe(metadata)
    expect(readFileSync(executable, 'utf-8')).toBe('legacy-managed-runtime')

    process.env.AWP_AGENT_RUNTIME_MANIFEST_URL = 'https://updates.example.test/manifest.json'
    expect(getCliPath()).toBeNull()
    expect(getCurrentVersion()).toBeNull()
    expect(getStatusSnapshot()).toMatchObject({ available: false, source: 'disabled' })
    await expect(ensureInstalled()).resolves.toEqual({
      installed: false,
      version: null,
      error: 'runtime_public_key_unconfigured',
    })
    expect(readFileSync(metaPath, 'utf-8')).toBe(metadata)
    expect(readFileSync(executable, 'utf-8')).toBe('legacy-managed-runtime')

    configureSigningKey()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(getCliPath()).toBeNull()
    expect(getCurrentVersion()).toBeNull()
    expect(getStatusSnapshot()).toMatchObject({
      currentVersion: null,
      lastCheckMs: 123,
      lastUpdateMs: 456,
      available: false,
      source: 'managed',
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(readFileSync(metaPath, 'utf-8')).toBe(metadata)
    expect(readFileSync(executable, 'utf-8')).toBe('legacy-managed-runtime')
  })

  it('uses an explicit local executable without contacting a manifest', async () => {
    const executable = path.join(temp, process.platform === 'win32' ? 'agent.exe' : 'agent')
    writeFileSync(executable, 'local-agent', 'utf-8')
    process.env.AWP_AGENT_CLI_EXECUTABLE = executable
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    expect(getCliPath()).toBe(path.resolve(executable))
    await expect(ensureInstalled()).resolves.toEqual({
      installed: true,
      version: null,
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(getStatusSnapshot()).toMatchObject({
      available: true,
      source: 'external',
    })
  })

  it('reports an invalid relative external executable as unavailable', () => {
    process.env.AWP_AGENT_CLI_EXECUTABLE = 'relative-agent'
    expect(getCliPath()).toBeNull()
    expect(getStatusSnapshot()).toMatchObject({
      available: false,
      source: 'external',
    })
  })
})

describe('signed HTTPS runtime feed', () => {
  it('does not expose matching managed metadata until the current signed feed and artifact hash are verified', async () => {
    const bytes = Buffer.from('preexisting-managed-runtime')
    const pair = configureSigningKey()
    process.env.AWP_AGENT_RUNTIME_MANIFEST_URL =
      'https://updates.example.test/manifest.json'
    const currentDir = `1.2.3--${sha256(bytes).slice(0, 12)}`
    const versionDir = path.join(getRuntimeDir(), 'versions', currentDir)
    const executable = path.join(
      versionDir,
      process.platform === 'win32' ? 'runtime.exe' : 'runtime',
    )
    mkdirSync(versionDir, { recursive: true })
    writeFileSync(executable, bytes)
    writeFileSync(
      path.join(getRuntimeDir(), 'version.json'),
      JSON.stringify({
        current_version: '1.2.3',
        current_dir: currentDir,
        last_check_ms: Date.now(),
        last_update_ms: 456,
      }),
      'utf-8',
    )
    const fetchMock = stubSignedFeed(manifestFor('1.2.3', bytes), pair.privateKey, bytes)

    expect(getCliPath()).toBeNull()
    expect(getCurrentVersion()).toBeNull()
    expect(getStatusSnapshot()).toMatchObject({
      source: 'managed',
      available: false,
      currentVersion: null,
    })
    expect(fetchMock).not.toHaveBeenCalled()

    await expect(checkAndUpdate()).resolves.toEqual({ updated: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getCliPath()).toBe(path.resolve(executable))
    expect(getCurrentVersion()).toBe('1.2.3')
    expect(getStatusSnapshot()).toMatchObject({
      source: 'managed',
      available: true,
      currentVersion: '1.2.3',
    })
    const stablePath = getCliPath()
    process.env.AWP_AGENT_RUNTIME_CHANNEL = 'insiders'
    expect(getCliPath()).toBeNull()
    expect(getCurrentVersion()).toBeNull()
    expect(getStatusSnapshot()).toMatchObject({ available: false, source: 'managed' })

    process.env.AWP_AGENT_RUNTIME_CHANNEL = 'stable'
    expect(getCliPath()).toBe(stablePath)
    expect(getCurrentVersion()).toBe('1.2.3')
  })

  it('verifies the detached Ed25519 signature, SHA-256, and atomically activates a staged executable', async () => {
    const bytes = Buffer.from('signed-runtime-v1')
    const pair = configureSigningKey()
    process.env.AWP_AGENT_RUNTIME_MANIFEST_URL =
      'https://updates.example.test/manifest.json'
    const payload = manifestFor('1.2.3', bytes)
    const fetchMock = stubSignedFeed(payload, pair.privateKey, bytes)

    await expect(checkAndUpdate({ force: true })).resolves.toEqual({
      updated: true,
      to: '1.2.3',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(getCurrentVersion()).toBe('1.2.3')

    const executable = getCliPath()
    expect(executable).toBeTruthy()
    expect(readFileSync(executable!)).toEqual(bytes)

    const runtimeDir = getRuntimeDir()
    const meta = JSON.parse(readFileSync(path.join(runtimeDir, 'version.json'), 'utf-8'))
    expect(meta.current_version).toBe('1.2.3')
    expect(meta.current_dir).toMatch(/^1\.2\.3--[a-f0-9]{12}$/)
    expect(
      readdirSync(path.join(runtimeDir, 'versions')).some((name) => name.includes('.partial-')),
    ).toBe(false)
    expect(getStatusSnapshot()).toMatchObject({
      available: true,
      source: 'managed',
      currentVersion: '1.2.3',
    })
  })

  it('retries transient sharing violations without exposing a partial activation', async () => {
    const bytes = Buffer.from('signed-runtime-sharing-retry')
    const pair = configureSigningKey()
    process.env.AWP_AGENT_RUNTIME_MANIFEST_URL =
      'https://updates.example.test/manifest.json'
    stubSignedFeed(manifestFor('1.2.3', bytes), pair.privateKey, bytes)
    let attempts = 0
    setStagedRenameOperationForTests((source, target) => {
      attempts += 1
      if (attempts <= 2) {
        throw Object.assign(new Error('simulated sharing violation'), { code: 'EPERM' })
      }
      renameSync(source, target)
    })

    await expect(checkAndUpdate({ force: true })).resolves.toEqual({
      updated: true,
      to: '1.2.3',
    })
    expect(attempts).toBe(3)
    expect(readFileSync(getCliPath()!)).toEqual(bytes)
    expect(
      readdirSync(path.join(getRuntimeDir(), 'versions')).some((name) => name.includes('.partial-')),
    ).toBe(false)
  })

  it('prunes only adapter-owned versions and staging directories', async () => {
    const bytes = Buffer.from('signed-runtime-prune')
    const pair = configureSigningKey()
    process.env.AWP_AGENT_RUNTIME_MANIFEST_URL =
      'https://updates.example.test/manifest.json'
    stubSignedFeed(manifestFor('1.2.3', bytes), pair.privateKey, bytes)
    await expect(checkAndUpdate({ force: true })).resolves.toMatchObject({ updated: true })

    const versionsDir = path.join(getRuntimeDir(), 'versions')
    const active = JSON.parse(
      readFileSync(path.join(getRuntimeDir(), 'version.json'), 'utf-8'),
    ).current_dir as string
    const staging = `.${active}.partial-${randomUUID()}`
    mkdirSync(path.join(versionsDir, staging))
    writeFileSync(path.join(versionsDir, '.unowned-keep'), 'keep', 'utf-8')

    pruneOldVersions(1)

    expect(existsSync(path.join(versionsDir, active))).toBe(true)
    expect(existsSync(path.join(versionsDir, staging))).toBe(false)
    expect(readFileSync(path.join(versionsDir, '.unowned-keep'), 'utf-8')).toBe('keep')
  })

  it('atomically advances the active pointer while retaining the previous executable', async () => {
    const pair = configureSigningKey()
    process.env.AWP_AGENT_RUNTIME_MANIFEST_URL =
      'https://updates.example.test/manifest.json'
    let bytes = Buffer.from('signed-runtime-v1')
    let payload = manifestFor('1.2.3', bytes)
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === 'https://updates.example.test/manifest.json') {
        return new Response(signedEnvelope(payload, pair.privateKey), { status: 200 })
      }
      if (url === 'https://updates.example.test/runtime.bin') {
        return new Response(bytes as unknown as BodyInit, {
          status: 200,
          headers: { 'content-length': String(bytes.length) },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(checkAndUpdate({ force: true })).resolves.toEqual({
      updated: true,
      to: '1.2.3',
    })
    const previousExecutable = getCliPath()
    expect(previousExecutable).toBeTruthy()
    expect(readFileSync(previousExecutable!)).toEqual(bytes)

    bytes = Buffer.from('signed-runtime-v2')
    payload = manifestFor('1.2.4', bytes)
    await expect(checkAndUpdate({ force: true })).resolves.toEqual({
      updated: true,
      from: '1.2.3',
      to: '1.2.4',
    })

    const activeExecutable = getCliPath()
    expect(activeExecutable).toBeTruthy()
    expect(activeExecutable).not.toBe(previousExecutable)
    expect(readFileSync(activeExecutable!)).toEqual(bytes)
    expect(readFileSync(previousExecutable!)).toEqual(Buffer.from('signed-runtime-v1'))

    const runtimeDir = getRuntimeDir()
    const meta = JSON.parse(readFileSync(path.join(runtimeDir, 'version.json'), 'utf-8'))
    expect(meta).toMatchObject({
      current_version: '1.2.4',
      current_dir: expect.stringMatching(/^1\.2\.4--[a-f0-9]{12}$/),
    })
    expect(
      readdirSync(path.join(runtimeDir, 'versions')).some((name) => name.includes('.partial-')),
    ).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('rejects an oversized manifest before buffering or parsing it', async () => {
    configureSigningKey()
    process.env.AWP_AGENT_RUNTIME_MANIFEST_URL =
      'https://updates.example.test/manifest.json'
    const fetchMock = vi.fn(async () =>
      new Response('x', {
        status: 200,
        headers: { 'content-length': String(256 * 1024 + 1) },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(checkAndUpdate({ force: true })).resolves.toEqual({
      updated: false,
      error: 'runtime_manifest_too_large',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a bad signature before any artifact download', async () => {
    const bytes = Buffer.from('signed-runtime')
    const trusted = configureSigningKey()
    const attacker = generateKeyPairSync('ed25519')
    process.env.AWP_AGENT_RUNTIME_MANIFEST_URL =
      'https://updates.example.test/manifest.json'
    const payload = manifestFor('1.2.3', bytes)
    const fetchMock = stubSignedFeed(payload, attacker.privateKey, bytes)

    const result = await checkAndUpdate({ force: true })
    expect(result).toEqual({
      updated: false,
      error: 'runtime_manifest_signature_invalid',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getCliPath()).toBeNull()
    expect(trusted.publicKey.asymmetricKeyType).toBe('ed25519')
  })

  it('rejects a hash mismatch without activating staging', async () => {
    const signedBytes = Buffer.from('expected-runtime')
    const deliveredBytes = Buffer.alloc(signedBytes.length, 0x78)
    const pair = configureSigningKey()
    process.env.AWP_AGENT_RUNTIME_MANIFEST_URL =
      'https://updates.example.test/manifest.json'
    stubSignedFeed(manifestFor('2.0.0', signedBytes), pair.privateKey, deliveredBytes)

    const result = await checkAndUpdate({ force: true })
    expect(result.error).toBe('runtime_artifact_sha256_mismatch')
    expect(getCurrentVersion()).toBeNull()
    expect(getCliPath()).toBeNull()
  })

  it.each([
    '../outside',
    '1.2.3/../../outside',
    '1.2',
    '01.2.3',
  ])('rejects a malicious or non-canonical version before download: %s', async (version) => {
    const bytes = Buffer.from('runtime')
    const pair = configureSigningKey()
    process.env.AWP_AGENT_RUNTIME_MANIFEST_URL =
      'https://updates.example.test/manifest.json'
    const fetchMock = stubSignedFeed(manifestFor(version, bytes), pair.privateKey, bytes)

    const result = await checkAndUpdate({ force: true })
    expect(result.error).toBe('invalid_runtime_version')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(existsSync(path.resolve(temp, 'outside'))).toBe(false)
  })

  it('rejects a cross-origin artifact unless both origin pin and opt-in are configured', async () => {
    const bytes = Buffer.from('runtime')
    const pair = configureSigningKey()
    process.env.AWP_AGENT_RUNTIME_MANIFEST_URL =
      'https://updates.example.test/manifest.json'
    const fetchMock = stubSignedFeed(
      manifestFor('3.0.0', bytes, 'https://cdn.example.test/runtime.bin'),
      pair.privateKey,
      bytes,
    )

    const result = await checkAndUpdate({ force: true })
    expect(result.error).toBe('runtime_artifact_origin_not_allowed')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects insecure manifest and artifact URLs', async () => {
    configureSigningKey()
    process.env.AWP_AGENT_RUNTIME_MANIFEST_URL =
      'http://127.0.0.1:9999/manifest.json'
    await expect(checkAndUpdate({ force: true })).resolves.toEqual({
      updated: false,
      error: 'runtime_manifest_requires_https',
    })

    const bytes = Buffer.from('runtime')
    const pair = configureSigningKey()
    process.env.AWP_AGENT_RUNTIME_MANIFEST_URL =
      'https://updates.example.test/manifest.json'
    const fetchMock = stubSignedFeed(
      manifestFor('3.1.0', bytes, 'http://updates.example.test/runtime.bin'),
      pair.privateKey,
      bytes,
    )
    const result = await checkAndUpdate({ force: true })
    expect(result.error).toBe('runtime_artifact_requires_https')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects archive kinds and path-bearing artifact fields before download', async () => {
    const bytes = Buffer.from('runtime')
    const pair = configureSigningKey()
    process.env.AWP_AGENT_RUNTIME_MANIFEST_URL =
      'https://updates.example.test/manifest.json'

    const archivePayload = manifestFor('4.0.0', bytes)
    const key = `${process.platform}-${process.arch}`
    ;(archivePayload.artifacts as Record<string, Record<string, unknown>>)[key].kind = 'tar'
    let fetchMock = stubSignedFeed(archivePayload, pair.privateKey, bytes)
    let result = await checkAndUpdate({ force: true })
    expect(result.error).toBe('unsupported_artifact_kind')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const pathPayload = manifestFor('4.0.1', bytes)
    ;(pathPayload.artifacts as Record<string, Record<string, unknown>>)[key].entrypoint =
      '../../outside'
    fetchMock = stubSignedFeed(pathPayload, pair.privateKey, bytes)
    result = await checkAndUpdate({ force: true })
    expect(result.error).toBe('unexpected_artifact_field')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not trust a path-traversing metadata pointer or delete outside the runtime root', async () => {
    const outside = path.join(temp, 'outside-keep.txt')
    writeFileSync(outside, 'keep', 'utf-8')
    const runtimeDir = getRuntimeDir()
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(
      path.join(runtimeDir, 'version.json'),
      JSON.stringify({
        current_version: '1.2.3',
        current_dir: '../outside',
        last_check_ms: 0,
        last_update_ms: 0,
      }),
      'utf-8',
    )

    expect(getCliPath()).toBeNull()
    expect(readFileSync(outside, 'utf-8')).toBe('keep')
  })

  it('fetchLatestVersion fails closed when the pinned key is absent', async () => {
    process.env.AWP_AGENT_RUNTIME_MANIFEST_URL =
      'https://updates.example.test/manifest.json'
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ signed: 'e30=', signature: 'eA==' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchLatestVersion('stable')).rejects.toThrow(
      'runtime_public_key_unconfigured',
    )
    expect(fetchMock).not.toHaveBeenCalled()
    expect(getStatusSnapshot()).toMatchObject({
      currentVersion: null,
      available: false,
      source: 'disabled',
    })
  })
})
